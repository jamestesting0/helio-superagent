import type { Conversation, Conversations, ConversationEntry } from "./conversations.ts";

/** The delivery boundary already verified identity; transcript fields are parsed here once. */
export function conversationEntry(message: Readonly<Record<string, unknown>>): ConversationEntry {
  const { message_id, author_id, author, content, sent_at, reply_to } = message;
  if (typeof message_id !== "string" || typeof author_id !== "string" ||
      typeof author !== "string" || typeof content !== "string" || typeof sent_at !== "string") {
    throw new TypeError("Claim lacks transcript identity or content");
  }
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const embeds = strings(message.embed_text), components = strings(message.component_text);
  return {
    message_id, author_id, author: author.slice(0, 100), bot: false, sent_at, content: content.slice(0, 10_000),
    ...(typeof reply_to === "string" ? { reply_to } : {}),
    attachment_count: Array.isArray(message.attachments) ? message.attachments.length : 0,
    ...(embeds.length ? { embed_text: embeds } : {}), ...(components.length ? { component_text: components } : {}),
    ...(content.length > 10_000 ? { content_truncated: true } : {}),
  };
}

/** How a new message relates to its conversation; a fresh ping may be a new topic for Helio to open. */
function relation(store: Conversations, row: Conversation, message: { readonly reply_to?: string; readonly pinged?: boolean }) {
  if (message.reply_to && store.belongs(row, message.reply_to)) return "reply";
  return message.pinged ? "new_ping" : "follow_up";
}

export function conversationSnapshot(store: Conversations, channel: string, user: string, now: number,
  message?: { readonly reply_to?: string; readonly pinged?: boolean }) {
  const row = message ? store.forReply(channel, user, message.reply_to) : store.get(channel, user);
  const recent = store.recentlyResolved(channel, user, now);
  if (!row && !recent) return undefined;
  return {
    ...(row ? {
      request: row.request, decided: row.decided, waiting_on: row.waiting_on, result: row.result,
      job: row.job, issue: row.issue, revision: row.revision, reply_disposition: row.reply_disposition,
      ...(message ? { relation: relation(store, row, message) } : {}),
      ...(message ? { topic_binding: relation(store, row, message) === "reply" ? "explicit" : "candidate" } : {}),
      topic: row.topic, summary: row.summary || row.topic, state: store.state(row),
      anchor_message_id: row.anchor_message_id, opened_at: new Date(row.opened_at).toISOString(),
      last_activity: row.last_activity, hold_reason: row.hold_reason,
      transcript: store.transcriptOf(row),
    } : { transcript: [] }),
    ...(recent ? { recently_resolved: {
      topic: recent.topic, summary: recent.summary || recent.topic, outcome: recent.outcome, issue: recent.issue,
      read: `helio conversation reopen ${channel} ${user}`,
    } } : {}),
    read_more: `helio conversation show ${channel} ${user}${row ? ` --topic ${row.anchor_message_id}` : ""}`,
  };
}
