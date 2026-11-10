import type { Conversations, TopicRevision } from "./conversations.ts";
import { object } from "../delivery/monitor-summary.ts";

/** Includes staged-but-unclaimed input; another known topic never blocks this topic's fulfillment. */
export function newerInputPending(rows: readonly { readonly id: string; readonly payload: string }[],
  store: Conversations, topic: TopicRevision, covered: readonly string[]): boolean {
  const latest = [...covered, topic.anchor_message_id].reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  return rows.some(row => {
    if (covered.includes(row.id) || BigInt(row.id) <= BigInt(latest)) return false;
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(row.payload)); }
    catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
      return false; // Unreadable work stays queued; it cannot be assigned to this topic.
    }
    // Any participant's newer message in the reply's channel counts, unless it explicitly belongs to another topic.
    const channel = topic.reply_channel ?? topic.channel_id;
    if (payload.channel_id !== channel || typeof payload.author_id !== "string" ||
        !store.isParticipant(topic.anchor_message_id, payload.author_id)) return false;
    const owner = typeof payload.reply_to === "string" ? store.topicOfMessage(payload.reply_to) : null;
    return !owner || owner.anchor_message_id === topic.anchor_message_id;
  });
}
