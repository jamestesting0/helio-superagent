import type { Conversations, ConversationEntry } from "./conversations.ts";

/** The delivery boundary already verified identity; transcript fields are parsed here once. */
export function conversationEntry(message: Readonly<Record<string, unknown>>): ConversationEntry {
  const { message_id, author_id, author, content, sent_at } = message;
  if (typeof message_id !== "string" || typeof author_id !== "string" ||
      typeof author !== "string" || typeof content !== "string" || typeof sent_at !== "string") {
    throw new TypeError("Claim lacks transcript identity or content");
  }
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const embeds = strings(message.embed_text), components = strings(message.component_text);
  return {
    message_id, author_id, author: author.slice(0, 100), bot: false, sent_at, content: content.slice(0, 10_000),
    attachment_count: Array.isArray(message.attachments) ? message.attachments.length : 0,
    ...(embeds.length ? { embed_text: embeds } : {}), ...(components.length ? { component_text: components } : {}),
    ...(content.length > 10_000 ? { content_truncated: true } : {}),
  };
}

export function conversationSnapshot(store: Conversations, channel: string, user: string, now: number) {
  const row = store.get(channel, user);
  const recent = store.recentlyResolved(channel, user, now);
  if (!row && !recent) return undefined;
  return {
    ...(row ? {
      topic: row.topic, summary: row.summary || row.topic, state: store.state(row),
      anchor_message_id: row.anchor_message_id, opened_at: new Date(row.opened_at).toISOString(),
      last_activity: row.last_activity, hold_reason: row.hold_reason,
      transcript: store.transcript(channel, user),
    } : { transcript: [] }),
    ...(recent ? { recently_resolved: {
      topic: recent.topic, summary: recent.summary || recent.topic, outcome: recent.outcome, issue: recent.issue,
      read: `helio conversation reopen ${channel} ${user}`,
    } } : {}),
    read_more: `helio conversation show ${channel} ${user}`,
  };
}
