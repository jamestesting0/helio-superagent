import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Every TypeScript writer enters through this migration, including short-lived commands. */
export function conversationDatabase(path: string, now: number, busyMs = 5000): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=${busyMs};`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try { db.exec("PRAGMA journal_mode=WAL;"); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
          error.code !== "SQLITE_BUSY" || Date.now() >= deadline) {
        db.close();
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS conversations (
      channel_id TEXT NOT NULL, user_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL, anchor_message_id TEXT NOT NULL, topic TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','closed','timed_out')),
      outcome TEXT, closed_at INTEGER, PRIMARY KEY(channel_id,user_id,opened_at)
    );
    CREATE TABLE IF NOT EXISTS transcript (
      message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
      opened_at INTEGER NOT NULL, author_id TEXT NOT NULL, sent_at TEXT, entry TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS working (
      message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, closed_at INTEGER, reacted INTEGER NOT NULL DEFAULT 0,
      warned INTEGER NOT NULL DEFAULT 0, guards INTEGER NOT NULL DEFAULT 0, first_guard_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS working_author ON working(channel_id,user_id,started_at);`);
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 1) return;
    db.exec(`CREATE TABLE conversations_next (
        channel_id TEXT NOT NULL, user_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL, anchor_message_id TEXT NOT NULL, topic TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','on_hold','resolved','archived')),
        outcome TEXT, closed_at INTEGER, summary TEXT NOT NULL DEFAULT '' CHECK(length(summary)<=600),
        hold_reason TEXT, nudged_at INTEGER, resolved_at INTEGER, archived_at INTEGER, issue TEXT,
        PRIMARY KEY(channel_id,user_id,opened_at)
      );
      INSERT INTO conversations_next
        (channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status,outcome,closed_at,summary,resolved_at)
        SELECT channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,
          CASE WHEN status='open' THEN 'open' ELSE 'resolved' END,
          CASE WHEN status='timed_out' THEN coalesce(outcome,'timed_out') ELSE outcome END,
          closed_at,CASE WHEN status='open' THEN '' ELSE topic END,
          CASE WHEN status='open' THEN NULL ELSE coalesce(closed_at,last_activity) END
        FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_next RENAME TO conversations;
      CREATE UNIQUE INDEX conversations_open ON conversations(channel_id,user_id)
        WHERE status IN ('open','on_hold');
      CREATE TABLE transcript_next (
        message_id TEXT NOT NULL,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,opened_at INTEGER NOT NULL,
        author_id TEXT NOT NULL,sent_at TEXT,entry TEXT NOT NULL,
        PRIMARY KEY(message_id,channel_id,user_id,opened_at)
      );
      INSERT INTO transcript_next (message_id,channel_id,user_id,opened_at,author_id,sent_at,entry)
        SELECT message_id,channel_id,user_id,opened_at,author_id,sent_at,entry FROM transcript ORDER BY rowid;
      DROP TABLE transcript;
      ALTER TABLE transcript_next RENAME TO transcript;
      DELETE FROM transcript WHERE NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.channel_id=transcript.channel_id
          AND c.user_id=transcript.user_id AND c.opened_at=transcript.opened_at AND c.status='open');
      ALTER TABLE working ADD COLUMN claimed_at INTEGER;
      ALTER TABLE working ADD COLUMN intake_at INTEGER;
      CREATE TABLE conversation_migrations (
        channel_id TEXT NOT NULL,user_id TEXT NOT NULL,opened_at INTEGER NOT NULL,
        migrated_at INTEGER NOT NULL,resolved_at INTEGER,
        PRIMARY KEY(channel_id,user_id,opened_at)
      );
      CREATE TABLE conversation_upkeep (name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE conversation_notices (message_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);`);
    db.query(`INSERT INTO conversation_migrations (channel_id,user_id,opened_at,migrated_at)
      SELECT channel_id,user_id,opened_at,? FROM conversations WHERE status='open'`).run(now);
    db.exec("PRAGMA user_version=1");
  }).immediate();
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 2) return;
    // What Helio understood, kept apart from the transcript so it survives the context window.
    for (const column of ["request", "decided", "waiting_on", "result"]) {
      db.exec(`ALTER TABLE conversations ADD COLUMN ${column} TEXT NOT NULL DEFAULT '' CHECK(length(${column})<=300)`);
    }
    db.exec("UPDATE conversations SET request=substr(summary,1,300) WHERE summary!=''");
    db.exec("PRAGMA user_version=2");
  }).immediate();
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 3) return;
    // Separate topics from one person in one channel are separate conversations.
    db.exec(`DROP INDEX IF EXISTS conversations_open;
      CREATE INDEX IF NOT EXISTS conversations_active ON conversations(channel_id,user_id,status);
      PRAGMA user_version=3`);
  }).immediate();
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 4) return;
    db.exec(`ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN job TEXT;
      ALTER TABLE conversations ADD COLUMN reply_disposition TEXT;
      ALTER TABLE conversations ADD COLUMN question_started_at INTEGER;
      ALTER TABLE conversations ADD COLUMN question_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN last_reply_key TEXT;
      PRAGMA user_version=4`);
  }).immediate();
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 5) return;
    db.exec(`ALTER TABLE conversations ADD COLUMN latest_input_id TEXT;
      UPDATE conversations SET latest_input_id=coalesce((SELECT message_id FROM transcript t
        WHERE t.channel_id=conversations.channel_id AND t.user_id=conversations.user_id
          AND t.opened_at=conversations.opened_at AND t.author_id=conversations.user_id
        ORDER BY length(message_id) DESC,message_id DESC LIMIT 1),anchor_message_id);
      PRAGMA user_version=5`);
  }).immediate();
  return db;
}
