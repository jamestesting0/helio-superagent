import type { Turn } from "../intake/turns.ts";

export const monitorLine = (line: string): string => line.replace(/[\r\n]/g, " ").slice(0, 1000);

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a stored message object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** Shrink display strings, never the IDs or command needed to retrieve the record. */
function summary(prefix: string, values: Readonly<Record<string, unknown>>): string {
  const fields = { ...values };
  for (const key of ["preview", "conversation", "author"]) {
    if (typeof fields[key] === "string") fields[key] = fields[key].slice(0, 200);
  }
  let line = `${prefix} ${JSON.stringify(fields)}`;
  for (const key of ["preview", "conversation", "author"]) {
    while (line.length > 1000 && typeof fields[key] === "string" && fields[key].length) {
      fields[key] = fields[key].slice(0, Math.max(0, fields[key].length - 20));
      line = `${prefix} ${JSON.stringify(fields)}`;
    }
  }
  if (line.length > 1000) throw new RangeError("Turn identity exceeds the monitor summary budget");
  return line;
}

export function inboundSummary(turn: Turn): string {
  const message = object(turn);
  const conversation = message.conversation ? object(message.conversation) : undefined;
  return summary("INBOUND", {
    turn: turn.turn.id, message_ids: turn.turn.message_ids, channel_id: turn.channel_id,
    channel_policy: turn.channel_policy, author: typeof message.author === "string" ? message.author : "", author_id: turn.author_id,
    role: turn.role, scope: turn.scope, attention: message.attention,
    ...(turn.for_owner ? { for_owner: true } : {}),
    ...(message.addition_to ? { addition_to: message.addition_to } : {}),
    backlog: message.backlog,
    ...(message.recovered ? { recovered: true, recovery: "helio recovery scan" } : {}),
    ...(conversation ? { conversation: conversation.topic } : {}),
    preview: typeof message.content === "string" ? message.content.slice(0, 200) : "",
    read: `ack show inbound ${turn.turn.message_ids.join(",")}`,
  });
}

export function contextSummary(id: string, payload: string): string {
  const message = object(JSON.parse(payload));
  return summary("CONTEXT", {
    message_id: id, channel_id: message.channel_id, author: typeof message.author === "string" ? message.author : "", author_id: message.author_id,
    preview: typeof message.content === "string" ? message.content.slice(0, 200) : "",
    read: `ack show context ${id}`,
  });
}
