import type { Conversation, Conversations, ConversationEntry } from "./conversations.ts";
import { audienceOf, conversationEntry } from "./conversation-context.ts";
import type { Delivery } from "../delivery/delivery.ts";
import { DiscordRestError, IgnoredChannelError, type Rest } from "../discord/rest.ts";
import { finishWorking } from "./working.ts";
import { snowflakeTime } from "./working-store.ts";
import { issueUrls, recordDiscussion } from "./issue-review.ts";
import { RecoveryRequiredError } from "../delivery/recovery-store.ts";
import { ReplySettlements, type ReplyMeaning } from "./reply-settlement.ts";

const gone = (error: unknown) => error instanceof DiscordRestError && error.status === 404;

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

type Payload = Partial<NewerMessage> & { channel_id?: string; reply_to?: string; attachments?: unknown[]; embed_text?: string; for_owner?: boolean };
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
  | { readonly action: "send"; readonly leftover: readonly string[]; readonly author_id?: string }
  | { readonly action: "hold"; readonly newer: readonly NewerMessage[]; readonly edited?: string }
  | { readonly action: "withhold"; readonly reason: string }
  | { readonly action: "skip"; readonly reason: string; readonly gone?: true };

/**
 * Before a reply goes out: skip it if the original was deleted, and hold it (at most twice within two
 * minutes) when the original was edited or newer messages in the channel are unaccounted for.
 * `known` lists message IDs the reply covers or has reviewed; listing the target acknowledges an edit.
 */
export async function checkBeforeReply(options: {
  readonly delivery: Delivery; readonly store: Conversations; readonly rest: Rest;
  readonly channel: string; readonly target: string; readonly known: ReadonlySet<string>; readonly now: number;
  readonly warn: (message: string) => void; readonly owner?: string;
}): Promise<ReplyCheck> {
  const { delivery, store, rest, channel, target, known, now, warn, owner } = options;
  const staged = delivery.pending("inbound").find((item) => item.id === target);
  const payload = staged ? JSON.parse(staged.payload) as Payload : undefined;
  if (staged) {
    try { delivery.recovery.requireReviewed(target, staged.payload); }
    catch (error) {
      if (!(error instanceof RecoveryRequiredError)) throw error;
      return { action: "withhold", reason: error.message };
    }
    const priorReply = delivery.recovery.priorReply(target);
    if (priorReply) {
      return { action: "skip", reason: `this recovered message already has reply ${priorReply}; continue durable work separately` };
    }
  }
  let edited: string | undefined;
  let author_id: string | undefined;
  try {
    const current = await rest<{ content: string; author?: { id: string } }>(`/channels/${channel}/messages/${target}`);
    author_id = current.author?.id;
    if (payload?.author_id && author_id && payload.author_id !== author_id) {
      return { action: "withhold", reason: "Original author does not match the saved source" };
    }
    if (payload && !known.has(target) && typeof payload.content === "string" && current.content !== payload.content) {
      edited = clip(current.content, 1500);
    }
  } catch (error) {
    if (error instanceof IgnoredChannelError) return { action: "withhold", reason: error.message };
    if (gone(error)) return { action: "skip", reason: "the original message was deleted", gone: true };
    if (!(error instanceof Error)) throw error;
    warn(`could not re-read message_id=${target}; reply retained pending: ${error.message}`);
    return { action: "withhold", reason: "Current source message is unavailable; inspect before retrying." };
  }
  // Answering for the owner: once the owner has spoken in the channel since, the answer is theirs.
  if (payload?.for_owner === true && owner) {
    try {
      const later = await rest<{ author?: { id?: string } }[]>(`/channels/${channel}/messages?after=${target}&limit=50`);
      if (later.some((message) => message.author?.id === owner)) return { action: "skip", reason: "the owner already answered" };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      warn(`could not check whether the owner answered message_id=${target}: ${error.message}`);
      return { action: "withhold", reason: "Cannot verify whether the owner already answered; retained pending." };
    }
  }
  const newer = newerPending(delivery, channel, target, known);
  if (!newer.length && edited === undefined) return { action: "send", leftover: [], ...(author_id ? { author_id } : {}) };
  if (store.holdReply(channel, payload?.author_id ?? "", target, now)) {
    return { action: "hold", newer, ...(edited !== undefined ? { edited } : {}) };
  }
  return { action: "send", leftover: newer.map((message) => message.message_id), ...(author_id ? { author_id } : {}) };
}

const HELD_HINT = "REPLY_HELD_HINT Nothing was sent. Fold in the same person's additions, mention others only if directly related, " +
  "then resend with --covers <IDs this reply answers> and --seen <IDs reviewed and left as their own turns>; " +
  "add the original message ID to --seen to accept its edit.";

/**
 * The full reply step. Exit codes: 0 sent, 3 held for newer messages or an edit, 4 skipped (original deleted,
 * or the owner already answered a message addressed to them).
 * After sending, covered messages are marked handled, and the working windows of everyone answered close,
 * removing Helio's 👀.
 */
export async function guardedReply(o: {
  readonly delivery: Delivery; readonly store: Conversations; readonly rest: Rest;
  readonly channel: string; readonly target: string;
  readonly covers: readonly string[]; readonly seen: readonly string[];
  /** Sends the reply; `lead` holds mention tokens the text lacks, so the named people are actually pinged. */
  readonly send: (mentionUsers: readonly string[], lead: string) => Promise<string>;
  readonly text?: string;
  /** Continue this topic: needed for a candidate or a topic picked up from another channel. */
  readonly topic?: string;
  /** Tells participants elsewhere that the topic closed; one templated note per channel, idempotent. */
  readonly notifyOthers?: (row: Conversation, others: readonly { readonly channel: string; readonly target: string; readonly users: readonly string[] }[]) =>
    Promise<readonly string[]>;
  readonly cleanup: (messageId: string) => Promise<void>;
  readonly replyEntry?: Omit<ConversationEntry, "message_id" | "sent_at">;
  readonly now: () => number; readonly warn: (message: string) => void; readonly owner?: string;
  readonly issues?: { readonly text: string; readonly path: string };
  readonly settlement?: { readonly path: string; readonly event: string; readonly meaning: ReplyMeaning };
}): Promise<{ readonly code: 0 | 3 | 4; readonly lines: readonly string[] }> {
  const settlements = o.settlement ? new ReplySettlements(o.settlement.path) : undefined;
  const settlementKey = o.settlement ? `${o.channel}:${o.target}:${o.settlement.event}` : undefined;
  try {
  if (settlements && settlementKey) {
    const recovered = settlements.recover(settlementKey, o.store, o.now());
    if (recovered) {
      // A crash after the send left its participation unrecorded; recording is idempotent.
      const pendingNow = new Map(o.delivery.pending("inbound").map((item) => [item.id, JSON.parse(item.payload) as Payload]));
      for (const item of answered(o, pendingNow, [o.target, ...o.covers].filter(id => pendingNow.get(id)?.channel_id === o.channel))) {
        o.store.recordAnswered(item.row, item.entry, item.placement, item.via, o.now());
      }
      const resolved = o.settlement?.meaning.disposition === "final" ? o.store.topicOfMessage(o.target, o.now()) : null;
      return { code: 0, lines: [`REPLY_SETTLED ${recovered.join(",")}; existing delivery retained`,
        ...await closeElsewhere(o, resolved ? [resolved.anchor_message_id] : [])] };
    }
  }
  const known = new Set([...o.covers, ...o.seen]);
  const check = await checkBeforeReply({ ...o, known, now: o.now() });
  if (check.action === "withhold") {
    return { code: 3, lines: [`REPLY_WITHHELD message_id=${o.target}: ${check.reason}; nothing was sent.`] };
  }
  if (check.action === "skip") {
    await finishWorking({ store: o.store, rest: o.rest, now: o.now(), warn: o.warn }, [o.target]);
    if (check.gone) {
      for (const row of o.store.list().filter((row) => row.channel_id === o.channel && row.anchor_message_id === o.target)) {
        o.store.resolveIfCurrent(row, "other", o.now());
      }
    }
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
  const targetAuthor = pending.get(o.target)?.author_id ?? o.store.working(o.target)?.user_id ?? check.author_id;
  const authorOf = (id: string) => pending.get(id)?.author_id ?? o.store.working(id)?.user_id ?? (id === o.target ? targetAuthor : undefined);
  const claimed = [o.target, ...covered].some((id) => o.store.working(id)?.claimed_at != null);
  const now = o.now();
  if (o.topic && !o.store.topic(o.topic)) {
    return { code: 3, lines: [`REPLY_WITHHELD message_id=${o.target}: unknown topic ${o.topic}; nothing was sent.`] };
  }
  const joining = answered(o, pending, [o.target, ...covered]);
  const found = new Map<string, Conversation>();
  for (const id of [o.target, ...covered]) {
    const author = authorOf(id);
    const row = topicFor(o, author, pending.get(id));
    if (row) found.set(row.anchor_message_id, row);
  }
  const topics = [...found.values()];
  const final = o.settlement?.meaning.disposition === "final";
  const coveredAuthors = covered.map(authorOf).filter((id): id is string => !!id && id !== targetAuthor);
  const here = final ? topics.flatMap(row => o.store.participants(row.anchor_message_id))
    .filter(person => person.notify && person.last_channel_id === o.channel && person.user_id !== targetAuthor).map(person => person.user_id) : [];
  const mentions = [...new Set([...coveredAuthors, ...here])].slice(0, 100);
  const lead = mentions.filter(user => !(o.text ?? "").includes(`<@${user}>`)).map(user => `<@${user}>`).join(" ");
  if (settlements && settlementKey && o.settlement) {
    settlements.prepare(settlementKey, topics.map(row => ({ ...row, covered: [o.target, ...covered],
      reply_channel: o.channel, ...(targetAuthor ? { asked_user: targetAuthor } : {}), asked_message: o.target })),
    o.settlement.meaning, [{ target: o.target, event: `${o.channel}:${o.settlement.event}` }]);
  }
  const replyId = await o.send(mentions, lead);
  const lines = [`SENT ${replyId}`];
  // Only a delivered topic reply adds the people it answered or covered.
  for (const item of joining) o.store.recordAnswered(item.row, item.entry, item.placement, item.via, o.now());
  if (o.replyEntry) {
    for (const conversation of topics) {
      o.store.append(conversation.channel_id, conversation.user_id, {
        ...o.replyEntry, reply_to: conversation.anchor_message_id, message_id: replyId, sent_at: new Date(o.now()).toISOString(),
      }, o.now(), { channel: o.channel, audience: audienceOf((pending.get(o.target) ?? {}) as Record<string, unknown>) });
    }
  }
  if (o.issues) {
    const named = issueUrls(o.issues.text);
    const issues = new Set(named);
    for (const conversation of topics) {
      const issue = conversation.issue ?? o.settlement?.meaning.issue;
      if (!issue) continue;
      issues.add(issue);
    }
    const discussedAt = Math.floor(Math.max(...[o.target, ...covered].map(snowflakeTime)) / 1000);
    for (const issue of issues) {
      try {
        if (recordDiscussion(o.issues.path, issue, discussedAt)) {
          lines.push(`ISSUE_REVIEW_DUE issue=${issue} read="helio issue show ${issue.split("/").at(-1)}"`);
        }
      } catch (error) { o.warn(`issue review for ${issue} not recorded: ${String(error)}`); }
    }
  }
  if (settlements && settlementKey) {
    settlements.delivered(settlementKey);
    lines.push(`REPLY_SETTLED ${settlements.settle(settlementKey, o.store, o.now()).join(",")}`);
  }
  if (final) lines.push(...await closeElsewhere(o, topics.map(row => row.anchor_message_id)));
  for (const id of covered) {
    try { o.delivery.acknowledge("inbound", id); await o.cleanup(id); }
    catch (error) { o.warn(`could not mark covered message_id=${id} handled: ${String(error)}`); }
  }
  await finishWorking({ store: o.store, rest: o.rest, now: o.now(), warn: o.warn }, [o.target, ...covered]);
  if (covered.length) lines.push(`REPLY_COVERED ${covered.join(",")}`);
  if (notCovered.length) lines.push(`REPLY_NOTE not marked handled (not pending in this channel): ${notCovered.join(",")}`);
  if (check.leftover.length) lines.push(`REPLY_NOTE newer messages left as their own turns: ${check.leftover.join(",")}`);
  if (!claimed) lines.push("REPLY_NOTE no claim was recorded for this turn; run ack working first when you pick a turn up");
  return { code: 0, lines };
  } finally { settlements?.close(); }
}

type GuardOptions = Parameters<typeof guardedReply>[0];

/** The topic a message belongs to: the named topic (any retained state), else its reply edge or continuation. */
function topicFor(o: Pick<GuardOptions, "store" | "channel" | "topic">, author: string | undefined, payload: Payload | undefined): Conversation | null {
  if (o.topic) return o.store.topic(o.topic);
  return author ? o.store.forReply(o.channel, author, typeof payload?.reply_to === "string" ? payload.reply_to : undefined) : null;
}

/** Messages a topic reply answers or covers, with the entry and placement each will be recorded with. */
function answered(o: Pick<GuardOptions, "store" | "channel" | "topic" | "target" | "settlement">, pending: ReadonlyMap<string, Payload>,
  ids: readonly string[]) {
  if (!o.settlement) return [];
  return ids.flatMap(id => {
    const payload = pending.get(id);
    if (!payload || typeof payload.content !== "string" || typeof payload.author_id !== "string") return [];
    const row = topicFor(o, payload.author_id, payload);
    if (!row) return [];
    return [{ row, entry: conversationEntry({ ...payload, message_id: id }), via: id === o.target ? "answered" as const : "covered" as const,
      placement: { channel: o.channel, audience: audienceOf(payload as Record<string, unknown>) } }];
  });
}

/** Participants who last spoke on a closed topic in another channel get one templated note there. */
async function closeElsewhere(o: Pick<Parameters<typeof guardedReply>[0], "store" | "channel" | "notifyOthers">,
  anchors: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  if (!o.notifyOthers) return lines;
  for (const anchor of anchors) {
    const row = o.store.topic(anchor);
    if (!row) continue;
    const groups = o.store.closureGroups(anchor, o.channel).filter(group => group.users.length);
    if (!groups.length) continue;
    try { lines.push(...await o.notifyOthers(row, groups)); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      lines.push(`REPLY_CLOSURE_PENDING topic=${anchor}: ${error.message}; rerun this reply command to finish the notes`);
    }
  }
  return lines;
}
