import type { Delivery } from "./delivery.ts";
import type { Conversations } from "../conversations/conversations.ts";
import { cleanupAttachments } from "../messages/images.ts";

/** A committed skip is independent of retriable local cleanup. Never reconcile Discord reactions here. */
export async function cleanupIgnored(queue: Delivery, state: string, conversations?: Conversations): Promise<void> {
  for (const row of queue.ignored.pendingCleanup()) {
    try {
      if (row.stream === "inbound") {
        if (!conversations && Bun.file(`${state}/discord-conversations.sqlite`).size) continue;
        conversations?.closeWorking([row.id], Date.now());
      }
      await cleanupAttachments(row.id, `${state}/attachments/${row.stream}`);
      queue.ignored.cleaned(row.stream, row.id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.log(`IGNORED_CLEANUP_PENDING stream=${row.stream} message_id=${row.id}`);
    }
  }
}
