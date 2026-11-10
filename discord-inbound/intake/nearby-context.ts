import { describeMessage, type ReplyMessage } from "../messages/reply-context.ts";

/** Initial evidence comes from the bounded intake cache, never a preparation-time history request. */
export function nearbyContext(messages: Iterable<ReplyMessage>,
  root: Pick<ReplyMessage, "id" | "channel_id" | "timestamp">,
  readable: (message: ReplyMessage) => ReplyMessage) {
  const at = Date.parse(root.timestamp ?? "");
  const recent = [...messages].filter(message => {
    const sent = Date.parse(message.timestamp ?? "");
    return message.channel_id === root.channel_id && BigInt(message.id) < BigInt(root.id) &&
      Number.isFinite(at) && Number.isFinite(sent) && sent <= at && at - sent <= 5 * 60_000;
  }).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? 1 : -1).slice(-10)
    .map(message => describeMessage(readable(message), 500).entry);
  return {
    recent,
    context_status: recent.length ? "cached" : "not_loaded",
    context_read: `ack context inbound ${root.id}`,
  };
}
