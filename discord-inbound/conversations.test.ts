import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations, CONVERSATION_MAX_IDLE_MS, conversationTimeoutReporter } from "./conversations.ts";
import { describeMessage } from "./reply-context.ts";

test("open limits are per user across channels and already open refuses without changing topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversations-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    store.open("100", "99", "10", "first", 1000);
    store.open("101", "99", "11", "second", 1000);
    expect(() => store.open("100", "99", "12", "changed", 1001)).toThrow("already open");
    expect(store.get("100", "99")?.topic).toBe("first");
    expect(() => store.open("102", "99", "12", "third", 1001)).toThrow("2 open");
    expect(store.open("100", "77", "13", "other person", 1001).status).toBe("open");
    expect([store.isOpen("100", "99"), store.isOpen("101", "77")]).toEqual([true, false]);
    expect((await stat(join(dir, "discord-conversations.sqlite"))).mode & 0o777).toBe(0o600);
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("close and timeout delete private transcript while preserving history and unknown tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-privacy-"));
  const path = join(dir, "discord-conversations.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE other_tool (value TEXT); INSERT INTO other_tool VALUES ('preserved')");
  const store = new Conversations(path);
  const entry = (id: string) => describeMessage({
    id, channel_id: "100", author: { id: "99", username: "human" },
    content: "private", timestamp: "2026-11-03T00:00:00Z",
  }, 12000).entry;
  try {
    store.open("100", "99", "9", "question", 1000);
    store.append("100", "99", entry("11"));
    store.append("100", "99", entry("10"));
    store.append("100", "99", entry("10"));
    expect(store.transcript("100", "99").map((row) => row.message_id)).toEqual(["10", "11"]);
    expect(store.close("100", "99", "answered", 2000).outcome).toBe("answered");
    expect(db.query("SELECT * FROM transcript").all()).toEqual([]);
    store.open("100", "99", "12", "again", 3000);
    store.append("100", "99", entry("13"));
    store.touch("100", "99", 4000);
    expect(store.timeouts(4000 + CONVERSATION_MAX_IDLE_MS)).toEqual([]);
    expect(store.timeouts(4001 + CONVERSATION_MAX_IDLE_MS).map((row) => [row.status, row.anchor_message_id]))
      .toEqual([["timed_out", "12"]]);
    expect(store.timeouts(5000 + CONVERSATION_MAX_IDLE_MS)).toEqual([]);
    expect(db.query("SELECT * FROM transcript").all()).toEqual([]);
    expect(db.query("SELECT status FROM conversations ORDER BY opened_at").all())
      .toEqual([{ status: "closed" }, { status: "timed_out" }]);
    expect(db.query("SELECT * FROM other_tool").all()).toEqual([{ value: "preserved" }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='followups'").all()).toEqual([]);
  } finally { store.dispose(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("timeout reporter uses its injected clock and emits each timeout exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-timeout-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  let now = 1000;
  const lines: string[] = [];
  const report = conversationTimeoutReporter(store, (line) => lines.push(line), () => now);
  try {
    store.open("100", "99", "9", "awaiting detail", now);
    report();
    expect(lines).toEqual([]);
    now += CONVERSATION_MAX_IDLE_MS + 1;
    report();
    report();
    expect(lines).toEqual([
      'INBOUND_CONVERSATION_TIMEOUT {"channel_id":"100","user_id":"99","anchor_message_id":"9","topic":"awaiting detail","opened_at":1000}',
    ]);
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});
