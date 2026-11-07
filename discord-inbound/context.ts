// Read-only reader of the channels Dori learns from (never replies there).
// Prints pending and newly fetched CONTEXT lines; --loop refreshes every 30 minutes.
//
// Env:
//   DORI_DISCORD_TOKEN    bot token
//   DORI_DISCORD_CONTEXT  comma-separated channel or category IDs to learn from
//   DORI_DISCORD_NORMAL_CHANNELS  normal roots to exclude, including all descendants
//     Adds to DORI_DISCORD_ALLOWED minus DORI_DISCORD_TRUSTED_CHANNELS.
//   DORI_STATE_DIR        where the last message read per channel is kept

import { fetchBacklog, PAGE_SIZE, type Caps, type FetchPage, type RestMessage } from "./intake/catchup.ts";
import { requestMessage } from "./intake/filter.ts";
import { LastSeen } from "./intake/lastseen.ts";
import { RecentIds } from "./intake/recent-ids.ts";
import { Delivery } from "./delivery/delivery.ts";
import { sweepOrphanAttachments } from "./delivery/expiry.ts";
import { excludedChannels, learningAllowed, learningChannelAllowed, normalChannels } from "./learning/learning-scope.ts";
import { contextReplayAllowed } from "./learning/context-replay.ts";
import { prepareMessageBody } from "./messages/forwarded.ts";
import { cleanupIgnored } from "./delivery/ignored-cleanup.ts";
import { DiscordRestError, IgnoredChannelError, discordRest, expandChannels, MESSAGE_CHANNEL_TYPES, type ApiChannel } from "./discord/rest.ts";
import { contextSummary, monitorLine } from "./delivery/monitor-summary.ts";
import { watch } from "node:fs";
import { join } from "node:path";
import { acknowledgePolicy, policyValues, runtimePolicy } from "./intake/runtime-policy.ts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`CONTEXT_ERROR missing env ${name}`);
    process.exit(2);
  }
  return value;
}

const rest = discordRest(requireEnv("DORI_DISCORD_TOKEN"));
const stateDir = requireEnv("DORI_STATE_DIR");
const statePath = `${stateDir}/discord-context.json`;
const delivery = new Delivery(`${stateDir}/discord-delivery.sqlite`);
const announced = new RecentIds();

// A first read is a deliberate sample: up to 40 recent messages, and at least the newest 15 even in quiet channels.
const FIRST_READ: Caps = { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxPerChannel: 40, minKeep: 15 };
const LATER_READ: Caps = { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxPerChannel: 500 };

function currentExclusions(): Set<string> {
  const values = policyValues();
  return new Set([...excludedChannels(values.DORI_DISCORD_CONTEXT_EXCLUDED ?? ""),
    ...excludedChannels(values.DORI_DISCORD_IGNORED_CHANNELS ?? ""), ...normalChannels(values)]);
}

const fetchPage: FetchPage = async (channelId, before) => {
  const metadata = await rest<ApiChannel>(`/channels/${channelId}`);
  if (!await learningChannelAllowed(metadata, currentExclusions(), rest)) {
    throw new IgnoredChannelError(channelId);
  }
  return rest<RestMessage[]>(`/channels/${channelId}/messages?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`);
};

let skipped = 0;
const skip = (id: string, err: unknown) => {
  skipped++;
  console.log(monitorLine(`CONTEXT_WARN ${id} skipped: ${String(err)}`));
};

async function refresh(): Promise<void> {
  const revision = runtimePolicy()?.revision;
  const values = policyValues();
  const ids = (values.DORI_DISCORD_CONTEXT ?? requireEnv("DORI_DISCORD_CONTEXT")).split(",").map(s => s.trim()).filter(Boolean);
  const excluded = currentExclusions();
  const ignored = excludedChannels(values.DORI_DISCORD_IGNORED_CHANNELS ?? "");
  const lastRead = await LastSeen.load(statePath);
  skipped = 0;
  await sweepOrphanAttachments(delivery, stateDir, "context");
  const emitted = new Set<string>();
  let total = 0;
  const channels = [];
  for (const channel of await expandChannels(rest, ids, MESSAGE_CHANNEL_TYPES, skip)) {
    try {
      if (await learningChannelAllowed(channel, excluded, rest)) channels.push(channel);
    } catch (err) {
      if (!(err instanceof DiscordRestError)) throw err;
      skip(channel.id, err);
    }
  }
  const allowed = new Set(channels.map(c => c.id));
  let withheld = 0;
  for (const item of delivery.pending("context")) {
    try {
      if (await delivery.ignored.settle("context", item.id, item.payload, ignored, async id =>
        rest<{ parent_id?: string }>(`/channels/${id}`))) continue;
    } catch (error) {
      if (!(error instanceof DiscordRestError)) throw error;
      skip(item.id, error); withheld++; continue;
    }
    let payload: unknown;
    try { payload = JSON.parse(item.payload); } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (typeof payload !== "object" || payload === null || !("channel_id" in payload) ||
        !("human_verified" in payload) || payload.human_verified !== true ||
        !learningAllowed(payload.channel_id, allowed, excluded) ||
        ("bot" in payload && payload.bot === true) || "webhook_id" in payload ||
        ("author_id" in payload && typeof payload.author_id === "string" && delivery.moderation.isBlocked(payload.author_id))) {
      withheld++;
      continue;
    }
    try {
      if (!await contextReplayAllowed(item.payload, policyValues(), rest)) { withheld++; continue; }
    } catch (error) {
      if (!(error instanceof DiscordRestError)) throw error;
      skip(item.id, error); withheld++; continue;
    }
    if (!announced.has(item.id)) console.log(contextSummary(item.id, item.payload));
    announced.add(item.id);
    emitted.add(item.id);
    total++;
  }
  if (withheld) console.log(`CONTEXT_WITHHELD pending=${withheld}`);
  if (total) console.log(`CONTEXT_PENDING count=${total} read="ack pending context"`);
  for (const channel of channels) {
    try {
      const after = lastRead.get(channel.id);
      const caps = after === undefined ? FIRST_READ : LATER_READ;
      const { messages, truncated, reason = "cap" } = await fetchBacklog(fetchPage, channel.id, after, Date.now(), caps);
      // Only a later read can miss messages; the first read's limits are the intended sample. Messages past the
      // 30-day horizon expire unlearned by design; only a cap or page cut leaves an unread gap.
      if (truncated && after !== undefined) {
        console.log(monitorLine(`CONTEXT_TRUNCATED channel=${channel.name ?? channel.id} kept=${messages.length} reason=${reason}`));
        const before = messages[0]?.id;
        const id = before && reason !== "age" ? delivery.recordGap({ stream: "context", channel: channel.id, after, before, reason }) : undefined;
        if (id !== undefined) console.log(monitorLine(`CONTEXT_GAP ${JSON.stringify({ id, channel_id: channel.id, after, before, read: "ack gaps", ack: `ack gap ${id}` })}`));
      }
      for (const msg of messages) {
        if (runtimePolicy()?.revision !== revision) return;
        if (msg.author.bot || ("webhook_id" in msg && msg.webhook_id !== undefined) ||
            delivery.moderation.isBlocked(msg.author.id)) continue;
        if (!requestMessage(msg)) continue;
        if (delivery.contains("context", msg.id)) continue;
        const body = await prepareMessageBody(msg, `${stateDir}/attachments/context`);
        if (runtimePolicy()?.revision !== revision) return;
        const payload = JSON.stringify({
          message_id: msg.id,
          message_type: msg.type,
          preparation_complete: true,
          channel: channel.name,
          channel_id: channel.id,
          guild_id: channel.guild_id,
          author_id: msg.author.id,
          author: msg.author.global_name ?? msg.author.username,
          bot: msg.author.bot ?? false,
          human_verified: true,
          sent_at: msg.timestamp,
          reply_to: msg.message_reference?.type === 1 ? undefined : msg.message_reference?.message_id,
          ...body,
        });
        if (delivery.stage("context", msg.id, payload) && !emitted.has(msg.id)) {
          if (await delivery.ignored.settle("context", msg.id, payload)) continue;
          console.log(contextSummary(msg.id, payload));
          announced.add(msg.id);
          emitted.add(msg.id);
          total++;
        }
      }
      const newest = messages.at(-1);
      if (newest) await lastRead.advance(channel.id, newest.id);
    } catch (err) {
      if (err instanceof IgnoredChannelError) continue;
      if (!(err instanceof DiscordRestError)) throw err;
      skip(channel.id, err);
    }
  }
  // Only a refresh that reached every channel may forget read positions of channels no longer learned.
  await cleanupIgnored(delivery, stateDir);
  if (skipped === 0) await lastRead.retain(new Set(channels.map((channel) => channel.id)));
  await lastRead.save();
  console.log(`CONTEXT_DONE channels=${channels.length} messages=${total}`);
}

try {
  do {
    const revision = runtimePolicy()?.revision;
    await refresh();
    if (!process.argv.includes("--loop")) break;
    if (runtimePolicy()?.revision !== revision) continue;
    acknowledgePolicy("learning", revision);
    if (revision === undefined) {
      await Bun.sleep(30 * 60 * 1000);
      continue;
    }
    await new Promise<void>(resolve => {
      const directory = process.env.DORI_POLICY_DIR ?? join(process.env.HOME ?? "", ".dori/elobot/policy");
      const timer = setTimeout(() => { watcher?.close(); resolve(); }, 30 * 60 * 1000);
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (name !== "policy.json") return;
        clearTimeout(timer); watcher?.close(); resolve();
      });
      if (runtimePolicy()?.revision !== revision) { clearTimeout(timer); watcher?.close(); resolve(); }
    });
  } while (process.argv.includes("--loop"));
} catch (err) {
  console.error(monitorLine(`CONTEXT_ERROR ${String(err)}`));
  process.exitCode = 1;
} finally {
  delivery.close();
}
