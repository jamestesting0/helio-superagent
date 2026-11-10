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
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
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
    expect(db.query("SELECT * FROM followups_legacy ORDER BY issue").all())
      .toEqual([{ issue: 3, status: "open" }, { issue: 4, status: "announced" }]);
    expect(db.query("SELECT count(*) AS n FROM followups").get()).toEqual({ n: 0 });
  } finally { store.dispose(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("migration keeps every message's own channel and audience when duplicate anchors merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-audience-"));
  const path = join(dir, "discord-conversations.sqlite");
  const saved = { normal: process.env.DORI_DISCORD_NORMAL_CHANNELS, trusted: process.env.DORI_DISCORD_TRUSTED_CHANNELS };
  Object.assign(process.env, { DORI_DISCORD_NORMAL_CHANNELS: "200", DORI_DISCORD_TRUSTED_CHANNELS: "100" });
  const db = new Database(path);
  const entry = (id: string, content: string) => JSON.stringify({ message_id: id, author_id: "66", content, bot: false });
  db.exec(`CREATE TABLE conversations (
    channel_id TEXT,user_id TEXT,opened_at INTEGER,last_activity INTEGER,anchor_message_id TEXT,topic TEXT,
    status TEXT CHECK(status IN ('open','closed','timed_out')),outcome TEXT,closed_at INTEGER,
    PRIMARY KEY(channel_id,user_id,opened_at));
    CREATE TABLE transcript (message_id TEXT PRIMARY KEY,channel_id TEXT,user_id TEXT,opened_at INTEGER,author_id TEXT,sent_at TEXT,entry TEXT);
    INSERT INTO conversations VALUES ('100','66',1,1,'10','staff side','open',NULL,NULL),('200','66',2,2,'10','public side','open',NULL,NULL),
      ('700','66',3,3,'30','owner dm','open',NULL,NULL);`);
  db.run("INSERT INTO transcript VALUES ('11','100','66',1,'66',NULL,?),('21','200','66',2,'66',NULL,?),('31','700','66',3,'66',NULL,?)",
    [entry("11", "STAFF ONLY"), entry("21", "public detail"), entry("31", "PRIVATE DM")]);
  const store = new Conversations(path, NOW);
  try {
    expect(db.query("SELECT message_id,channel_id,message_channel_id,audience FROM transcript ORDER BY message_id").all()).toEqual([
      { message_id: "11", channel_id: "200", message_channel_id: "100", audience: "staff" },
      { message_id: "21", channel_id: "200", message_channel_id: "200", audience: "public" },
      { message_id: "31", channel_id: "700", message_channel_id: "700", audience: "dm" },
    ]);
    const merged = store.topic("10")!, dm = store.topic("30")!;
    const seen = (row: typeof merged, channel: string, audience: "public" | "staff" | "dm") =>
      store.transcriptOf(row, { channel, audience }).map(item => item.content);
    expect(seen(merged, "200", "public")).toEqual(["public detail"]);
    expect(seen(merged, "100", "staff")).toEqual(["STAFF ONLY", "public detail"]);
    expect(seen(dm, "100", "staff")).toEqual([]);
    expect(seen(dm, "700", "dm")).toEqual(["PRIVATE DM"]);
  } finally {
    store.dispose(); db.close();
    Object.assign(process.env, { DORI_DISCORD_NORMAL_CHANNELS: saved.normal, DORI_DISCORD_TRUSTED_CHANNELS: saved.trusted });
    for (const [key, value] of [["DORI_DISCORD_NORMAL_CHANNELS", saved.normal], ["DORI_DISCORD_TRUSTED_CHANNELS", saved.trusted]] as const) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
});
