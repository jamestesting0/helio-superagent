import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Delivery } from "./delivery.ts";

const sentAt = "2026-11-02T12:00:00Z";
let restoreClock = () => {};
beforeEach(() => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(sentAt));
  restoreClock = () => clock.mockRestore();
});
afterEach(() => restoreClock());

test("unacknowledged deliveries survive restart, but acknowledged messages cannot be requeued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-delivery-"));
  const path = join(dir, "delivery.sqlite");
  try {
    const first = new Delivery(path);
    first.stage("inbound", "10", '{"content":"request"}');
    first.stage("inbound", "11", JSON.stringify({ content: "follow-up", sent_at: sentAt }));
    first.close();

    const reopened = new Delivery(path);
    expect(reopened.pending("inbound")).toEqual([
      { id: "10", payload: '{"content":"request"}' },
      { id: "11", payload: JSON.stringify({ content: "follow-up", sent_at: sentAt }) },
    ]);
    reopened.acknowledge("inbound", "11");
    reopened.close();

    const final = new Delivery(path);
    try {
      expect(final.stage("inbound", "11", '{"content":"duplicate"}')).toBe(false);
      expect(final.pending("inbound")).toEqual([{ id: "10", payload: '{"content":"request"}' }]);
    } finally {
      final.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a separate acknowledgement process does not overwrite newly staged messages or another stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-delivery-"));
  const path = join(dir, "delivery.sqlite");
  try {
    const watcher = new Delivery(path);
    const acknowledger = new Delivery(path);
    try {
      watcher.stage("inbound", "10", JSON.stringify({ content: "request", sent_at: sentAt }));
      watcher.stage("context", "10", "knowledge");
      acknowledger.acknowledge("inbound", "10");
      watcher.stage("inbound", "11", "new request");
      expect(watcher.pending("inbound")).toEqual([{ id: "11", payload: "new request" }]);
      expect(acknowledger.pending("context")).toEqual([{ id: "10", payload: "knowledge" }]);
      expect(() => acknowledger.acknowledge("context", "99")).toThrow("Unknown context delivery");
    } finally {
      watcher.close();
      acknowledger.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the acknowledgement CLI clears only the delivery explicitly handled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-ack-"));
  const store = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    store.stage("context", "10", '{"message_id":"10","content":"rule"}');
    store.stage("context", "11", '{"message_id":"11","content":"another rule"}');
    const child = Bun.spawn(["bun", join(import.meta.dir, "../ack.ts"), "done", "context", "10"], {
      env: { ...process.env, DORI_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "ACK_DONE stream=context message_id=10\n", stderr: "", exitCode: 0,
    });
    expect(store.pending("context")).toEqual([
      { id: "11", payload: '{"message_id":"11","content":"another rule"}' },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("irrelevance survives restart as a distinct disposition without replacing the first reason or another stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-disposition-"));
  const path = join(dir, "delivery.sqlite");
  const watcher = new Delivery(path);
  const handler = new Delivery(path);
  try {
    watcher.stage("inbound", "10", JSON.stringify({ attention: "review", role: "STAFF_QUESTION", scope: "answer-only", content: "nice weather", sent_at: sentAt }));
    watcher.stage("context", "10", "knowledge");
    handler.irrelevant("10", "Conversation between other participants");
    const receipt = handler.status("inbound", "10");
    expect(receipt.disposition).toBe("irrelevant");
    expect(receipt.reason).toBe("Conversation between other participants");
    expect(receipt.handled_at).toEqual(expect.any(String));
    expect(() => handler.acknowledge("inbound", "10")).toThrow("already has disposition irrelevant");
    handler.irrelevant("10", "A later replay must not rewrite the decision");
    expect(handler.status("inbound", "10")).toEqual(receipt);
    watcher.stage("inbound", "11", "new request");
    const reopened = new Delivery(path);
    try {
      expect(reopened.status("inbound", "10")).toEqual(receipt);
      expect(reopened.stage("inbound", "10", "replay")).toBe(false);
      expect(reopened.pending("inbound")).toEqual([{ id: "11", payload: "new request" }]);
      expect(reopened.pending("context")).toEqual([{ id: "10", payload: "knowledge" }]);
    } finally {
      reopened.close();
    }
  } finally {
    handler.close();
    watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed terminal write rolls back the disposition and retains the pending payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-disposition-failure-"));
  const path = join(dir, "delivery.sqlite");
  const delivery = new Delivery(path);
  const db = new Database(path);
  try {
    const payload = JSON.stringify({ attention: "review", role: "STAFF_QUESTION", scope: "answer-only", content: "unrelated", sent_at: sentAt });
    delivery.stage("inbound", "10", payload);
    db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON delivery BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END");
    expect(() => delivery.irrelevant("10", "Unrelated chat")).toThrow("storage unavailable");
    expect(delivery.pending("inbound")).toEqual([{ id: "10", payload }]);
    expect(db.query("SELECT * FROM handling").all()).toEqual([]);
    db.exec("DROP TRIGGER fail_finish");
    delivery.irrelevant("10", "Unrelated chat");
    expect(delivery.pending("inbound")).toEqual([]);
    expect(delivery.status("inbound", "10").disposition).toBe("irrelevant");
  } finally {
    db.close();
    delivery.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy queues migrate without losing pending messages or relabeling acknowledged ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-legacy-"));
  const path = join(dir, "delivery.sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE delivery (stream TEXT NOT NULL, id TEXT NOT NULL, payload TEXT, PRIMARY KEY (stream, id));
    INSERT INTO delivery VALUES ('inbound', '10', '{"content":"unresolved request"}'), ('inbound', '11', NULL)`);
  old.close();
  const delivery = new Delivery(path);
  try {
    expect(() => delivery.irrelevant("10", "Missing metadata is not permission to drop")).toThrow("keep it pending");
    expect(delivery.pending("inbound")).toEqual([{ id: "10", payload: '{"content":"unresolved request"}' }]);
    expect(delivery.status("inbound", "11")).toEqual({ disposition: "legacy-done", reason: null, handled_at: null });
    expect(() => delivery.irrelevant("11", "Relabel completed work")).toThrow("already has disposition legacy-done");
    delivery.acknowledge("inbound", "11");
    expect(delivery.stage("inbound", "11", "replay")).toBe(false);
    expect(() => delivery.acknowledge("inbound", "10")).toThrow("unknown age");
    expect(delivery.status("inbound", "10").disposition).toBe("pending");
    expect(() => delivery.irrelevant("10", "Unknown age is not permission to drop")).toThrow("keep it pending");
  } finally {
    delivery.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("concurrent first starts initialize the shared delivery database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-initialize-"));
  try {
    for (let i = 0; i < 8; i++) {
      const path = join(dir, `${i}.sqlite`);
      const code = `import { Delivery } from ${JSON.stringify(join(import.meta.dir, "delivery.ts"))}; const d = new Delivery(process.argv[1]); d.close();`;
      const children = Array.from({length: 4}, () => Bun.spawn([process.execPath, "-e", code, path], {stdout: "pipe", stderr: "pipe"}));
      const results = await Promise.all(children.map(async (child) => ({code: await child.exited, stderr: await new Response(child.stderr).text()})));
      expect(results).toEqual(Array.from({length: 4}, () => ({code: 0, stderr: ""})));
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
