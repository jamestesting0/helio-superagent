import { requestTimestamp, type Delivery } from "./delivery.ts";
import type { Conversations } from "../conversations/conversations.ts";
import { object } from "./monitor-summary.ts";

export function pendingReminder(delivery: Delivery, conversations: Conversations, now: number): string | undefined {
  const pending = delivery.pending("inbound").filter((item) => {
    if (delivery.status("inbound", item.id).disposition !== "pending") return false;
    const working = conversations.working(item.id);
    if (working?.claimed_at != null && working.closed_at === null) return false;
    let at: number | undefined;
    try { at = requestTimestamp(object(JSON.parse(item.payload)).sent_at); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    }
    // Invalid ages cannot be acted on, but must remain visible for reconciliation.
    return at === undefined || now - at >= 5 * 60 * 1000;
  });
  return pending.length ? `INBOUND_PENDING count=${pending.length} oldest=${pending[0]?.id}` : undefined;
}
