// Discord inbound watcher for Dori. On start it catches up on messages missed while it was off, then streams live ones.
// Prints one `INBOUND <json>` line per message that passes the filter; run it as a persistent monitor with filter `^INBOUND`.
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
//   DORI_STATE_DIR         where the last message seen per channel is kept

import { DiscordBotClient, DiscordBotListener, DiscordIntent } from "agent-messenger/discordbot";
import { fetchBacklog, PAGE_SIZE, type Caps, type FetchPage, type RestMessage } from "./catchup.ts";
import { classify, insideAllowed, type FilterConfig, type IncomingMessage } from "./filter.ts";
import { LastSeen } from "./lastseen.ts";
import { Delivery, REQUEST_MAX_AGE_MS, requestTimestamp } from "./delivery.ts";
import { authorizationMetadata, filterConfig, reauthorize, validateChannelPolicy } from "./authorization.ts";
import { sweepExpired } from "./expiry.ts";
import { watchedChannels } from "./watched-channels.ts";
import { prepareMessageBody } from "./forwarded.ts";
import { replyContext, type ReplyMessage } from "./reply-context.ts";
import { recordAnswer } from "./question-answer.ts";
import { DiscordRestError, discordRest } from "./rest.ts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`INBOUND_ERROR missing env ${name}`);
    process.exit(2);
  }
  return value;
}

const token = requireEnv("DORI_DISCORD_TOKEN");
let cfg: FilterConfig;
try {
  cfg = filterConfig(process.env);
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
// Read only reply ancestors in the same channel as an already-authorized message.
const fetchReply = async (channel: string, id: string, signal: AbortSignal): Promise<ReplyMessage> => {
  const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages/${id}`, {
    headers: { Authorization: `Bot ${token}` }, signal,
  });
  if (!response.ok) throw new Error(`reply fetch failed (${response.status})`);
  return await response.json() as ReplyMessage;
};
const stateDir = requireEnv("DORI_STATE_DIR");
const delivery = new Delivery(`${stateDir}/discord-delivery.sqlite`);

const recoveryPages = new Map<string, readonly RestMessage[]>();
const fetchPage: FetchPage = async (channelId, before) => {
  const page = await rest<RestMessage[]>(`/channels/${channelId}/messages?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`);
  recoveryPages.set(channelId, page);
  return page;
};

const warn = (text: string) => console.log(`INBOUND_WARN ${text}`);

const client = await new DiscordBotClient().login({ token });

const parents = new Map<string, string | undefined>();
async function parentOf(channelId: string): Promise<string | undefined> {
  if (parents.has(channelId)) return parents.get(channelId);
  const channel = await client.getChannel(channelId);
  const parent = channel.parent_id ?? undefined;
  parents.set(channelId, parent);
  return parent;
}

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

async function deliver(msg: IncomingMessage, backlog: boolean): Promise<boolean> {
  if (delivered.has(msg.id)) return false;
  let inbound: Awaited<ReturnType<typeof classify>>;
  try {
    if (msg.guild_id !== undefined && cfg.blockedChannels?.size &&
        await insideAllowed(msg.channel_id, cfg.blockedChannels, parentOf)) {
      warn(`channel policy blocked channel=${msg.channel_id} message_id=${msg.id}; cursor retained`);
      return false;
    }
    inbound = await classify(msg, cfg, parentOf);
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
      const reply_context = !backlog && inbound.channel_policy === "trusted" ? await replyContext(msg, fetchReply) : undefined;
      const record = { ...staged, ...body, preparation_complete: true, ...(reply_context ? { reply_context } : {}) };
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
      let question_id: string | undefined;
      try { question_id = recordAnswer(stateDir, cfg.ownerId, record); }
      catch { warn("question answer could not be recorded; leave it pending and reconcile"); }
      const payload = JSON.stringify({ ...record, ...(question_id ? { question_id } : {}) });
      if (delivery.refresh(msg.id, JSON.stringify(record), payload)) {
        console.log(`INBOUND ${payload}`);
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
    const payload = JSON.stringify(current);
    if (!delivery.refresh(item.id, item.payload, payload)) continue;
    try { delivery.check(item.id); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      warn(`pending side effects withheld message_id=${item.id}: ${error.message}`);
      recoveryNeeded.add(item.id);
      continue;
    }
    try { recordAnswer(stateDir, cfg.ownerId, current); }
    catch { warn("pending question answer could not be reconciled"); }
    console.log(`INBOUND ${payload}`);
    delivered.add(item.id);
    backlogCount++;
  }
  backlogCount += await catchUp();
});

const listener = new DiscordBotListener(client, {
  intents:
    DiscordIntent.Guilds | DiscordIntent.GuildMessages | DiscordIntent.MessageContent | DiscordIntent.DirectMessages,
});

listener.on("connected", ({ user }) => { cfg.botId = user.id; });
listener.on("channel_update", () => parents.clear());
listener.on("channel_delete", () => parents.clear());
listener.on("message_create", (event) => {
  enqueue(`message ${event.id} in ${event.channel_id}`, () => deliver(event, false));
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
