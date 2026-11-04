import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Delivery, Stream } from "./delivery.ts";
import { cleanupAttachments } from "../messages/images.ts";

// Attachment folders are named by message ID; a folder whose message is no longer pending is a leftover.
// Call only before this process starts preparing messages, so files being downloaded are never touched.
export async function sweepOrphanAttachments(delivery: Delivery, stateDir: string, stream: Stream): Promise<number> {
  const root = `${stateDir}/attachments/${stream}`;
  let names: string[];
  try { names = await readdir(join(root, "pending")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const pending = new Set(delivery.pending(stream).map((item) => item.id));
  const leftovers = names.filter((id) => /^[0-9]{1,30}$/.test(id) && !pending.has(id));
  for (const id of leftovers) await cleanupAttachments(id, root);
  return leftovers.length;
}

/** Cleanup is retriable after a crash; the expiry receipt commits before filesystem deletion. */
export async function sweepExpired(delivery: Delivery, stateDir: string, warn: (message: string) => void): Promise<void> {
  const result = delivery.expire();
  for (const warning of result.warnings) warn(warning);
  for (const id of result.expired) {
    await cleanupAttachments(id, `${stateDir}/attachments/inbound`);
    delivery.cleaned(id);
  }
}
