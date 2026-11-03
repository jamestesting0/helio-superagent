import type { Delivery } from "./delivery.ts";
import { cleanupAttachments } from "./images.ts";

/** Cleanup is retriable after a crash; the expiry receipt commits before filesystem deletion. */
export async function sweepExpired(delivery: Delivery, stateDir: string, warn: (message: string) => void): Promise<void> {
  const result = delivery.expire();
  for (const warning of result.warnings) warn(warning);
  for (const id of result.expired) {
    await cleanupAttachments(id, `${stateDir}/attachments/inbound`);
    delivery.cleaned(id);
  }
}
