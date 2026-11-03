import type { Conversations, Working } from "./conversations.ts";
import { WORKING_WINDOW_MS } from "./conversations.ts";
import type { Delivery } from "./delivery.ts";
import { DiscordRestError, type Rest } from "./rest.ts";

const EYES = "%F0%9F%91%80";
export const WORKING_ABANDON_MS = 2 * 60 * 60 * 1000;
const eyes = (channel: string, message: string) => `/channels/${channel}/messages/${message}/reactions/${EYES}/@me`;
const gone = (error: unknown) => error instanceof DiscordRestError && error.status === 404;

export async function addEyes(rest: Rest, channel: string, message: string): Promise<void> {
  await rest(eyes(channel, message), { method: "PUT" });
}

/** A deleted message or an already-removed reaction counts as removed. */
export async function removeEyes(rest: Rest, channel: string, message: string): Promise<void> {
  try { await rest(eyes(channel, message), { method: "DELETE" }); }
  catch (error) { if (!gone(error)) throw error; }
}

/**
 * DMs and the trusted chat answer every eligible human ping, and a person in an open conversation is almost
 * always answered, so the 👀 goes on as soon as such a message arrives instead of waiting for the lead to
 * remember it. Other unpinged messages need a relevance decision first (`ack working`).
 */
export async function reactOnArrival(
  store: Conversations, rest: Rest,
  message: { readonly message_id: string; readonly channel_id: string; readonly author_id: string;
    readonly channel_policy: string; readonly attention: string; readonly role: string; readonly addition_to?: string },
  warn: (message: string) => void,
  inConversation = false,
): Promise<boolean> {
  if (message.role === "BOT_BUG_REPORT" || message.addition_to !== undefined) return false;
  const ping = message.channel_policy === "trusted" && message.attention === "direct";
  if (!ping && !inConversation) return false;
  const row = inConversation ? store.ensureWorking(message.channel_id, message.author_id, message.message_id)
    : store.working(message.message_id);
  if (!row || row.closed_at !== null || row.reacted) return false;
  store.setReacted(message.message_id, true);
  try {
    await addEyes(rest, message.channel_id, message.message_id);
    return true;
  } catch (error) {
    store.setReacted(message.message_id, false);
    warn(`could not add 👀 to message_id=${message.message_id}; continuing without it: ${String(error)}`);
    return false;
  }
}

export async function finishWorking(
  store: Conversations, rest: Rest | undefined, ids: readonly string[], now: number, warn: (message: string) => void,
): Promise<void> {
  for (const row of store.closeWorking(ids, now)) await unreact(store, rest, row, warn);
}

async function unreact(store: Conversations, rest: Rest | undefined, row: Working, warn: (message: string) => void) {
  if (!rest) return;
  try {
    await removeEyes(rest, row.channel_id, row.message_id);
    store.setReacted(row.message_id, false);
  } catch (error) {
    warn(`could not remove 👀 from message_id=${row.message_id}; retrying later: ${String(error)}`);
  }
}

/**
 * Startup and periodic upkeep: closes windows whose message is already handled, retries pending 👀 removals,
 * warns once when Helio has shown 👀 for 30 minutes without replying, and gives up on it after 2 hours.
 */
export async function sweepWorking(
  store: Conversations, delivery: Delivery, rest: Rest | undefined, now: number,
  warn: (message: string) => void,
): Promise<void> {
  for (const row of store.openWorkingRows()) {
    if (row.closed_at !== null) { await unreact(store, rest, row, warn); continue; }
    let disposition: string;
    try { disposition = delivery.status("inbound", row.message_id).disposition; }
    catch { disposition = "unknown"; }
    const age = now - row.started_at;
    if (disposition !== "pending" && disposition !== "accepted") {
      await finishWorking(store, rest, [row.message_id], now, warn);
    } else if (row.reacted && age >= WORKING_ABANDON_MS) {
      warn(`message_id=${row.message_id} channel=${row.channel_id} showed 👀 for 2 hours without a reply; removed it. Reply, or run ack done/irrelevant`);
      await finishWorking(store, rest, [row.message_id], now, warn);
    } else if (row.reacted && !row.warned && age >= WORKING_WINDOW_MS) {
      warn(`message_id=${row.message_id} channel=${row.channel_id} has shown 👀 for 30 minutes without a reply. Reply, or run ack done/irrelevant`);
      store.markWarned(row.message_id);
    }
  }
  store.pruneWorking(now);
}

export interface NewerMessage {
  readonly message_id: string;
  readonly author_id: string;
  readonly author: string;
  readonly role: string;
  readonly addition_to?: string;
  readonly content: string;
  readonly embed_text?: string;
  readonly attachments: number;
}

type Payload = Partial<NewerMessage> & { channel_id?: string; attachments?: unknown[]; embed_text?: string };
const clip = (text: string | undefined, max: number) => text && text.length > max ? `${text.slice(0, max)}…` : text;

export function newerPending(delivery: Delivery, channel: string, target: string, known: ReadonlySet<string>): NewerMessage[] {
  const out: NewerMessage[] = [];
  for (const item of delivery.pending("inbound")) {
    if (BigInt(item.id) <= BigInt(target) || known.has(item.id)) continue;
    const payload = JSON.parse(item.payload) as Payload;
    if (payload.channel_id !== channel || delivery.status("inbound", item.id).disposition !== "pending") continue;
    out.push({
      message_id: item.id, author_id: payload.author_id ?? "", author: payload.author ?? "", role: payload.role ?? "",
      ...(payload.addition_to ? { addition_to: payload.addition_to } : {}),
      content: clip(payload.content, 1500) ?? "",
      ...(payload.embed_text ? { embed_text: clip(payload.embed_text, 1000) } : {}),
      attachments: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
    });
  }
  return out;
}

export type ReplyCheck =
  | { readonly action: "send"; readonly leftover: readonly string[] }
  | { readonly action: "hold"; readonly newer: readonly NewerMessage[]; readonly edited?: string }
  | { readonly action: "skip"; readonly reason: string };

/**
 * Before a reply goes out: skip it if the original was deleted, and hold it (at most twice within two
 * minutes) when the original was edited or newer messages in the channel are unaccounted for.
 * `known` lists message IDs the reply covers or has reviewed; listing the target acknowledges an edit.
 */
export async function checkBeforeReply(options: {
  readonly delivery: Delivery; readonly store: Conversations; readonly rest: Rest;
  readonly channel: string; readonly target: string; readonly known: ReadonlySet<string>; readonly now: number;
  readonly warn: (message: string) => void;
}): Promise<ReplyCheck> {
  const { delivery, store, rest, channel, target, known, now, warn } = options;
  const staged = delivery.pending("inbound").find((item) => item.id === target);
  const payload = staged ? JSON.parse(staged.payload) as Payload : undefined;
  let edited: string | undefined;
  try {
    const current = await rest<{ content: string }>(`/channels/${channel}/messages/${target}`);
    if (payload && !known.has(target) && typeof payload.content === "string" && current.content !== payload.content) {
      edited = clip(current.content, 1500);
    }
  } catch (error) {
    if (gone(error)) return { action: "skip", reason: "the original message was deleted" };
    warn(`could not re-read message_id=${target} before replying; sending anyway: ${String(error)}`);
  }
  const newer = newerPending(delivery, channel, target, known);
  if (!newer.length && edited === undefined) return { action: "send", leftover: [] };
  if (store.holdReply(channel, payload?.author_id ?? "", target, now)) {
    return { action: "hold", newer, ...(edited !== undefined ? { edited } : {}) };
  }
  return { action: "send", leftover: newer.map((message) => message.message_id) };
}

const HELD_HINT = "REPLY_HELD_HINT Nothing was sent. Fold in the same person's additions, mention others only if directly related, " +
  "then resend with --covers <IDs this reply answers> and --seen <IDs reviewed and left as their own turns>; " +
  "add the original message ID to --seen to accept its edit.";

/**
 * The full reply step. Exit codes: 0 sent, 3 held for newer messages or an edit, 4 skipped (original deleted).
 * After sending, covered messages are marked handled, and the working windows of everyone answered close,
 * removing Helio's 👀.
 */
export async function guardedReply(o: {
  readonly delivery: Delivery; readonly store: Conversations; readonly rest: Rest;
  readonly channel: string; readonly target: string;
  readonly covers: readonly string[]; readonly seen: readonly string[];
  readonly send: (mentionUsers: readonly string[]) => Promise<string>;
  readonly cleanup: (messageId: string) => Promise<void>;
  readonly now: () => number; readonly warn: (message: string) => void;
}): Promise<{ readonly code: 0 | 3 | 4; readonly lines: readonly string[] }> {
  const known = new Set([...o.covers, ...o.seen]);
  const check = await checkBeforeReply({ ...o, known, now: o.now() });
  if (check.action === "skip") {
    await finishWorking(o.store, o.rest, [o.target], o.now(), o.warn);
    return { code: 4, lines: [`REPLY_SKIPPED message_id=${o.target}: ${check.reason}; nothing was sent. Run: ack done inbound ${o.target}`] };
  }
  if (check.action === "hold") {
    const held = { message_id: o.target, ...(check.edited !== undefined ? { edited_content: check.edited } : {}), newer: check.newer };
    return { code: 3, lines: [`REPLY_HELD ${JSON.stringify(held)}`, HELD_HINT] };
  }
  const pending = new Map(o.delivery.pending("inbound").map((item) => [item.id, JSON.parse(item.payload) as Payload]));
  const covered = [...new Set(o.covers)].filter((id) => id !== o.target && pending.get(id)?.channel_id === o.channel &&
    o.delivery.status("inbound", id).disposition === "pending");
  const notCovered = o.covers.filter((id) => id !== o.target && !covered.includes(id));
  const targetAuthor = pending.get(o.target)?.author_id ?? o.store.working(o.target)?.user_id;
  const authors = new Set(covered.map((id) => pending.get(id)?.author_id).filter((id): id is string => !!id));
  const mentions = [...authors].filter((id) => id !== targetAuthor);
  if (targetAuthor) authors.add(targetAuthor);
  const shown = [o.target, ...covered].some((id) => o.store.working(id)?.reacted) ||
    o.store.openWorkingRows().some((row) => row.reacted && row.channel_id === o.channel && authors.has(row.user_id));

  const lines = [`SENT ${await o.send(mentions)}`];
  for (const id of covered) {
    try { o.delivery.acknowledge("inbound", id); await o.cleanup(id); }
    catch (error) { o.warn(`could not mark covered message_id=${id} handled: ${String(error)}`); }
  }
  const windows = o.store.openWorkingRows()
    .filter((row) => row.closed_at === null && row.channel_id === o.channel && authors.has(row.user_id))
    .map((row) => row.message_id);
  await finishWorking(o.store, o.rest, [o.target, ...covered, ...windows], o.now(), o.warn);
  if (covered.length) lines.push(`REPLY_COVERED ${covered.join(",")}`);
  if (notCovered.length) lines.push(`REPLY_NOTE not marked handled (not pending in this channel): ${notCovered.join(",")}`);
  if (check.leftover.length) lines.push(`REPLY_NOTE newer messages left as their own turns: ${check.leftover.join(",")}`);
  if (!shown) lines.push("REPLY_NOTE no 👀 was shown for this turn; run ack working first when you pick a turn up");
  return { code: 0, lines };
}
