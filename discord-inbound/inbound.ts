// Discord inbound watcher for Dori. On start it catches up on messages missed while it was off, then streams live ones.
// Prints one `INBOUND <json>` line per turn; run it as a persistent monitor with filter `^INBOUND`.
// allow: SIZE_OK - startup recovery and live gateway events share one serialized delivery queue and its ordering state.
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
import { fetchBacklog, PAGE_SIZE, skippedThrough, type Caps, type FetchPage, type RestMessage } from "./intake/catchup.ts";
import { classify, insideAllowed, insideCategory, type FilterConfig, type IncomingMessage } from "./intake/filter.ts";
import { LastSeen } from "./intake/lastseen.ts";
import { Delivery, REQUEST_MAX_AGE_MS, requestTimestamp } from "./delivery/delivery.ts";
import { authorizationMetadata, filterConfig, reauthorize, validateChannelPolicy } from "./intake/authorization.ts";
import { sweepExpired, sweepOrphanAttachments } from "./delivery/expiry.ts";
import { watchedChannels } from "./intake/watched-channels.ts";
import { prepareMessageBody } from "./messages/forwarded.ts";
import { checkImageSandbox } from "./messages/image-worker.ts";
import { awaitsPreview, Previews, type PreviewEmbed } from "./messages/linked-files.ts";
import { describeMessage, replyContext, type ReplyMessage } from "./messages/reply-context.ts";
import { recordAnswer } from "./conversations/question-answer.ts";
import { DiscordRestError, discordRest } from "./discord/rest.ts";
import { TurnAssembler, type TurnMessage } from "./intake/turns.ts";
import { Preceding } from "./intake/preceding.ts";
import { Conversations } from "./conversations/conversations.ts";
import { conversationEntry, conversationSnapshot } from "./conversations/conversation-context.ts";
import { sweepConversations } from "./conversations/conversation-upkeep.ts";
import { reactOnArrival, sweepWorking } from "./conversations/working.ts";
import { inboundSummary, monitorLine } from "./delivery/monitor-summary.ts";
import { pendingReminder } from "./delivery/pending-reminder.ts";
import { PromptStore, QuestionStore } from "./interactive/store.ts";
import { closeExpired, discordCall, expireNow, handleInteraction, handlePlanReply, sweep, type Deps } from "./interactive/handler.ts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`INBOUND_ERROR missing env ${name}`);
    process.exit(2);
  }
  return value;
}

const token = requireEnv("DORI_DISCORD_TOKEN");
// The watcher answers button clicks on this same event loop: no synchronous lock wait may approach Discord's 3 s limit.
// Longer contention fails the watcher, which restarts and catches up from its saved cursor.
const LOCK_WAIT_MS = 1000;
const conversations = new Conversations(`${requireEnv("DORI_STATE_DIR")}/discord-conversations.sqlite`, Date.now(), LOCK_WAIT_MS);
for (const row of conversations.resolveLegacy(Date.now())) {
  console.log(monitorLine(`INBOUND_CONVERSATION_MIGRATED ${JSON.stringify({
    channel_id: row.channel_id, user_id: row.user_id, opened_at: row.opened_at, topic: row.topic, outcome: "other",
    read: `helio conversation reopen ${row.channel_id} ${row.user_id}`,
  })}`));
}
// When the owner last posted in each channel, from live events and catch-up pages: owner mentions are
// left to the owner while they are active there.
const ownerPosts = new Map<string, number>();
const ownerId = requireEnv("DORI_DISCORD_OWNER_ID");
function noteOwnerPost(message: { readonly channel_id?: string; readonly author?: { readonly id?: string }; readonly timestamp?: string }) {
  const at = Date.parse(message.timestamp ?? "");
  if (message.author?.id !== ownerId || !message.channel_id || !Number.isFinite(at)) return;
  if (at > (ownerPosts.get(message.channel_id) ?? 0)) ownerPosts.set(message.channel_id, at);
}
let cfg: FilterConfig;
try {
  cfg = filterConfig(process.env, (channel, user) => conversations.isOpen(channel, user),
    (channel, user, id) => conversations.workingAnchor(channel, user, id), (channel) => ownerPosts.get(channel));
  await validateChannelPolicy(cfg, discordRest(token), (message) => console.log(monitorLine(`INBOUND_WARN ${message}`)));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(monitorLine(`INBOUND_ERROR ${error.message}`));
  process.exit(2);
}
const statePath = `${requireEnv("DORI_STATE_DIR")}/discord-inbound.json`;
const lastSeen = await LastSeen.load(statePath).catch((err: unknown) => {
  console.error(monitorLine(`INBOUND_ERROR cannot read ${statePath}: ${String(err)}`));
  process.exit(2);
});

const CAPS: Caps = { maxAgeMs: 3 * 24 * 60 * 60 * 1000, maxPerChannel: 100 };
const rest = discordRest(token);
// Messages inbound already received (catch-up pages, live events) answer most reply lookups without a request.
const seenMessages = new Map<string, ReplyMessage>();
function seen(message: ReplyMessage | null | undefined): void {
  if (!message?.id || !message.channel_id) return;
  noteOwnerPost(message);
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
const delivery = new Delivery(`${stateDir}/discord-delivery.sqlite`, LOCK_WAIT_MS);
// Typed answers wait at most 250 ms per attempt: a longer synchronous wait would stall button clicks too.
const busyDatabase = (error: unknown) => error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_BUSY");
function answerFor(answer: Parameters<typeof recordAnswer>[2]): string | undefined {
  try { handlePlanReply(answer, clickDeps); return recordAnswer(stateDir, cfg.ownerId, answer, 250); }
  catch (error) {
    if (!busyDatabase(error)) { warn(`question answer could not be recorded: ${String(error)}`); return undefined; }
    void (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await Bun.sleep(250);
        try { handlePlanReply(answer, clickDeps); recordAnswer(stateDir, cfg.ownerId, answer, 250); return; }
        catch (retry) { if (!busyDatabase(retry)) { warn(`question answer could not be recorded: ${String(retry)}`); return; } }
      }
      warn("question database stayed locked; run helio question reconcile");
    })();
    return undefined;
  }
}
for (const item of delivery.pending("inbound")) delivery.recovery.flag(item.id, item.payload);
const preceding = new Preceding(() => Date.now());
const turns = new TurnAssembler((turn) => {
  if (turn.turn.preceding?.length) {
    const first = delivery.pending("inbound").find((item) => item.id === turn.turn.id);
    if (first) delivery.refresh(first.id, first.payload,
      JSON.stringify({ ...JSON.parse(first.payload), preceding: turn.turn.preceding }));
  }
  console.log(inboundSummary(turn));
}, {
  preceding: (first) => preceding.take(first),
  // Timer emissions share the delivery queue so they cannot overtake preparation.
  clock: {
    now: () => Date.now(),
    setTimeout: (callback, delay) => Number(setTimeout(() => enqueue("turn flush", async () => callback()), delay)),
    clearTimeout: (timer) => clearTimeout(timer),
  },
});
const backlogMessages: TurnMessage[] = [];
// This safety net must run independently of the slower reaction/conversation upkeep.
setInterval(() => {
  const line = pendingReminder(delivery, conversations, Date.now());
  if (line) console.log(line);
}, 5 * 60 * 1000).unref();

const recoveryPages = new Map<string, readonly RestMessage[]>();
const fetchPage: FetchPage = async (channelId, before) => {
  const page = await rest<RestMessage[]>(`/channels/${channelId}/messages?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`);
  recoveryPages.set(channelId, page);
  for (const message of page) seen(message as ReplyMessage);
  return page;
};

const warn = (text: string) => console.log(monitorLine(`INBOUND_WARN ${text}`));
const sandboxProblem = await checkImageSandbox();
if (sandboxProblem) warn(`image sandbox check failed (${sandboxProblem}); images stay blocked until bubblewrap and prlimit work`);
const previews = new Previews({ setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (timer) => clearTimeout(timer as Timer) });

// Trusted chats: a live link usually gets its preview in a MESSAGE_UPDATE just after creation.
async function withPreviews(msg: IncomingMessage): Promise<IncomingMessage> {
  const embeds = await previews.wait(msg.id, async () =>
    (await rest<{ embeds?: PreviewEmbed[] }>(`/channels/${msg.channel_id}/messages/${msg.id}`)).embeds,
  ).catch((error: unknown) => {
    // The preview only adds files; failing to read it must not stop intake.
    if (!(error instanceof Error)) throw error;
    warn(`link preview unavailable message_id=${msg.id}: ${error.message}`);
    return undefined;
  });
  return embeds?.length ? { ...msg, embeds } : msg;
}

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
  const conversation = conversationSnapshot(conversations, msg.channel_id, msg.author.id, Date.now());
  if (!conversation) return undefined;
  const previous = conversation.transcript
    .filter((entry) => BigInt(entry.message_id) < BigInt(msg.id));
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
  const last = previous.at(-1);
  const recent = history.filter((entry) => !last || BigInt(entry.id) > BigInt(last.message_id))
    .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)
    .slice(0, 5).reverse().map((entry) => describeMessage(entry, 400).entry);
  return {
    ...conversation, transcript: previous.slice(-6), earlier_entries: Math.max(0, previous.length - 6), recent,
  };
}

function recordHelioReply(msg: IncomingMessage): void {
  if (conversations.isNotice(msg.id)) return;
  const reference = msg.message_reference;
  if (!reference?.message_id || reference.type === 1 ||
      (reference.channel_id && reference.channel_id !== msg.channel_id)) return;
  for (const conversation of conversations.list().filter((row) => row.channel_id === msg.channel_id)) {
    if (conversation.anchor_message_id === reference.message_id ||
        conversations.transcript(msg.channel_id, conversation.user_id).some((entry) => entry.message_id === reference.message_id)) {
      conversations.append(msg.channel_id, conversation.user_id, describeMessage(msg, 10000).entry, Date.parse(msg.timestamp));
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
      const staged = { ...inbound, backlog, ...(backlog ? { recovered: true } : {}), discord_origin: authorizationMetadata(msg) };
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
      const source = inbound.channel_policy === "trusted" && !backlog && awaitsPreview(msg.content, msg.embeds) ?
        await withPreviews(msg) : msg;
      const body = await prepareMessageBody(source, `${stateDir}/attachments/inbound`, inbound.role === "BOT_BUG_REPORT",
        inbound.channel_policy);
      const reply_context = inbound.channel_policy === "trusted" ? await replyContext(msg, fetchReply) : repliedTo(msg);
      const conversation = await conversationContext(msg);
      const record = {
        ...staged, ...body, preparation_complete: true,
        ...(reply_context ? { reply_context } : {}), ...(conversation ? { conversation } : {}),
      };
      if (prior ? !delivery.recover(msg.id, prior.payload, JSON.stringify(record)) :
        !delivery.stage("inbound", msg.id, JSON.stringify(record))) return false;
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
      const question_id = answerFor(record);
      const message = { ...record, ...(question_id ? { question_id } : {}) };
      const payload = JSON.stringify(message);
      if (backlog) delivery.recovery.flag(msg.id, payload);
      if (delivery.refresh(msg.id, JSON.stringify(record), payload)) {
        if (message.pinged && message.role !== "BOT_BUG_REPORT") {
          conversations.openWorking(msg.channel_id, msg.author.id, msg.id, Date.now());
        }
        await reactOnArrival({ store: conversations, rest, now: Date.now(), warn },
          { ...message, entry: describeMessage(msg, 10_000).entry });
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
      const backlog = await fetchBacklog(fetchPage, channel.id, after, Date.now(), CAPS);
      const { messages, truncated } = backlog;
      if (truncated) console.log(`INBOUND_BACKLOG_TRUNCATED channel=${channel.id} kept=${messages.length}`);
      const skipped = await skippedThrough(fetchPage, channel.id, backlog);
      if (skipped) await lastSeen.advance(channel.id, skipped);
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
      console.error(monitorLine(`INBOUND_ERROR ${label}: ${String(err)}`));
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
    const question_id = answerFor(current);
    const message = { ...current, backlog: true, recovered: true, ...(question_id ? { question_id } : {}) };
    if (!delivery.refresh(item.id, item.payload, JSON.stringify(message))) continue;
    if (message.pinged && message.role !== "BOT_BUG_REPORT") {
      conversations.openWorking(message.channel_id, message.author_id, message.message_id, Date.now());
    }
    await reactOnArrival({ store: conversations, rest, now: Date.now(), warn }, {
      ...message, entry: conversationEntry(message),
    });
    replayMessages.push(message);
    delivered.add(item.id);
    backlogCount++;
  }
  turns.replay(replayMessages);
  backlogCount += await catchUp();
  const upkeep = async () => {
    await sweepConversations({
      store: conversations, rest, now: Date.now(), emit: (line) => console.log(line),
      canContact: async (row, guild) => {
        if (!guild) return row.user_id === cfg.ownerId || cfg.trustedIds?.has(row.user_id) === true;
        if (cfg.scopeCategory && !await insideCategory(row.channel_id, cfg.scopeCategory, channelInfo)) return false;
        if (await insideAllowed(row.channel_id, cfg.ignoredChannels ?? new Set(), parentOf) ||
            await insideAllowed(row.channel_id, cfg.blockedChannels ?? new Set(), parentOf)) return false;
        return insideAllowed(row.channel_id, cfg.allowed, parentOf);
      },
    });
    await sweepWorking({ store: conversations, delivery, rest, now: Date.now(), warn });
  };
  await upkeep();
  setInterval(() => enqueue("conversation and 👀 upkeep", upkeep), 10 * 60 * 1000).unref();
});

const listener = new DiscordBotListener(client, {
  intents:
    DiscordIntent.Guilds | DiscordIntent.GuildMessages | DiscordIntent.MessageContent | DiscordIntent.DirectMessages |
    DiscordIntent.GuildMessageTyping | DiscordIntent.DirectMessageTyping,
});

// Clicks bypass the delivery queue: Discord needs an answer within three seconds.
const prompts = new PromptStore(`${stateDir}/discord-prompts.sqlite`, 300);
const clickDeps: Deps = {
  prompts, questions: () => QuestionStore.open(`${stateDir}/discord-questions.sqlite`, 300),
  ownerId: cfg.ownerId, trusted: () => cfg.trustedIds ?? new Set<string>(), call: discordCall(token),
  now: () => Date.now(), emit: (line) => console.log(line), warn,
};
const upkeepDeps: Deps = { ...clickDeps, call: discordCall(token, 10_000) };
listener.on("interaction_create", (event) => { void handleInteraction(event, clickDeps); });
let sweeping = false;
let wake: Timer | undefined;
// An exact timer for the next expiry or lapse; the 15-second sweep also finds prompts posted by other processes.
const arm = () => {
  clearTimeout(wake);
  const at = prompts.nextDeadline();
  if (at !== undefined) wake = setTimeout(onDeadline, Math.min(Math.max(at - Date.now(), 0) + 50, 2 ** 31 - 1)).unref();
};
// Runs even while a sweep waits on Discord, so a prompt never stays open past its deadline.
function onDeadline(): void {
  try { expireNow(upkeepDeps); }
  catch (error) { warn(`prompt expiry failed: ${String(error)}`); }
  arm();
  closeExpired(upkeepDeps).catch((error: unknown) => warn(`prompt cleanup failed: ${String(error)}`));
}
function promptUpkeep(): void {
  if (sweeping) return;
  sweeping = true;
  sweep(upkeepDeps).catch((error: unknown) => warn(`prompt upkeep failed: ${String(error)}`)).finally(() => { sweeping = false; arm(); });
}
void connected.promise.then(async () => {
  arm();
  promptUpkeep();
  setInterval(promptUpkeep, 15_000).unref();
  try {
    const app = await rest<{ interactions_endpoint_url?: string | null }>("/applications/@me");
    if (app.interactions_endpoint_url) {
      warn(`Discord sends button clicks to ${app.interactions_endpoint_url}, not to Helio; clear the Interactions Endpoint URL in the Developer Portal`);
    }
  } catch (error) {
    if (!(error instanceof DiscordRestError)) throw error;
    warn(`could not check where Discord sends button clicks: ${error.message}`);
  }
});

listener.on("connected", ({ user }) => { cfg.botId = user.id; });
listener.on("channel_update", () => channels.clear());
// Not queued: the delivery queue may be the one waiting for this preview.
listener.on("message_update", (event) => previews.update(event.id, (event as { embeds?: PreviewEmbed[] }).embeds));
listener.on("channel_delete", () => channels.clear());
listener.on("message_create", (event) => {
  // Ignored channels are not read, cached or processed at all.
  if (cfg.ignoredChannels?.has(event.channel_id)) return;
  void (async () => {
    if (event.guild_id !== undefined && cfg.ignoredChannels?.size &&
        await insideAllowed(event.channel_id, cfg.ignoredChannels, parentOf)) return;
    seen(event as unknown as ReplyMessage);
    seen((event as { referenced_message?: ReplyMessage | null }).referenced_message);
    enqueue(`message ${event.id} in ${event.channel_id}`, () => deliver(event, false));
  })().catch(fail);
});
listener.on("typing_start", (event) => {
  if (event.user_id === cfg.botId) return;
  enqueue(`typing in ${event.channel_id}`, async () => turns.typing(event.channel_id, event.user_id));
});

const DISALLOWED_INTENTS = "4014";

function fail(err: unknown): never {
  const text = String(err);
  const hint = text.includes(DISALLOWED_INTENTS) ? " (turn on Message Content Intent in the Developer Portal)" : "";
  console.error(monitorLine(`INBOUND_ERROR gateway: ${text}${hint}`));
  process.exit(1);
}

listener.on("error", fail);

await listener.start().catch(fail);
if (!cfg.botId || !/^\d+$/.test(cfg.botId)) {
  fail(new Error("bot identity unavailable; no channel cursors advanced"));
}
connected.resolve();
enqueue("ready", async () => {
  console.log(monitorLine(`INBOUND_READY allowed=${[...cfg.allowed].join(",")} backlog=${backlogCount}`));
});
