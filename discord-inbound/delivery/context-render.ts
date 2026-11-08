import { object } from "./monitor-summary.ts";
import { messageUrl, referenceLink } from "../messages/references.ts";

export const SECTION_NAMES = ["turn", "conversation", "channel_since_last_claim", "reply_chain", "preceding"] as const;
export type SectionName = typeof SECTION_NAMES[number];

function boundedEntry(entry: Record<string, unknown>, budget: number) {
  const result: Record<string, unknown> = { ...entry, truncated: entry.truncated === true || entry.content_truncated === true };
  let size = JSON.stringify(result).length;
  // Old stored messages can contain arbitrarily large strings, arrays and nested attachments.
  while (size > budget) {
    const keys = Object.keys(result).filter((key) => key !== "message_id" && key !== "truncated" && key !== "read_more");
    const key = keys.sort((a, b) => (JSON.stringify(result[b])?.length ?? 0) - (JSON.stringify(result[a])?.length ?? 0))[0];
    if (!key) break;
    const value = result[key];
    result.truncated = true;
    if (typeof value === "string" && value.length > 32 && !["message_url", "author_reference"].includes(key)) {
      result[key] = value.slice(0, Math.max(0, value.length - Math.max(32, size - budget)));
    } else if (Array.isArray(value) && value.length > 1) {
      result[key] = value.slice(0, -1);
    } else {
      delete result[key];
    }
    size = JSON.stringify(result).length;
  }
  return result;
}

function section(entries: readonly Record<string, unknown>[], options: {
  readonly budget: number; readonly limit: number; readonly each?: number; readonly read: string;
}) {
  const messages: Record<string, unknown>[] = [];
  const result = { messages, truncated: false, read_more: options.read };
  const selected = entries.slice(-options.limit);
  result.truncated = selected.length < entries.length;
  for (const [index, entry] of selected.entries()) {
    const remaining = options.budget - JSON.stringify(result).length - 2;
    if (remaining < 180) { result.truncated = true; break; }
    const rendered = boundedEntry(entry, Math.min(options.each ?? Math.floor(remaining / (selected.length - index)), remaining));
    result.messages.push(rendered);
    if (rendered.truncated) result.truncated = true;
  }
  return result;
}

const entries = (value: unknown) => Array.isArray(value) ? value.map(object) : [];

/** Build sections once per turn, including legacy payloads with repeated inline context. */
export function contextSections(messages: readonly Record<string, unknown>[]) {
  const last = messages.at(-1);
  if (!last) throw new RangeError("No authorized messages to render");
  const origin = last.discord_origin ? object(last.discord_origin) : {};
  const guild = typeof origin.guild_id === "string" ? origin.guild_id : origin.guild_id === null ? "@me" :
    typeof last.guild_id === "string" ? last.guild_id : undefined;
  const withReferences = (entry: Record<string, unknown>): Record<string, unknown> => ({
    ...entry,
    ...(guild !== undefined && /^(?:@me|\d{1,30})$/.test(guild) && typeof last.channel_id === "string" &&
      /^\d{1,30}$/.test(last.channel_id) && typeof entry.message_id === "string" && /^\d{1,30}$/.test(entry.message_id) ?
      { message_url: messageUrl(guild, last.channel_id, entry.message_id) } : {}),
    ...(typeof entry.author_id === "string" && /^\d{1,30}$/.test(entry.author_id) && typeof entry.author === "string" ?
      { author_reference: referenceLink({ kind: "user", id: entry.author_id, label: entry.author }) } : {}),
    ...(entry.mentioned_users ? { user_references: Object.fromEntries(Object.entries(object(entry.mentioned_users))
      .filter((pair): pair is [string, string] => /^\d{1,30}$/.test(pair[0]) && typeof pair[1] === "string")
      .map(([id, label]) => [id, referenceLink({ kind: "user", id, label })])) } : {}),
  });
  const conversation = last.conversation ? object(last.conversation) : {};
  const transcript = entries(conversation.transcript).map(withReferences);
  const lastEntry = transcript.at(-1);
  const activity = typeof conversation.last_activity === "number" ? conversation.last_activity :
    typeof lastEntry?.sent_at === "string" ? Date.parse(lastEntry.sent_at) :
    typeof conversation.opened_at === "string" ? Date.parse(conversation.opened_at) : undefined;
  const recent = entries(conversation.recent).map(withReferences).filter((entry) =>
    typeof lastEntry?.message_id !== "string" || typeof entry.message_id !== "string" ||
    BigInt(entry.message_id) > BigInt(lastEntry.message_id));
  const chain = messages.flatMap((message) => {
    const reply = message.reply_context ? object(message.reply_context) : {};
    const all = entries(reply.messages);
    return message.channel_policy === "normal" ? all.slice(-1) : all;
  });
  const unique = [...new Map(chain.map((entry) => [entry.message_id, entry])).values()].map(withReferences);
  const turn = messages.map((message) => Object.fromEntries(Object.entries(message)
    .filter(([key]) => !["conversation", "reply_context", "preceding", "turn", "discord_origin", "preparation_complete"].includes(key)))).map(withReferences);
  const preceding = messages.flatMap((message) => entries(message.preceding)).map(withReferences);
  return {
    turn,
    conversation: [{
      request: conversation.request, decided: conversation.decided, waiting_on: conversation.waiting_on, result: conversation.result,
      relation: conversation.relation,
      topic: conversation.topic, summary: conversation.summary ?? conversation.topic, state: conversation.state,
      hold_reason: conversation.hold_reason, recently_resolved: conversation.recently_resolved,
      anchor_message_id: conversation.anchor_message_id, opened_at: conversation.opened_at,
      idle_ms: activity === undefined ? undefined : Math.max(0, Date.now() - activity),
      earlier_entries: Math.max(Number(conversation.earlier_entries) || 0, transcript.length - 6, 0), transcript,
      read_more: conversation.read_more,
    }],
    channel_since_last_claim: recent,
    reply_chain: unique,
    preceding,
  };
}

export function renderTurn(messages: readonly Record<string, unknown>[]): string {
  const sections = contextSections(messages);
  const last = messages.at(-1);
  if (!last) throw new RangeError("No authorized messages to render");
  const ids = messages.map((message) => message.message_id).join(",");
  const command = `ack show inbound ${ids}`;
  const read = (name: SectionName) => `${command} --section ${name} --offset 0`;
  const conversation = sections.conversation[0];
  const transcript = entries(conversation?.transcript);
  const conversationSection = section(transcript, { budget: 2400, limit: 6, read: read("conversation") });
  const conversationData = boundedEntry({ ...conversation, transcript: conversationSection.messages,
    truncated: conversationSection.truncated || Number(conversation?.earlier_entries) > 0,
    read_more: read("conversation"), show: conversation?.read_more }, 4000);
  const statuses = messages.flatMap((message) => {
    const context = message.reply_context ? object(message.reply_context) : {};
    return typeof context.status === "string" ? [{ message_id: message.message_id, status: context.status.slice(0, 100) }] : [];
  });
  const reply = {
    ...section(sections.reply_chain, {
      budget: 5960 - JSON.stringify(statuses).length,
      limit: last.channel_policy === "normal" ? 1 : 6, read: read("reply_chain"),
    }),
    source_statuses: statuses,
  };
  if (statuses.some((item) => item.status !== "complete" && item.status !== "parent_only")) reply.truncated = true;
  const result = {
    channel_id: last.channel_id, message_ids: messages.map((message) => message.message_id),
    reply_to: last.message_id,
    turn: section(sections.turn, { budget: 8000, limit: 10, read: read("turn") }),
    conversation: conversationData,
    channel_since_last_claim: section(sections.channel_since_last_claim, { budget: 2000, limit: 5, each: 380, read: read("channel_since_last_claim") }),
    reply_chain: reply,
    preceding: section(sections.preceding, { budget: 1500, limit: 5, each: 280, read: read("preceding") }),
  };
  let text = JSON.stringify(result);
  for (const name of ["preceding", "channel_since_last_claim", "reply_chain"] as const) {
    while (text.length > 19_990 && result[name].messages.length) {
      result[name].messages.shift();
      result[name].truncated = true;
      text = JSON.stringify(result);
    }
  }
  return `ACK_TURN ${text}`;
}

/** Detail pages retain the complete stored section; offset is a character offset in its JSON. */
export function detailPage(value: unknown, command: string, offset = 0): string {
  const full = JSON.stringify(value);
  const content = full.slice(offset, offset + 6000);
  const next = offset + content.length;
  return JSON.stringify({
    offset, content, truncated: next < full.length,
    read_more: next < full.length ? `${command} --offset ${next}` : null,
  });
}
