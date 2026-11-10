import type { Audience, Conversation, Conversations, ConversationEntry, Placement } from "./conversations.ts";

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

/** Who may read a message: an owner/trusted DM, the trusted chat and its threads, or an untrusted chat. */
export function audienceOf(message: Readonly<Record<string, unknown>>): Audience {
  const origin = message.discord_origin && typeof message.discord_origin === "object" ? message.discord_origin as Record<string, unknown> : {};
  const guild = "guild_id" in message ? message.guild_id : origin.guild_id;
  if (guild === undefined || guild === null) return message.channel_policy === "normal" ? "public" : "dm";
  return message.channel_policy === "trusted" ? "staff" : "public";
}

/** How a new message relates to its conversation; a fresh ping may be a new topic for Helio to open. */
function relation(store: Conversations, row: Conversation, message: { readonly reply_to?: string; readonly pinged?: boolean }) {
  if (message.reply_to && store.belongs(row, message.reply_to)) return "reply";
  return message.pinged ? "new_ping" : "follow_up";
}

/**
 * A topic named by the message itself: a reply into a recently resolved topic or a Discord link to a recorded message
 * (explicit, readable without reopening), or a GitHub link to an issue an active topic tracks (a candidate).
 */
function linkedTopic(store: Conversations, message: { readonly reply_to?: string; readonly content?: string }, now: number) {
  const resolved = message.reply_to ? store.topicOfMessage(message.reply_to, now) : null;
  if (resolved) return { row: resolved, via: "reply" as const };
  for (const match of (message.content ?? "").matchAll(/discord(?:app)?\.com\/channels\/(?:@me|\d+)\/\d+\/(\d+)/g)) {
    const row = store.topicOfMessage(match[1]!, now);
    if (row) return { row, via: "message_link" as const };
  }
  for (const match of (message.content ?? "").matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*/g)) {
    const row = store.list().find(topic => topic.issue === match[0]);
    if (row) return { row, via: "issue_link" as const };
  }
  return undefined;
}

/** A short view of another topic: never its transcript, only what every participant may see. */
function summary(store: Conversations, row: Conversation) {
  const people = store.participants(row.anchor_message_id);
  return { topic_id: row.anchor_message_id, title: row.topic, state: store.state(row), issue: row.issue,
    waiting_on_user: store.state(row) === "waiting_on_requester" ? row.waiting_on_user ?? row.user_id : null,
    participants: people.map(person => person.user_id),
    places: [...new Set([row.channel_id, ...people.map(person => person.last_channel_id)])] };
}

/**
 * What Helio needs to continue a topic. The binding is explicit for a reply into a topic or an answer Helio's
 * question waits on; an unthreaded continuation is a candidate. A newcomer joins only when Helio's topic reply
 * answers or covers them. Transcript text is limited to what this place's audience may see.
 */
export function conversationSnapshot(store: Conversations, channel: string, user: string, now: number,
  message?: { readonly reply_to?: string; readonly pinged?: boolean; readonly content?: string }, viewer: Placement = { channel, audience: "public" }) {
  const continued = message ? store.forReply(channel, user, message.reply_to) : store.get(channel, user);
  const linked = continued ? undefined : message && linkedTopic(store, message, now);
  const row = continued ?? linked?.row ?? null;
  const recent = store.recentlyResolved(channel, user, now);
  const others = store.topicsFor(user).filter(other => other.anchor_message_id !== row?.anchor_message_id);
  if (!row && !recent && !others.length) return undefined;
  const awaited = row && store.state(row) === "waiting_on_requester" && (row.waiting_on_user ?? row.user_id) === user &&
    (row.question_channel_id ?? row.channel_id) === channel;
  const via = !row ? undefined : linked ? linked.via : message?.reply_to ? "reply" : awaited ? "answer" : "continuation";
  return {
    ...(row ? {
      request: row.request, decided: row.decided, waiting_on: row.waiting_on, result: row.result,
      job: row.job, issue: row.issue, revision: row.revision, reply_disposition: row.reply_disposition,
      ...(message ? { relation: relation(store, row, message) } : {}),
      ...(message ? { topic_binding: via === "continuation" || via === "issue_link" ? "candidate" : "explicit", binding_via: via } : {}),
      joins_on_reply: !store.isParticipant(row.anchor_message_id, user),
      topic_id: row.anchor_message_id, topic: row.topic, summary: row.summary || row.topic, state: store.state(row),
      anchor_message_id: row.anchor_message_id, opened_at: new Date(row.opened_at).toISOString(),
      last_activity: row.last_activity, hold_reason: row.hold_reason,
      participants: summary(store, row).participants, places: summary(store, row).places,
      transcript: store.transcriptOf(row, viewer),
    } : { transcript: [] }),
    ...(others.length ? { other_topics: others.map(other => summary(store, other)) } : {}),
    ...(recent ? { recently_resolved: {
      topic_id: recent.anchor_message_id, topic: recent.topic, summary: recent.summary || recent.topic, outcome: recent.outcome, issue: recent.issue,
      read: `helio conversation reopen ${recent.anchor_message_id}`,
    } } : {}),
    read_more: row ? `helio conversation show ${row.anchor_message_id}` : `helio conversation list --user ${user}`,
  };
}
