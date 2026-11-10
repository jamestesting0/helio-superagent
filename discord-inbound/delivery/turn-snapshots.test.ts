import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";

test("a grouped turn stores one context snapshot that survives acknowledgment of its first input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helio-turn-snapshot-"));
  const path = join(directory, "discord-delivery.sqlite");
  let queue = new Delivery(path);
  const recent = Array.from({ length: 10 }, (_, index) => ({
    message_id: String(100 + index), author_id: "66", author: "Bystander", content: "evidence ".repeat(50),
    reply_to: String(99 + index),
  }));
  const ids = Array.from({ length: 10 }, (_, index) => String(200 + index));
  try {
    for (const id of ids) queue.stage("inbound", id, JSON.stringify({
      message_id: id, channel_id: "1", author_id: "99", content: "A short request", sent_at: new Date().toISOString(),
      conversation: { recent, context_status: "cached", context_read: `ack context inbound ${id}` },
    }));
    const before = queue.pending("inbound").reduce((bytes, row) => bytes + row.payload.length, 0);
    queue.snapshots.capture(ids);
    const pending = queue.pending("inbound");
    const db = new Database(path, { readonly: true });
    const snapshots = db.query<{ payload: string }, []>("SELECT payload FROM turn_context_snapshots").all();
    db.close();
    const after = pending.reduce((bytes, row) => bytes + row.payload.length, 0) +
      snapshots.reduce((bytes, row) => bytes + row.payload.length, 0);
    expect(snapshots).toHaveLength(1);
    expect(after).toBeLessThan(before / 3);
    for (const item of pending) {
      const compact = JSON.parse(item.payload);
      expect(compact.conversation.recent).toBeUndefined();
      expect(queue.snapshots.hydrate(compact)).toMatchObject({ conversation: { recent } });
    }
    queue.acknowledge("inbound", ids[0]!);
    queue.close();
    queue = new Delivery(path);
    const resumed = JSON.parse(queue.pending("inbound")[0]!.payload);
    expect(queue.snapshots.hydrate(resumed)).toMatchObject({ conversation: { recent } });
    console.log(`SNAPSHOT_BYTES ${JSON.stringify({ before, after, messages: ids.length })}`);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});
