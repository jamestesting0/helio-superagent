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
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fetchBacklog, PAGE_SIZE, skippedThrough, type Caps, type FetchPage, type RestMessage } from "./intake/catchup.ts";
import { countsTowardCatchUp, classify, insideAllowed, insideCategory, type FilterConfig, type Inbound, type IncomingMessage } from "./intake/filter.ts";
import { LastSeen } from "./intake/lastseen.ts";
import { RecentIds } from "./intake/recent-ids.ts";
import { Delivery, REQUEST_MAX_AGE_MS, requestTimestamp } from "./delivery/delivery.ts";
import { authorizationMetadata, filterConfig, reauthorize, validateChannelPolicy, type OriginalMetadata } from "./intake/authorization.ts";
import { sweepExpired, sweepOrphanAttachments } from "./delivery/expiry.ts";
import { cleanupIgnored } from "./delivery/ignored-cleanup.ts";
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
import { newerInputPending } from "./conversations/pending-input.ts";
import { reactOnArrival, sweepWorking } from "./conversations/working.ts";
import { inboundSummary, monitorLine } from "./delivery/monitor-summary.ts";
import { HOURGLASS, react, reactPendingBlocks, reconcileBlocks, strikeLinks } from "./delivery/moderation-effects.ts";
import { pendingReminder } from "./delivery/pending-reminder.ts";
import { PromptStore, QuestionStore } from "./interactive/store.ts";
import { closeExpired, discordCall, expireNow, handleInteraction, handlePlanReply, sweep, type Deps } from "./interactive/handler.ts";
import { isAdminInteraction } from "./admin/protocol.ts";
import { acknowledgePolicy, policyValues, runtimePolicy } from "./intake/runtime-policy.ts";

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
    (channel, user, id) => conversations.workingAnchor(channel, user, id), (channel) => ownerPosts.get(channel),
    (channel, user) => conversations.talkedRecently(channel, user, Date.now()));
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

const CAPS: Caps = { maxAgeMs: 3 * 24 * 60 * 60 * 1000, maxPerChannel: 100, maxPages: 20 };
const rest = discordRest(token);
// Messages inbound already received (catch-up pages, live events) answer most reply lookups without a request.
const seenMessages = new Map<string, ReplyMessage>();
function seen(message: ReplyMessage | null | undefined): void {
  if (!message?.id || !message.channel_id || blockedAuthor(message.author?.id)) return;
  noteOwnerPost(message);
  seenMessages.delete(message.id);
  seenMessages.set(message.id, message);
  if (seenMessages.size > 2000) seenMessages.delete(seenMessages.keys().next().value as string);
}
// Read only reply ancestors in the same channel as an already-authorized message.
const fetchReply = async (channel: string, id: string, signal: AbortSignal): Promise<ReplyMessage> => {
  const known = seenMessages.get(id);
  if (known?.channel_id === channel) return withoutBlocked(known);
  const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages/${id}`, {
    headers: { Authorization: `Bot ${token}` }, signal,
  });
  if (!response.ok) throw new Error(`reply fetch failed (${response.status})`);
  return withoutBlocked(await response.json() as ReplyMessage);
};
const stateDir = requireEnv("DORI_STATE_DIR");
let appliedPolicy = runtimePolicy()?.revision;
acknowledgePolicy("intake", appliedPolicy);
const delivery = new Delivery(`${stateDir}/discord-delivery.sqlite`, LOCK_WAIT_MS);
// A native monitor notification can coalesce events under an older timestamp.
// Record readiness at its source, bound to this process even across PID reuse/namespaces.
const startTicks = readFileSync("/proc/self/stat", "utf8").split(") ").at(-1)!.split(" ")[19]!;
const recordReadiness = (phase: "starting" | "ready") => {
  const path = `${stateDir}/intake-readiness.json`;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, start_ticks: startTicks, phase, at_ms: Date.now() }), { mode: 0o600 });
  renameSync(temporary, path);
};
recordReadiness("starting");
function blockedAuthor(id: string | undefined): boolean {
  const current = policyValues();
  return id !== undefined && id !== current.DORI_DISCORD_OWNER_ID &&
    !(current.DORI_DISCORD_TRUSTED_IDS ?? "").split(",").includes(id) && delivery.moderation.isBlocked(id);
}
// Context shown to Helio keeps the blocked message's place in the chain but none of its content.
function withoutBlocked(message: ReplyMessage): ReplyMessage {
  if (!blockedAuthor(message.author?.id)) return message;
  return { id: message.id, channel_id: message.channel_id, guild_id: message.guild_id, timestamp: message.timestamp,
    message_reference: message.message_reference, author: message.author, content: "[message from a blocked user omitted]" };
}
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

// Every page fetched for a channel in this catch-up, so messages on earlier (newer) pages are delivered too.
const recoveryPages = new Map<string, Map<string, RestMessage>>();
const fetchPage: FetchPage = async (channelId, before) => {
  const page = await rest<RestMessage[]>(`/channels/${channelId}/messages?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`);
  if (!before || !recoveryPages.has(channelId)) recoveryPages.set(channelId, new Map());
  for (const message of page) recoveryPages.get(channelId)?.set(message.id, message);
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

type ChannelInfo = { readonly type?: number; readonly parent_id?: string; readonly guild_id?: string };
const channels = new Map<string, ChannelInfo | undefined>();
// Missing Access / Unknown Channel: Discord will never show this channel to Helio.
const UNREADABLE_CHANNEL = new Set(["50001", "10003"]);
async function channelInfo(channelId: string): Promise<ChannelInfo | undefined> {
  if (channels.has(channelId)) return channels.get(channelId);
  let info: ChannelInfo | undefined;
  try {
    const channel = await client.getChannel(channelId);
    info = { type: channel.type, parent_id: channel.parent_id ?? undefined, guild_id: channel.guild_id ?? undefined };
  }
  catch (error) {
    // An unreadable ancestor (a hidden category) ends the walk, so it can only fail membership checks.
    if (!(error instanceof Error) || !UNREADABLE_CHANNEL.has(String((error as { code?: unknown }).code))) throw error;
  }
  channels.set(channelId, info);
  return info;
}
const parentOf = async (channelId: string) => (await channelInfo(channelId))?.parent_id;
let updatingPolicy: Promise<void> | undefined;
function refreshPolicy(): Promise<void> {
  if (updatingPolicy) return updatingPolicy;
  if (runtimePolicy()?.revision === appliedPolicy) return Promise.resolve();
  updatingPolicy = (async () => {
    do {
      const revision = runtimePolicy()?.revision;
      const next = filterConfig(process.env, (channel, user) => conversations.isOpen(channel, user),
        (channel, user, id) => conversations.workingAnchor(channel, user, id), channel => ownerPosts.get(channel),
        (channel, user) => conversations.talkedRecently(channel, user, Date.now()));
      if (cfg.botId !== undefined) next.botId = cfg.botId;
      channels.clear();
      await validateChannelPolicy(next, rest, warn);
      cfg = next;
      appliedPolicy = revision;
      acknowledgePolicy("intake", revision);
    } while (runtimePolicy()?.revision !== appliedPolicy);
  })().finally(() => { updatingPolicy = undefined; });
  return updatingPolicy;
}
if (appliedPolicy !== undefined) setInterval(() => {
  void refreshPolicy().catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    console.error(monitorLine(`INBOUND_ERROR policy update failed: ${error.message}`));
    process.exit(1);
  });
}, 1000).unref();

const tracked = new Set<string>();
const delivered = new RecentIds();
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
  return { status: "parent_only", messages: [describeMessage(withoutBlocked(parent), 24_000).entry] };
}

async function conversationContext(msg: IncomingMessage) {
  const pinged = cfg.botId !== undefined && (msg.mentions?.some((user) => user.id === cfg.botId) === true ||
    msg.content.includes(`<@${cfg.botId}>`) || msg.content.includes(`<@!${cfg.botId}>`));
  const conversation = conversationSnapshot(conversations, msg.channel_id, msg.author.id, Date.now(),
    { reply_to: msg.message_reference?.type === 1 ? undefined : msg.message_reference?.message_id, pinged });
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
    .slice(0, 5).reverse().map((entry) => describeMessage(withoutBlocked(entry), 400).entry);
  return {
    ...conversation, transcript: previous.slice(-6), earlier_entries: Math.max(0, previous.length - 6), recent,
  };
}

function recordHelioReply(msg: IncomingMessage): void {
  if (conversations.observeNotice(msg.channel_id, msg.nonce, msg.id, Date.now())) return;
  const reference = msg.message_reference;
  if (!reference?.message_id || reference.type === 1 ||
      (reference.channel_id && reference.channel_id !== msg.channel_id)) return;
  for (const conversation of conversations.list().filter((row) => row.channel_id === msg.channel_id)) {
    if (conversation.anchor_message_id === reference.message_id ||
        conversations.belongs(conversation, reference.message_id)) {
      conversations.append(msg.channel_id, conversation.user_id, describeMessage(msg, 10000).entry, Date.parse(msg.timestamp));
    }
  }
}

async function deliver(msg: IncomingMessage, backlog: boolean): Promise<boolean> {
  await refreshPolicy();
  if (delivered.has(msg.id)) return false;
  if (blockedAuthor(msg.author.id)) {
    delivered.add(msg.id);
    if (tracked.has(msg.channel_id)) await lastSeen.advance(msg.channel_id, msg.id);
    return false;
  }
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
      inbound = await classify(msg, cfg, channelInfo, () => preceding.remember(msg));
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
      if (!recovering && inbound.pinged && inbound.channel_policy === "normal" && inbound.role === "STAFF_QUESTION") {
        const gate = delivery.moderation.admitPing(msg.author.id, msg.id, sentAt);
        if (!gate.admitted) {
          if (gate.notify) await react(rest, msg.channel_id, msg.id, HOURGLASS, warn);
          delivered.add(msg.id);
          await lastSeen.advance(msg.channel_id, msg.id);
          return false;
        }
      }
      // Stage the authorized message before any slow enrichment: a crash or a slow download loses nothing.
      const minimal = JSON.stringify({ ...staged, attachments: [], preparation_complete: false });
      if (prior ? !delivery.recover(msg.id, prior.payload, minimal) : !delivery.stage("inbound", msg.id, minimal)) return false;
      const channel = msg.channel_id;
      if (backlog) backlogOrder.set(msg.id, backlogOrder.size);
      const enrichment = (enrichments.get(channel) ?? Promise.resolve())
        .then(() => enrich(msg, inbound, staged, minimal, backlog))
        .catch((error: unknown) => {
          console.error(monitorLine(`INBOUND_ERROR preparing message ${msg.id} in ${channel}: ${String(error)}`));
          process.exit(1);
        }).finally(() => {
          // A newer chain for this channel may already be queued behind this one.
          if (enrichments.get(channel) === enrichment) enrichments.delete(channel);
        });
      enrichments.set(channel, enrichment);
      emitted = true;
    }
    tracked.add(msg.channel_id);
  }
  if (tracked.has(msg.channel_id)) await lastSeen.advance(msg.channel_id, msg.id);
  delivered.add(msg.id);
  return emitted;
}

// One chain per channel keeps a channel's messages in order without making other channels wait on it.
const enrichments = new Map<string, Promise<void>>();
const enrichmentsSettled = async () => { await Promise.all(enrichments.values()); };
// Catch-up replays in the order it read the history, whichever channel finished preparing first.
const backlogOrder = new Map<string, number>();

async function enrich(msg: IncomingMessage, inbound: Inbound, staged: Inbound & { readonly backlog: boolean },
  minimal: string, backlog: boolean): Promise<void> {
  const source = inbound.channel_policy === "trusted" && !backlog && awaitsPreview(msg.content, msg.embeds) ?
    await withPreviews(msg) : msg;
  const body = await prepareMessageBody(source, `${stateDir}/attachments/inbound`, inbound.role === "BOT_BUG_REPORT",
    inbound.channel_policy);
  const prepared = JSON.stringify({ ...staged, ...body, attachments_prepared: true, preparation_complete: false });
  if (!delivery.refresh(msg.id, minimal, prepared)) return;
  if (await delivery.ignored.settle("inbound", msg.id, prepared, cfg.ignoredChannels, channelInfo)) {
    await cleanupIgnored(delivery, stateDir, conversations);
    return;
  }
  if (inbound.role !== "BOT_BUG_REPORT") {
    conversations.observeInput(msg.channel_id, msg.author.id, msg.id, Date.now(), inbound.reply_to);
  }
  const reply_context = inbound.channel_policy === "trusted" ? await replyContext(msg, fetchReply) : repliedTo(msg);
  const conversation = await conversationContext(msg);
  const assembled = {
    ...staged, ...body, preparation_complete: true,
    ...(reply_context ? { reply_context } : {}), ...(conversation ? { conversation } : {}),
  };
  await refreshPolicy();
  const authorized = await reauthorize(JSON.stringify(assembled), cfg, rest);
  if (!authorized) {
    await delivery.ignored.settle("inbound", msg.id, prepared, cfg.ignoredChannels, channelInfo);
    return;
  }
  const record = { ...assembled, ...authorized };
  // Dismissed, blocked or acknowledged while it was being prepared: nothing more to deliver.
  if (!delivery.refresh(msg.id, prepared, JSON.stringify(record))) return;
  await sweepExpired(delivery, stateDir, warn);
  if (delivery.status("inbound", msg.id).disposition === "expired") return;
  try { delivery.check(msg.id); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    warn(`pending side effects withheld message_id=${msg.id}: ${error.message}`);
    await sweepExpired(delivery, stateDir, warn);
    return;
  }
  const question_id = answerFor(record);
  const message = { ...record, ...(question_id ? { question_id } : {}) };
  const payload = JSON.stringify(message);
  if (backlog) delivery.recovery.flag(msg.id, payload);
  if (!delivery.refresh(msg.id, JSON.stringify(record), payload)) return;
  if (message.pinged && message.role !== "BOT_BUG_REPORT") {
    conversations.openWorking(msg.channel_id, msg.author.id, msg.id, Date.now());
  }
  await reactOnArrival({ store: conversations, rest, now: Date.now(), warn },
    { ...message, entry: describeMessage(msg, 10_000).entry });
  if (backlog) backlogMessages.push(message);
  else turns.push(message);
}

async function catchUp(): Promise<number> {
  let count = 0;
  for (const channel of await watchedChannels(cfg, rest, warn)) {
    tracked.add(channel.id);
    try {
      const after = lastSeen.get(channel.id);
      // The cap counts only what classify would admit, so a busy channel's chatter cannot push a request out of reach.
      const policy = channel.guildId === undefined || await insideAllowed(channel.id, cfg.trustedChannels ?? new Set(), parentOf) ? "trusted" : "normal";
      const backlog = await fetchBacklog(fetchPage, channel.id, after, Date.now(),
        { ...CAPS, counts: (msg) => !blockedAuthor(msg.author.id) && countsTowardCatchUp({ ...msg, guild_id: channel.guildId }, cfg, policy) });
      const { messages, truncated } = backlog;
      if (truncated) console.log(`INBOUND_BACKLOG_TRUNCATED channel=${channel.id} kept=${messages.length}`);
      const skipped = await skippedThrough(fetchPage, channel.id, backlog);
      const before = messages[0]?.id ?? skipped;
      // Older than the 72-hour horizon would expire unread anyway; a cap or page cut is a real gap.
      // Without a cursor (a first run) the unread range starts at the beginning of the channel's history.
      if (truncated && backlog.reason !== "age" && before) {
        const reason = backlog.reason ?? "cap";
        const from = after ?? "0";
        const id = delivery.recordGap({ stream: "inbound", channel: channel.id, after: from, before, reason });
        if (id !== undefined) {
          console.log(monitorLine(`INBOUND_GAP ${JSON.stringify({ id, channel_id: channel.id, after: from, before, reason, read: "ack gaps", ack: `ack gap ${id}` })}`));
        }
      }
      if (skipped) await lastSeen.advance(channel.id, skipped);
      const fresh = new Set(messages.map((msg) => msg.id));
      const candidates = [...(recoveryPages.get(channel.id)?.values() ?? [])]
        .filter((msg) => fresh.has(msg.id) || recoveryNeeded.has(msg.id))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      recoveryPages.delete(channel.id);
      for (const msg of candidates) {
        if (recoveryNeeded.has(msg.id)) recoverySeen.add(msg.id);
        if (await deliver({ ...msg, guild_id: channel.guildId }, true)) count++;
      }
    } catch (err) {
      if (!(err instanceof DiscordRestError)) throw err;
      warn(`catch-up failed for channel ${channel.id}: ${String(err)}`);
    }
  }
  await enrichmentsSettled();
  backlogMessages.sort((a, b) => (backlogOrder.get(a.message_id) ?? 0) - (backlogOrder.get(b.message_id) ?? 0));
  backlogOrder.clear();
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
  for (const item of delivery.pending("inbound")) {
    await delivery.ignored.settle("inbound", item.id, item.payload, cfg.ignoredChannels, channelInfo);
  }
  await cleanupIgnored(delivery, stateDir, conversations);
  await sweepExpired(delivery, stateDir, warn);
  await sweepOrphanAttachments(delivery, stateDir, "inbound");
  const replayMessages: TurnMessage[] = [];
  for (const item of delivery.pending("inbound")) {
    let current: Awaited<ReturnType<typeof reauthorize>>;
    let original: OriginalMetadata | undefined;
    try { current = await reauthorize(item.payload, cfg, rest, value => { original = value; }); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      warn(`pending authorization unavailable message_id=${item.id}; retained pending: ${error.message}`);
      recoveryNeeded.add(item.id);
      continue;
    }
    if (!current) {
      if (original && await delivery.ignored.settle("inbound", item.id, item.payload, cfg.ignoredChannels, channelInfo, original)) {
        await cleanupIgnored(delivery, stateDir, conversations);
        continue;
      }
      warn(`pending authorization revoked message_id=${item.id}; retained pending`);
      recoveryNeeded.add(item.id);
      continue;
    }
    // Accepted work from a since-blacklisted sender is kept, but never replayed to Helio.
    if (blockedAuthor(current.author_id)) continue;
    await sweepExpired(delivery, stateDir, warn);
    try { delivery.check(item.id); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      warn(`pending side effects withheld message_id=${item.id}: ${error.message}`);
      recoveryNeeded.add(item.id);
      continue;
    }
    const question_id = answerFor(current);
    if (current.role !== "BOT_BUG_REPORT") {
      conversations.observeInput(current.channel_id, current.author_id, current.message_id, Date.now(), current.reply_to);
    }
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
  const openGaps = delivery.gaps().length;
  if (openGaps) console.log(monitorLine(`INBOUND_GAPS_PENDING count=${openGaps} read="ack gaps"`));
  const upkeep = async () => {
    await refreshPolicy();
    await reconcileBlocks({ delivery, conversations, rest, stateDir, warn });
    await sweepConversations({
      store: conversations, rest, now: Date.now(), emit: (line) => console.log(line),
      hasNewInput: row => newerInputPending(delivery.pending("inbound"), conversations, row,
        [row.latest_input_id ?? row.anchor_message_id]),
      canContact: async (row, guild) => {
        if (blockedAuthor(row.user_id)) return false;
        if (!guild) return row.user_id === cfg.ownerId || cfg.trustedIds?.has(row.user_id) === true;
        if (cfg.scopeCategory && !await insideCategory(row.channel_id, cfg.scopeCategory, channelInfo)) return false;
        if (await insideAllowed(row.channel_id, cfg.ignoredChannels ?? new Set(), parentOf) ||
            await insideAllowed(row.channel_id, cfg.blockedChannels ?? new Set(), parentOf)) return false;
        return insideAllowed(row.channel_id, cfg.allowed, parentOf);
      },
    });
    await sweepWorking({ store: conversations, delivery, rest, now: Date.now(), warn });
    await reactPendingBlocks(delivery, rest, warn);
    for (const row of delivery.moderation.unreviewed()) {
      console.log(monitorLine(`INBOUND_BLACKLIST_REVIEW ${JSON.stringify({
        user_id: row.user_id, reason: row.reason, evidence_message_id: row.evidence_message_id,
        evidence_channel_id: row.evidence_channel_id, read: "helio blacklist list",
        strikes: await strikeLinks(delivery.moderation.strikeEvidence(row.user_id), async (channel) => (await channelInfo(channel))?.guild_id),
      })}`));
    }
  };
  // Upkeep waits on Discord; it runs beside the message queue, never in it, so a slow call cannot hold back a delivery.
  let upkeeping = false;
  const runUpkeep = () => {
    if (upkeeping) return;
    upkeeping = true;
    upkeep().then(() => { upkeeping = false; }, (err: unknown) => {
      console.error(monitorLine(`INBOUND_ERROR conversation and 👀 upkeep: ${String(err)}`));
      process.exit(1);
    });
  };
  runUpkeep();
  setInterval(runUpkeep, 10 * 60 * 1000).unref();
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
  ownerId: cfg.ownerId, trusted: () => filterConfig(process.env).trustedIds ?? new Set<string>(), call: discordCall(token),
  now: () => Date.now(), emit: (line) => console.log(line), warn,
};
const upkeepDeps: Deps = { ...clickDeps, call: discordCall(token, 10_000) };
listener.on("interaction_create", (event) => {
  if (isAdminInteraction(event)) return;
  const click = event as { member?: { user?: { id?: string } }; user?: { id?: string } };
  if (blockedAuthor(click.member?.user?.id ?? click.user?.id)) return;
  void handleInteraction(event, clickDeps);
});
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
    if (blockedAuthor(event.author.id)) return;
    if (event.author.id === cfg.botId && conversations.observeNotice(
      event.channel_id, event.nonce, event.id, Date.now())) return;
    if (typeof event.message_type !== "number") throw new TypeError("Gateway message type unavailable");
    const message = { ...event, type: event.message_type };
    seen(message);
    seen((event as { referenced_message?: ReplyMessage | null }).referenced_message);
    enqueue(`message ${event.id} in ${event.channel_id}`, () => deliver(message, false));
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
  recordReadiness("ready");
  console.log(monitorLine(`INBOUND_READY allowed=${[...cfg.allowed].join(",")} backlog=${backlogCount}`));
});
