import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Delivery, REQUEST_MAX_AGE_MS } from "./delivery.ts";
import { sweepExpired, sweepOrphanAttachments } from "./expiry.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const payload = (sentAt: number) => JSON.stringify({
  message_id: "10", sent_at: new Date(sentAt).toISOString(), content: "request",
  role: "STAFF_QUESTION", scope: "answer-only", attention: "direct", channel_policy: "normal",
});

test("only unhandled inbound older than 72h expires; boundary, accepted work and context survive restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-expiry-"));
  const path = join(dir, "delivery.sqlite");
  const queue = new Delivery(path);
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  try {
    queue.stage("inbound", "10", payload(NOW - REQUEST_MAX_AGE_MS - 1));
    queue.stage("inbound", "11", payload(NOW - REQUEST_MAX_AGE_MS));
    queue.stage("inbound", "12", payload(NOW - REQUEST_MAX_AGE_MS - 1));
    queue.accept("12", NOW - REQUEST_MAX_AGE_MS);
    queue.stage("context", "10", payload(NOW - REQUEST_MAX_AGE_MS - 1));
    queue.stage("inbound", "13", payload(NOW - REQUEST_MAX_AGE_MS - 1));
    queue.acknowledge("inbound", "12");
    queue.stage("inbound", "14", payload(NOW - REQUEST_MAX_AGE_MS - 1));
    queue.accept("14", NOW - REQUEST_MAX_AGE_MS);

    expect(queue.expire(NOW).expired).toEqual(["10", "13"]);
    const reopened = new Delivery(path);
    try {
      expect(reopened.pending("inbound").map((item) => item.id)).toEqual(["11", "14"]);
      expect(reopened.pending("context").map((item) => item.id)).toEqual(["10"]);
      expect(reopened.status("inbound", "10")).toEqual({
        disposition: "expired",
        reason: `Unhandled inbound request older than 72h from sent_at=${new Date(NOW - REQUEST_MAX_AGE_MS - 1).toISOString()}`,
        handled_at: expect.any(String),
      });
      expect(reopened.status("inbound", "12").disposition).toBe("done");
      expect(reopened.status("inbound", "14").disposition).toBe("accepted");
      expect(reopened.stage("inbound", "10", payload(NOW))).toBe(false);
      expect(() => reopened.acknowledge("inbound", "10")).toThrow("already has disposition expired");
      expect(() => reopened.accept("10", NOW)).toThrow("cannot act");
    } finally { reopened.close(); }
  } finally {
    clock.mockRestore();
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy and malformed timestamps retain payloads with a warning for each, never silent deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-legacy-expiry-"));
  const queue = new Delivery(join(dir, "delivery.sqlite"));
  try {
    const values = [
      "not json", "{}", '{"sent_at":42}', '{"sent_at":"2020-01-01"}',
      '{"sent_at":"2020-01-01T12:00:00"}', '{"sent_at":"2026-02-30T12:00:00Z"}',
    ];
    values.forEach((value, index) => { queue.stage("inbound", String(index + 10), value); });
    const result = queue.expire(NOW);
    expect(result.expired).toEqual([]);
    expect(result.warnings.map((warning) => /message_id=(\d+)/.exec(warning)?.[1])).toEqual(["10", "11", "12", "13", "14", "15"]);
    expect(queue.pending("inbound").map((item) => item.payload)).toEqual(values);
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("expiry rolls back on failure and cleanup retries from durable receipts without changing legacy CHECK constraints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-expiry-migration-"));
  const path = join(dir, "discord-delivery.sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE delivery (stream TEXT NOT NULL, id TEXT NOT NULL, payload TEXT, PRIMARY KEY(stream,id));
    CREATE TABLE handling (
      stream TEXT NOT NULL, id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('done', 'irrelevant')),
      reason TEXT, handled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(stream,id));
    INSERT INTO delivery VALUES ('inbound','11',NULL);
    INSERT INTO handling (stream,id,disposition,reason) VALUES ('inbound','11','irrelevant','original reason')`);
  const queue = new Delivery(path);
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  try {
    queue.stage("inbound", "10", payload(NOW - REQUEST_MAX_AGE_MS - 1));
    const file = join(dir, "attachments/inbound/pending/10/evidence.txt");
    const contextFile = join(dir, "attachments/context/pending/10/evidence.txt");
    await Bun.write(file, "evidence");
    await Bun.write(contextFile, "context");
    old.exec("CREATE TRIGGER fail_expire BEFORE UPDATE ON delivery BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END");
    expect(() => queue.expire(NOW)).toThrow("storage unavailable");
    expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10"]);
    expect(old.query("SELECT * FROM expiry").all()).toEqual([]);
    expect(await Bun.file(file).exists()).toBe(true);
    old.exec("DROP TRIGGER fail_expire");
    queue.expire(NOW);
    // Simulate a crash between the committed receipt and cleanup.
    const reopened = new Delivery(path);
    try {
      await sweepExpired(reopened, dir, () => { throw new Error("Unexpected malformed timestamp"); });
      expect(await Bun.file(file).exists()).toBe(false);
      expect(await Bun.file(contextFile).exists()).toBe(true);
      expect(reopened.expire(NOW).expired).toEqual([]);
      expect(reopened.status("inbound", "10").disposition).toBe("expired");
      expect(reopened.status("inbound", "11").reason).toBe("original reason");
      expect(() => old.exec("INSERT INTO handling (stream,id,disposition) VALUES ('inbound','99','expired')")).toThrow("CHECK");
    } finally { reopened.close(); }
  } finally {
    clock.mockRestore();
    old.close();
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["check", "accept", "acknowledge", "irrelevant"] as const)(
  "%s checks age at the action boundary without accepting or completing expired requests", async (action) => {
    const dir = await mkdtemp(join(tmpdir(), "dori-age-guard-"));
    const queue = new Delivery(join(dir, "delivery.sqlite"));
    const clock = spyOn(Date, "now").mockReturnValue(NOW);
    try {
      queue.stage("inbound", "10", payload(NOW - REQUEST_MAX_AGE_MS - 1));
      expect(() => {
        switch (action) {
          case "check": return queue.check("10");
          case "accept": return queue.accept("10");
          case "acknowledge": return queue.acknowledge("inbound", "10");
          case "irrelevant": return queue.irrelevant("10", "Unrelated");
        }
      }).toThrow();
      expect(queue.status("inbound", "10").disposition).toBe("expired");
      expect(queue.pending("inbound")).toEqual([]);
    } finally {
      clock.mockRestore();
      queue.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.each([undefined, "not-a-timestamp", "2026-02-30T12:00:00Z"])(
  "unknown age %j refuses checks, acceptance and terminal actions while retaining the original payload", async (sent_at) => {
    const dir = await mkdtemp(join(tmpdir(), "dori-unknown-age-"));
    const queue = new Delivery(join(dir, "delivery.sqlite"));
    const clock = spyOn(Date, "now").mockReturnValue(NOW);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const original = JSON.stringify({
        sent_at, attention: "direct", channel_policy: "normal", role: "STAFF_QUESTION", scope: "answer-only",
      });
      queue.stage("inbound", "10", original);
      expect(() => queue.check("10")).toThrow("unknown age");
      expect(() => queue.accept("10")).toThrow("unknown age");
      expect(() => queue.acknowledge("inbound", "10")).toThrow("unknown age");
      expect(() => queue.irrelevant("10", "Unrelated")).toThrow("unknown age");
      expect(queue.pending("inbound")).toEqual([{ id: "10", payload: original }]);
      expect(queue.status("inbound", "10").disposition).toBe("pending");
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      clock.mockRestore();
      queue.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("leftover attachment folders of finished messages are removed; pending ones and non-ID names stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-orphans-"));
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    delivery.stage("context", "10", JSON.stringify({ channel_id: "1" }));
    delivery.stage("context", "20", JSON.stringify({ channel_id: "1" }));
    delivery.acknowledge("context", "20");
    const pending = join(dir, "attachments/context/pending");
    for (const name of ["10", "20", "30", "notes"]) await Bun.write(join(pending, name, "a.png"), "x");
    expect(await sweepOrphanAttachments(delivery, dir, "context")).toBe(2);
    expect((await Array.fromAsync(new Bun.Glob("*/a.png").scan(pending))).sort()).toEqual(["10/a.png", "notes/a.png"]);
    expect(await sweepOrphanAttachments(delivery, dir, "inbound")).toBe(0);
  } finally {
    delivery.close();
    await rm(dir, { recursive: true, force: true });
  }
});
