// Discord inbound watcher for Dori. On start it catches up on messages missed while it was off, then streams live ones.
// Prints one `INBOUND <json>` line per turn; run it as a persistent monitor with filter `^INBOUND`.
//
// Env:
//   DORI_DISCORD_TOKEN     bot token (the same one `dori send discord` uses)
//   DORI_DISCORD_OWNER_ID  your Discord user ID
//   DORI_DISCORD_TRUSTED_IDS  comma-separated IDs allowed to request verified fixes
//   DORI_DISCORD_TRUSTED_CHANNELS  comma-separated allowed channel IDs with protected human pings
//   DORI_DISCORD_NORMAL_CHANNELS  optional explicit normal channel IDs (all other allowed channels default normal)
//   DORI_DISCORD_REPORT_CHANNELS  channel/category IDs where staff can request GitHub issues
//   DORI_DISCORD_ALLOWED   comma-separated channel or category IDs Dori listens in
//   DORI_DISCORD_BUG_REPORT_SOURCE  optional bot-id:channel-id evidence-only source
//   DORI_DISCORD_SCOPE_CATEGORY  optional category; server messages outside it are ignored unread
//   DORI_STATE_DIR         where the last message seen per channel is kept

import { DiscordBotClient, DiscordBotListener, DiscordIntent } from "agent-messenger/discordbot";
import { fetchBacklog, PAGE_SIZE, type Caps, type FetchPage, type RestMessage } from "./catchup.ts";
import { classify, insideAllowed, insideCategory, type FilterConfig, type IncomingMessage } from "./filter.ts";
import { LastSeen } from "./lastseen.ts";
import { Delivery, REQUEST_MAX_AGE_MS, requestTimestamp } from "./delivery.ts";
import { authorizationMetadata, filterConfig, reauthorize, validateChannelPolicy } from "./authorization.ts";
import { sweepExpired, sweepOrphanAttachments } from "./expiry.ts";
import { watchedChannels } from "./watched-channels.ts";
import { prepareMessageBody } from "./forwarded.ts";
import { describeMessage, replyContext, type ReplyMessage } from "./reply-context.ts";
import { recordAnswer } from "./question-answer.ts";
import { DiscordRestError, discordRest } from "./rest.ts";
import { TurnAssembler, type TurnMessage } from "./turns.ts";
import { Preceding } from "./preceding.ts";
import { Conversations, conversationTimeoutReporter } from "./conversations.ts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`INBOUND_ERROR missing env ${name}`);
    process.exit(2);
  }
  return value;
}

const token = requireEnv("DORI_DISCORD_TOKEN");
const conversations = new Conversations(`${requireEnv("DORI_STATE_DIR")}/discord-conversations.sqlite`);
const reportConversationTimeouts = conversationTimeoutReporter(conversations, (line) => console.log(line));
let cfg: FilterConfig;
try {
  cfg = filterConfig(process.env, (channel, user) => conversations.isOpen(channel, user));
  await validateChannelPolicy(cfg, discordRest(token), (message) => console.log(`INBOUND_WARN ${message}`));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`INBOUND_ERROR ${error.message}`);
  process.exit(2);
}
const statePath = `${requireEnv("DORI_STATE_DIR")}/discord-inbound.json`;
const lastSeen = await LastSeen.load(statePath).catch((err: unknown) => {
  console.error(`INBOUND_ERROR cannot read ${statePath}: ${String(err)}`);
  process.exit(2);
});

const CAPS: Caps = { maxAgeMs: 3 * 24 * 60 * 60 * 1000, maxPerChannel: 100 };
const rest = discordRest(token);
// Messages inbound already received (catch-up pages, live events) answer most reply lookups without a request.
const seenMessages = new Map<string, ReplyMessage>();
function seen(message: ReplyMessage | null | undefined): void {
  if (!message?.id || !message.channel_id) return;
  seenMessages.delete(message.id);
  seenMessages.set(message.id, message);
  if (seenMessages.size > 2000) seenMessages.delete(seenMessages.keys().next().value as string);
}
// Read only reply ancestors in the same channel as an already-authorized message.
const fetchReply = async (channel: string, id: string, signal: AbortSignal): Promise<ReplyMessage> => {
  const known = seenMessages.get(id);
  if (known?.channel_id === channel) return known;
  const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages/${id}`, {
    headers: { Authorization: `Bot ${token}` }, signal,
  });
  if (!response.ok) throw new Error(`reply fetch failed (${response.status})`);
  return await response.json() as ReplyMessage;
};
const stateDir = requireEnv("DORI_STATE_DIR");
const delivery = new Delivery(`${stateDir}/discord-delivery.sqlite`);
const preceding = new Preceding(() => Date.now());
const turns = new TurnAssembler((turn) => console.log(`INBOUND ${JSON.stringify(turn)}`), {
  preceding: (first) => preceding.take(first),
  // Timer emissions share the delivery queue so they cannot overtake preparation.
  clock: {
    now: () => Date.now(),
    setTimeout: (callback, delay) => Number(setTimeout(() => enqueue("turn flush", async () => callback()), delay)),
    clearTimeout: (timer) => clearTimeout(timer),
  },
});
const backlogMessages: TurnMessage[] = [];

const recoveryPages = new Map<string, readonly RestMessage[]>();
const fetchPage: FetchPage = async (channelId, before) => {
  const page = await rest<RestMessage[]>(`/channels/${channelId}/messages?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`);
  recoveryPages.set(channelId, page);
  for (const message of page) seen(message as ReplyMessage);
  return page;
};

const warn = (text: string) => console.log(`INBOUND_WARN ${text}`);

const client = await new DiscordBotClient().login({ token });

type ChannelInfo = { readonly type?: number; readonly parent_id?: string };
const channels = new Map<string, ChannelInfo | undefined>();
// Missing Access / Unknown Channel: Discord will never show this channel to Helio.
const UNREADABLE_CHANNEL = new Set(["50001", "10003"]);
async function channelInfo(channelId: string): Promise<ChannelInfo | undefined> {
  if (channels.has(channelId)) return channels.get(channelId);
  let info: ChannelInfo | undefined;
  try {
    const channel = await client.getChannel(channelId);
    info = { type: channel.type, parent_id: channel.parent_id ?? undefined };
  }
  catch (error) {
    // An unreadable ancestor (a hidden category) ends the walk, so it can only fail membership checks.
    if (!(error instanceof Error) || !UNREADABLE_CHANNEL.has(String((error as { code?: unknown }).code))) throw error;
  }
  channels.set(channelId, info);
  return info;
}
const parentOf = async (channelId: string) => (await channelInfo(channelId))?.parent_id;

const tracked = new Set<string>();
const delivered = new Set<string>();
const recoveryNeeded = new Set<string>();
const recoverySeen = new Set<string>();

class MessageAuthorizationError extends Error {
  constructor(channel: string, id: string, cause: Error) {
    super(`Message authorization failed channel=${channel} message_id=${id}: ${cause.message}`, { cause });
    this.name = "MessageAuthorizationError";
  }
}

// Normal chats: only the message the pinging person replied to, already in the event (no lookup, no deeper chain).
function repliedTo(msg: IncomingMessage) {
  const parent = msg.referenced_message as ReplyMessage | null | undefined;
  if (msg.message_reference?.type === 1 || !parent || parent.channel_id !== msg.channel_id ||
      typeof parent.content !== "string" || !/^[0-9]+$/.test(parent.author?.id ?? "")) return undefined;
  return { status: "parent_only", messages: [describeMessage(parent, 24_000).entry] };
}

async function conversationContext(msg: IncomingMessage) {
  const conversation = conversations.get(msg.channel_id, msg.author.id);
  if (!conversation) return undefined;
  const previous = conversations.transcript(msg.channel_id, msg.author.id)
    .filter((entry) => BigInt(entry.message_id) < BigInt(msg.id));
  const transcript = [];
  let chars = 2;
  for (const entry of [...previous].reverse()) {
    const size = JSON.stringify(entry).length + (transcript.length ? 1 : 0);
    if (transcript.length === 30 || chars + size > 12000) break;
    transcript.unshift(entry);
    chars += size;
  }
  let history = [...seenMessages.values()].filter((entry) =>
    entry.channel_id === msg.channel_id && BigInt(entry.id) < BigInt(msg.id));
  if (history.length < 3) {
    const page = await rest<ReplyMessage[]>(`/channels/${msg.channel_id}/messages?before=${msg.id}&limit=10`);
    const combined = new Map(history.map((entry) => [entry.id, entry]));
    for (const entry of page) {
      if (entry.channel_id === msg.channel_id && BigInt(entry.id) < BigInt(msg.id)) combined.set(entry.id, entry);
    }
    history = [...combined.values()];
  }
  const transcriptIds = new Set(previous.map((entry) => entry.message_id));
  const recent = history.filter((entry) => !transcriptIds.has(entry.id))
    .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)
    .filter((entry, index) => index < 3 || Date.parse(msg.timestamp) - Date.parse(entry.timestamp ?? "") <= 15 * 60 * 1000)
    .slice(0, 10).reverse().map((entry) => describeMessage(entry, 12000).entry);
  return {
    topic: conversation.topic, opened_at: new Date(conversation.opened_at).toISOString(),
    anchor_message_id: conversation.anchor_message_id, transcript, recent,
  };
}

function recordHelioReply(msg: IncomingMessage): void {
  const reference = msg.message_reference;
  if (!reference?.message_id || reference.type === 1 ||
      (reference.channel_id && reference.channel_id !== msg.channel_id)) return;
  const author = msg.referenced_message?.author.id ?? seenMessages.get(reference.message_id)?.author.id;
  for (const conversation of conversations.list().filter((row) => row.channel_id === msg.channel_id)) {
    if (conversation.user_id === author || conversation.anchor_message_id === reference.message_id ||
        conversations.transcript(msg.channel_id, conversation.user_id).some((entry) => entry.message_id === reference.message_id)) {
      conversations.append(msg.channel_id, conversation.user_id, describeMessage(msg, 10000).entry);
    }
  }
}

async function deliver(msg: IncomingMessage, backlog: boolean): Promise<boolean> {
  if (delivered.has(msg.id)) return false;
  if (!backlog) turns.sent(msg.channel_id, msg.author.id);
  let inbound: Awaited<ReturnType<typeof classify>>;
  try {
    // Server messages outside the configured category are not Helio's business: no lookup above it, no warning.
    if (msg.guild_id !== undefined && cfg.scopeCategory && !(await insideCategory(msg.channel_id, cfg.scopeCategory, channelInfo))) {
      inbound = null;
    } else if (msg.guild_id !== undefined && cfg.ignoredChannels?.size && await insideAllowed(msg.channel_id, cfg.ignoredChannels, parentOf)) {
      inbound = null;
    } else if (msg.guild_id !== undefined && cfg.blockedChannels?.size &&
        await insideAllowed(msg.channel_id, cfg.blockedChannels, parentOf)) {
      warn(`channel policy blocked channel=${msg.channel_id} message_id=${msg.id}; cursor retained`);
      return false;
    } else {
      if (msg.author.id === cfg.botId) {
        if (!msg.webhook_id && await insideAllowed(msg.channel_id, cfg.allowed, parentOf)) recordHelioReply(msg);
        delivered.add(msg.id);
        if (tracked.has(msg.channel_id)) await lastSeen.advance(msg.channel_id, msg.id);
        return false;
      }
      inbound = await classify(msg, cfg, parentOf, () => preceding.remember(msg));
    }
  }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    // Do not let catchUp's per-channel REST handling advance beyond an unresolved message.
    throw new MessageAuthorizationError(msg.channel_id, msg.id, error);
  }
  let emitted = false;
  const prior = recoveryNeeded.has(msg.id) ? delivery.pending("inbound").find((item) => item.id === msg.id) : undefined;
  const recovering = prior !== undefined && delivery.status("inbound", msg.id).disposition === "pending";
  if (prior && !recovering) warn(`pending recovery skipped message_id=${msg.id}; accepted work retained`);
  if (prior && !inbound) warn(`pending recovery withheld by current authorization message_id=${msg.id}; retained pending`);
  if (inbound) {
    if (!delivery.contains("inbound", msg.id) || recovering) {
      const staged = { ...inbound, backlog, discord_origin: authorizationMetadata(msg) };
      const sentAt = requestTimestamp(inbound.sent_at);
      if (sentAt === undefined) {
        const payload = JSON.stringify({ ...staged, attachments: [] });
        if (prior) delivery.recover(msg.id, prior.payload, payload);
        else delivery.stage("inbound", msg.id, payload);
        warn(`pending side effects withheld message_id=${msg.id}; invalid or missing sent_at; retained pending`);
        return false;
      }
      if (sentAt !== undefined && Date.now() - sentAt > REQUEST_MAX_AGE_MS) {
        // Persist an expiry receipt without downloading files or storing raw attachment URLs.
        const expiredPayload = JSON.stringify({ ...staged, attachments: [] });
        if (prior ? !delivery.recover(msg.id, prior.payload, expiredPayload) :
          !delivery.stage("inbound", msg.id, expiredPayload)) return false;
        await sweepExpired(delivery, stateDir, warn);
        delivered.add(msg.id);
        await lastSeen.advance(msg.channel_id, msg.id);
        return false;
      }
      const body = await prepareMessageBody(msg, `${stateDir}/attachments/inbound`, inbound.role === "BOT_BUG_REPORT");
      const reply_context = inbound.channel_policy === "trusted" ? await replyContext(msg, fetchReply) : repliedTo(msg);
      const conversation = await conversationContext(msg);
      const record = {
        ...staged, ...body, preparation_complete: true,
        ...(reply_context ? { reply_context } : {}), ...(conversation ? { conversation } : {}),
      };
      if (prior ? !delivery.recover(msg.id, prior.payload, JSON.stringify(record)) :
        !delivery.stage("inbound", msg.id, JSON.stringify(record))) return false;
      if (conversation) {
        conversations.append(msg.channel_id, msg.author.id, describeMessage(msg, 10000).entry);
        conversations.touch(msg.channel_id, msg.author.id, Date.now());
      }
      await sweepExpired(delivery, stateDir, warn);
      if (delivery.status("inbound", msg.id).disposition === "expired") {
        delivered.add(msg.id);
        await lastSeen.advance(msg.channel_id, msg.id);
        return false;
      }
      try { delivery.check(msg.id); }
      catch (error) {
        if (!(error instanceof RangeError)) throw error;
        warn(`pending side effects withheld message_id=${msg.id}: ${error.message}`);
        await sweepExpired(delivery, stateDir, warn);
        return false;
      }
      let question_id: string | undefined;
      try { question_id = recordAnswer(stateDir, cfg.ownerId, record); }
      catch { warn("question answer could not be recorded; leave it pending and reconcile"); }
      const message = { ...record, ...(question_id ? { question_id } : {}) };
      const payload = JSON.stringify(message);
      if (delivery.refresh(msg.id, JSON.stringify(record), payload)) {
        if (backlog) backlogMessages.push(message);
        else turns.push(message);
        emitted = true;
      }
    }
    tracked.add(msg.channel_id);
  }
  if (tracked.has(msg.channel_id)) await lastSeen.advance(msg.channel_id, msg.id);
  delivered.add(msg.id);
  return emitted;
}

async function catchUp(): Promise<number> {
  let count = 0;
  for (const channel of await watchedChannels(cfg, rest, warn)) {
    tracked.add(channel.id);
    try {
      const after = lastSeen.get(channel.id);
      const { messages, truncated } = await fetchBacklog(fetchPage, channel.id, after, Date.now(), CAPS);
      if (truncated) console.log(`INBOUND_BACKLOG_TRUNCATED channel=${channel.id} kept=${messages.length}`);
      const fresh = new Set(messages.map((msg) => msg.id));
      const candidates = [...(recoveryPages.get(channel.id) ?? [])].reverse()
        .filter((msg) => fresh.has(msg.id) || recoveryNeeded.has(msg.id));
      for (const msg of candidates) {
        if (recoveryNeeded.has(msg.id)) recoverySeen.add(msg.id);
        if (await deliver({ ...msg, guild_id: channel.guildId }, true)) count++;
      }
    } catch (err) {
      if (!(err instanceof DiscordRestError)) throw err;
      warn(`catch-up failed for channel ${channel.id}: ${String(err)}`);
    }
  }
  for (const id of recoveryNeeded) {
    if (!recoverySeen.has(id)) warn(`pending recovery unavailable message_id=${id}; outside authorized newest-100 page or inaccessible; retained pending`);
  }
  await lastSeen.save();
  turns.replay(backlogMessages);
  backlogMessages.length = 0;
  return count;
}

let queue: Promise<void> = Promise.resolve();
function enqueue(label: string, job: () => Promise<unknown>): void {
  queue = queue.then(job).then(
    () => undefined,
    (err: unknown) => {
      console.error(`INBOUND_ERROR ${label}: ${String(err)}`);
      process.exit(1);
    },
  );
}

let backlogCount = 0;
const connected = Promise.withResolvers<void>();
enqueue("catch-up", async () => {
  await connected.promise;
  await sweepExpired(delivery, stateDir, warn);
  await sweepOrphanAttachments(delivery, stateDir, "inbound");
  const replayMessages: TurnMessage[] = [];
  for (const item of delivery.pending("inbound")) {
    let current: Awaited<ReturnType<typeof reauthorize>>;
    try { current = await reauthorize(item.payload, cfg, rest); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      warn(`pending authorization unavailable message_id=${item.id}; retained pending: ${error.message}`);
      recoveryNeeded.add(item.id);
      continue;
    }
    if (!current) {
      warn(`pending authorization revoked message_id=${item.id}; retained pending`);
      recoveryNeeded.add(item.id);
      continue;
    }
    await sweepExpired(delivery, stateDir, warn);
    try { delivery.check(item.id); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      warn(`pending side effects withheld message_id=${item.id}: ${error.message}`);
      recoveryNeeded.add(item.id);
      continue;
    }
    let question_id: string | undefined;
    try { question_id = recordAnswer(stateDir, cfg.ownerId, current); }
    catch { warn("pending question answer could not be reconciled"); }
    const message = { ...current, ...(question_id ? { question_id } : {}) };
    if (!delivery.refresh(item.id, item.payload, JSON.stringify(message))) continue;
    replayMessages.push(message);
    delivered.add(item.id);
    backlogCount++;
  }
  turns.replay(replayMessages);
  backlogCount += await catchUp();
  reportConversationTimeouts();
  setInterval(() => enqueue("conversation timeouts", async () => reportConversationTimeouts()), 10 * 60 * 1000).unref();
});

const listener = new DiscordBotListener(client, {
  intents:
    DiscordIntent.Guilds | DiscordIntent.GuildMessages | DiscordIntent.MessageContent | DiscordIntent.DirectMessages |
    DiscordIntent.GuildMessageTyping | DiscordIntent.DirectMessageTyping,
});

listener.on("connected", ({ user }) => { cfg.botId = user.id; });
listener.on("channel_update", () => channels.clear());
listener.on("channel_delete", () => channels.clear());
listener.on("message_create", (event) => {
  // Ignored channels are not read, cached or processed at all.
  if (cfg.ignoredChannels?.has(event.channel_id)) return;
  seen(event as unknown as ReplyMessage);
  seen((event as { referenced_message?: ReplyMessage | null }).referenced_message);
  enqueue(`message ${event.id} in ${event.channel_id}`, () => deliver(event, false));
});
listener.on("typing_start", (event) => {
  if (event.user_id === cfg.botId) return;
  enqueue(`typing in ${event.channel_id}`, async () => turns.typing(event.channel_id, event.user_id));
});

const DISALLOWED_INTENTS = "4014";

function fail(err: unknown): never {
  const text = String(err);
  const hint = text.includes(DISALLOWED_INTENTS) ? " (turn on Message Content Intent in the Developer Portal)" : "";
  console.error(`INBOUND_ERROR gateway: ${text}${hint}`);
  process.exit(1);
}

listener.on("error", fail);

await listener.start().catch(fail);
if (!cfg.botId || !/^\d+$/.test(cfg.botId)) {
  fail(new Error("bot identity unavailable; no channel cursors advanced"));
}
connected.resolve();
enqueue("ready", async () => {
  console.log(`INBOUND_READY allowed=${[...cfg.allowed].join(",")} backlog=${backlogCount}`);
});
