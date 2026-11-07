import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations } from "./conversations.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");

test("user_version guards a table rebuild that preserves followups and terminal outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-migration-"));
  const path = join(dir, "discord-conversations.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE conversations (
    channel_id TEXT,user_id TEXT,opened_at INTEGER,last_activity INTEGER,anchor_message_id TEXT,topic TEXT,
    status TEXT CHECK(status IN ('open','closed','timed_out')),outcome TEXT,closed_at INTEGER,
    PRIMARY KEY(channel_id,user_id,opened_at));
    CREATE UNIQUE INDEX conversations_open ON conversations(channel_id,user_id) WHERE status='open';
    CREATE TABLE transcript (message_id TEXT PRIMARY KEY,channel_id TEXT,user_id TEXT,opened_at INTEGER,
      author_id TEXT,sent_at TEXT,entry TEXT);
    CREATE TABLE working (message_id TEXT PRIMARY KEY,channel_id TEXT,user_id TEXT,started_at INTEGER,
      closed_at INTEGER,reacted INTEGER DEFAULT 0,warned INTEGER DEFAULT 0,guards INTEGER DEFAULT 0,first_guard_at INTEGER);
    CREATE TABLE followups (issue INTEGER,status TEXT);
    INSERT INTO followups VALUES (3,'open'),(4,'announced');
    INSERT INTO conversations VALUES ('100','99',1,2,'10','legacy open','open',NULL,NULL),
      ('100','77',1,2,'11','legacy closed','closed','issue',3),
      ('100','66',1,2,'12','legacy timeout','timed_out',NULL,4),
      ('100','65',1,2,'13','recorded timeout outcome','timed_out','other',4);
    INSERT INTO working VALUES ('10','100','99',1,NULL,1,0,0,NULL);`);
  let store = new Conversations(path, NOW);
  try {
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.query("SELECT user_id,status,outcome FROM conversations ORDER BY user_id").all()).toEqual([
      { user_id: "65", status: "resolved", outcome: "other" },
      { user_id: "66", status: "resolved", outcome: "timed_out" },
      { user_id: "77", status: "resolved", outcome: "issue" },
      { user_id: "99", status: "open", outcome: null },
    ]);
    expect(store.working("10")?.claimed_at).toBeNull();
    expect(store.resolveLegacy(NOW).map((row) => [row.user_id, row.topic])).toEqual([["99", "legacy open"]]);
    expect([store.latest("100", "99")?.outcome, store.latest("100", "99")?.summary]).toEqual(["other", "legacy open"]);
    const before = db.serialize();
    store.dispose();
    store = new Conversations(path, NOW + 1000);
    expect(store.resolveLegacy(NOW + 1000)).toEqual([]);
    expect(db.serialize()).toEqual(before);
    expect(db.query("SELECT * FROM followups ORDER BY issue").all())
      .toEqual([{ issue: 3, status: "open" }, { issue: 4, status: "announced" }]);
  } finally { store.dispose(); db.close(); await rm(dir, { recursive: true, force: true }); }
});
