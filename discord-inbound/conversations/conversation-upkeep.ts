import { CONVERSATION_MAX_IDLE_MS, type Conversation, type Conversations } from "./conversations.ts";
import { monitorLine } from "../delivery/monitor-summary.ts";
import { policyValues } from "../intake/runtime-policy.ts";

/**
 * Helio never chases people for answers: a question nobody answered closes silently after the timeout.
 * A later reply to Helio still reaches it (replies to Helio are always admitted) and reopens the topic.
 */
export async function sweepConversations(options: {
  readonly store: Conversations;
  readonly now: number;
  readonly emit: (line: string) => void;
  readonly hasNewInput?: (row: Conversation) => boolean;
}): Promise<void> {
  const { store, now, emit } = options;
  const hours = Number(policyValues().HELIO_CONVERSATION_TIMEOUT_HOURS ?? CONVERSATION_MAX_IDLE_MS / 3_600_000);
  const timeoutMs = hours * 3_600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid conversation timeout");
  for (const row of store.list()) {
    if (store.state(row) !== "waiting_on_requester" || row.question_started_at === null || options.hasNewInput?.(row)) continue;
    if (now - row.question_started_at >= timeoutMs) store.resolveIfCurrent(row, "timed_out", now);
  }
  for (const row of store.dailyWaiting(now)) {
    emit(monitorLine(`INBOUND_CONVERSATION_WAITING ${JSON.stringify({
      channel_id: row.channel_id, user_id: row.user_id, topic: row.topic,
      state: "waiting_on_helio", idle_ms: now - row.last_activity,
      read: `helio conversation show ${row.anchor_message_id}`,
    })}`));
  }
  store.retain(now);
}
