import { audienceOf } from "./conversation-context.ts";
import type { Conversations, ConversationEntry } from "./conversations.ts";
import { WORKING_WINDOW_MS } from "./conversations.ts";
import type { Delivery } from "../delivery/delivery.ts";
import { DiscordRestError, IgnoredChannelError, type Rest } from "../discord/rest.ts";

export const WORKING_ABANDON_MS = 2 * 60 * 60 * 1000;
export type WorkingReaction = "added" | "already" | "skipped" | "skipped-already-replied" | "forbidden" | "failed";
export interface ReceiptContext {
  readonly store: Conversations;
  readonly rest: Rest | undefined;
  readonly now: number;
  readonly warn: (message: string) => void;
}
export interface ClaimMessage {
  readonly message_id: string;
  readonly channel_id: string;
  readonly author_id: string;
  readonly role: string;
  readonly scope?: string;
  readonly channel_policy?: string;
  readonly discord_origin?: unknown;
  readonly pinged?: boolean;
  readonly entry?: ConversationEntry;
}

/** The only reaction writer. Durable claims are the target; Discord calls never hold a database transaction. */
export async function syncReceipts(o: ReceiptContext, force = true): Promise<ReadonlyMap<string, WorkingReaction>> {
  const results = new Map<string, WorkingReaction>();
  if (!o.rest) return results;
  for (const row of o.store.openWorkingRows()) {
    const desired = row.claimed_at !== null && row.closed_at === null;
    if (!desired && !row.reacted) continue;
    if (desired && row.reacted && !force) { results.set(row.message_id, "already"); continue; }
    const method = desired ? "PUT" : "DELETE";
    const path = "/channels/" + row.channel_id + "/messages/" + row.message_id + "/reactions/%F0%9F%91%80/@me";
    // A crash after either side of the PUT leaves enough state for the next reconciliation.
    if (desired) o.store.setReacted(row.message_id, true);
    try {
      await o.rest(path, { method, retryRateLimit: false });
      o.store.setReacted(row.message_id, desired);
      results.set(row.message_id, desired ? (row.reacted ? "already" : "added") : "skipped");
    } catch (error) {
      if (error instanceof IgnoredChannelError) {
        results.set(row.message_id, "skipped");
        continue;
      }
      if (error instanceof DiscordRestError && (error.status === 403 || error.status === 404)) {
        o.store.setReacted(row.message_id, error.status === 403 && row.reacted === 1);
        if (error.status === 404) o.store.closeWorking([row.message_id], o.now);
        results.set(row.message_id, error.status === 403 && desired ? "forbidden" : "skipped");
        continue;
      }
      if (!(error instanceof Error)) throw error;
      // Another finisher may have cleared the flag while this uncertain request was in flight.
      o.store.setReacted(row.message_id, true);
      o.warn("receipt " + method + " deferred message_id=" + row.message_id + ": " + error.message);
      results.set(row.message_id, "failed");
    }
  }
  return results;
}

export async function showWorking(o: ReceiptContext, message: ClaimMessage): Promise<WorkingReaction> {
  if (message.role === "BOT_BUG_REPORT" || message.scope === "evidence-only") return "skipped";
  if (message.entry) {
    o.store.claim(message.channel_id, message.author_id, message.entry, o.now,
      { channel: message.channel_id, audience: audienceOf(message as unknown as Record<string, unknown>) });
  }
  const row = o.store.claimWorking(message.channel_id, message.author_id, message.message_id, o.now);
  if (row.closed_at !== null) return "skipped-already-replied";
  return (await syncReceipts(o, false)).get(message.message_id) ?? "skipped";
}

/** Only explicit pings in DMs/trusted channels have already passed the decision to answer. */
export async function reactOnArrival(o: ReceiptContext, message: ClaimMessage): Promise<boolean> {
  if (message.role === "BOT_BUG_REPORT" || message.channel_policy !== "trusted" || !message.pinged) return false;
  return await showWorking(o, message) === "added";
}

export async function finishWorking(o: ReceiptContext, ids: readonly string[]): Promise<void> {
  const anchors: string[] = [];
  for (const id of ids) {
    const row = o.store.working(id);
    if (!row) continue;
    const anchor = o.store.workingAnchor(row.channel_id, row.user_id, id);
    if (anchor) anchors.push(anchor);
  }
  o.store.closeWorking([...ids, ...anchors], o.now);
  await syncReceipts(o, false);
}

/** Startup/upkeep repairs interrupted adds/removals and abandons claims without consuming deliveries. */
export async function sweepWorking(o: ReceiptContext & { readonly delivery: Delivery }): Promise<void> {
  for (const row of o.store.openWorkingRows()) {
    if (row.closed_at !== null) continue;
    let disposition: string;
    try { disposition = o.delivery.status("inbound", row.message_id).disposition; }
    catch (error) { if (!(error instanceof RangeError)) throw error; disposition = "unknown"; }
    if (disposition !== "pending" && disposition !== "accepted") {
      o.store.closeWorking([row.message_id], o.now);
      continue;
    }
    if (row.claimed_at === null) continue;
    const age = o.now - row.claimed_at;
    if (age >= WORKING_ABANDON_MS) {
      o.store.closeWorking([row.message_id], o.now);
      o.warn("message_id=" + row.message_id + " channel=" + row.channel_id + " claimed for 2 hours without a reply; claim finished. Reply, or run ack done/irrelevant");
    } else if (!row.warned && age >= WORKING_WINDOW_MS) {
      o.store.markWarned(row.message_id);
      o.warn("message_id=" + row.message_id + " channel=" + row.channel_id + " claimed for 30 minutes without a reply. Reply, or run ack done/irrelevant");
    }
  }
  await syncReceipts(o);
  o.store.pruneWorking(o.now);
}
