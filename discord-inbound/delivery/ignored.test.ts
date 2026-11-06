import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";
import { prepareMessageBody } from "../messages/forwarded.ts";

test("neutral receipts survive restart, preserve legacy handling and cannot settle accepted or changed work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helio-ignored-"));
  const path = join(directory, "delivery.sqlite");
  const queue = new Delivery(path);
  const payload = JSON.stringify({ content: "Channel renamed", sent_at: new Date().toISOString(),
    discord_origin: { message_type: 4 }, channel_id: "100" });
  try {
    for (const id of ["10", "11", "12"]) queue.stage("inbound", id, payload);
    queue.recovery.flag("10", payload);
    queue.accept("11");
    queue.refresh("12", payload, payload + " ");
    expect(await queue.ignored.settle("inbound", "10", payload)).toBe("system-event");
    expect(await queue.ignored.settle("inbound", "11", payload)).toBeUndefined();
    expect(await queue.ignored.settle("inbound", "12", payload)).toBeUndefined();
    expect(queue.recovery.status("10")?.outcome).toBe("informational");
    const reopened = new Delivery(path);
    try {
      expect(reopened.status("inbound", "10").disposition).toBe("ignored");
      expect(reopened.stage("inbound", "10", payload)).toBe(false);
      expect(reopened.pending("inbound").map(row => row.id)).toEqual(["11", "12"]);
      expect(await reopened.ignored.settle("inbound", "10", payload)).toBeUndefined();
      expect(() => reopened.acknowledge("inbound", "10")).toThrow("ignored");
      expect(reopened.ignored.pendingCleanup()).toEqual([{ stream: "inbound", id: "10" }]);
      const db = new Database(path, { readonly: true });
      try {
        expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='handling'").get()?.sql)
          .toContain("('done', 'irrelevant')");
        const receipt = db.query("SELECT * FROM ignored").get();
        expect(receipt).toMatchObject({ reason: "system-event", source_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(receipt).not.toHaveProperty("payload");
      } finally { db.close(); }
    } finally { reopened.close(); }
  } finally { queue.close(); await rm(directory, { recursive: true }); }
});

test("only structured unsupported-only preparation settles; readable mixed and transient failures survive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helio-format-"));
  const queue = new Delivery(join(directory, "delivery.sqlite"));
  try {
    const body = await prepareMessageBody({ id: "10", content: "", attachments: [
      { filename: "data.zip", url: "https://cdn.discordapp.com/attachments/1/2/data.zip" },
    ] }, join(directory, "attachments"));
    expect(body.blocked_attachments[0]?.category).toBe("unsupported-format");
    const base = { ...body, preparation_complete: true, discord_origin: { message_type: 0 } };
    for (const [index, value] of [base, { ...base, content: "please explain" },
      { ...base, blocked_attachments: [{ name: "photo.png", reason: "unavailable", category: "unavailable" }] },
      { ...base, forwarded: [{ content: "forwarded request", attachments: [] }] },
      { ...base, preparation_complete: false }].entries()) {
      const id = String(index + 10), payload = JSON.stringify(value);
      queue.stage("inbound", id, payload);
      expect(await queue.ignored.settle("inbound", id, payload)).toBe(index === 0 ? "unsupported-format" : undefined);
    }
  } finally { queue.close(); await rm(directory, { recursive: true }); }
});

test("ignored-channel proof requires current ancestry and lookup failures retain the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helio-ignore-policy-"));
  const queue = new Delivery(join(directory, "delivery.sqlite"));
  try {
    const payload = JSON.stringify({ channel_id: "101", discord_origin: { message_type: 0 } });
    queue.stage("inbound", "10", payload);
    await expect(queue.ignored.settle("inbound", "10", payload, new Set(["100"]),
      async () => { throw new Error("metadata unavailable"); })).rejects.toThrow("metadata unavailable");
    expect(queue.pending("inbound")).toHaveLength(1);
    expect(await queue.ignored.settle("inbound", "10", payload, new Set(["100"]),
      async id => id === "101" ? { parent_id: "100" } : undefined)).toBe("ignored-channel");
  } finally { queue.close(); await rm(directory, { recursive: true }); }
});
