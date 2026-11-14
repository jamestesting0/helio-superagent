import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { policyValues } from "../intake/runtime-policy.ts";

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
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 6) return;
    db.exec(`CREATE TABLE conversation_admin_operations (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
    ); PRAGMA user_version=6`);
  }).immediate();
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 7) return;
    sharedTopics(db, now);
    db.exec("PRAGMA user_version=7");
  }).immediate();
  // When an unthreaded message may count as the answer to Helio's question: one window per delivered question,
  // kept after it ends so catch-up judges each message by the window that applied when it was sent.
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    if (version && version.user_version >= 8) return;
    db.exec(`CREATE TABLE question_windows (
        anchor_message_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        opened_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY(anchor_message_id,opened_at));
      CREATE INDEX question_windows_person ON question_windows(user_id,channel_id);
      INSERT OR IGNORE INTO question_windows
        SELECT anchor_message_id,coalesce(waiting_on_user,user_id),coalesce(question_channel_id,channel_id),question_started_at,NULL
        FROM conversations WHERE status='open' AND reply_disposition='question' AND question_started_at IS NOT NULL;
      PRAGMA user_version=8`);
  }).immediate();
  // Closing notes are recorded per topic and channel before sending, so a retry reuses its target and recipients.
  db.exec(`CREATE TABLE IF NOT EXISTS closure_notes (anchor_message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    target TEXT NOT NULL, users TEXT NOT NULL, PRIMARY KEY(anchor_message_id,channel_id))`);
  return db;
}

/**
 * Topics are shared: the anchor message identifies a topic, its opener and origin channel stay as the row key, and
 * participants, message channels and audiences are recorded separately. Follow-ups subscribe a topic, not a person.
 */
function sharedTopics(db: Database, now: number): void {
  const policy = policyValues();
  const list = (name: string) => new Set((policy[name] ?? "").split(",").map(id => id.trim()).filter(Boolean));
  const normal = list("DORI_DISCORD_NORMAL_CHANNELS"), trusted = list("DORI_DISCORD_TRUSTED_CHANNELS");
  // Each message keeps the channel it was said in. Anything not known to be public or the trusted chat stays
  // visible only in its own channel, so a DM or an unlisted thread never widens its audience.
  db.exec(`CREATE TABLE transcript_next (
      message_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
      author_id TEXT NOT NULL, sent_at TEXT, entry TEXT, message_channel_id TEXT NOT NULL,
      audience TEXT NOT NULL CHECK(audience IN ('public','staff','dm')), is_helio INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(message_id,channel_id,user_id,opened_at));`);
  for (const row of db.query<{ rowid: number; channel_id: string; entry: string }, []>("SELECT rowid,channel_id,entry FROM transcript ORDER BY rowid").all()) {
    const helio = (() => { try { return JSON.parse(row.entry)?.bot === true; } catch { return false; } })();
    const audience = normal.has(row.channel_id) ? "public" : trusted.has(row.channel_id) ? "staff" : "dm";
    db.run(`INSERT OR IGNORE INTO transcript_next SELECT message_id,channel_id,user_id,opened_at,author_id,sent_at,entry,channel_id,?,?
      FROM transcript WHERE rowid=?`, [audience, helio ? 1 : 0, row.rowid]);
  }
  db.exec("DROP TABLE transcript; ALTER TABLE transcript_next RENAME TO transcript;");
  db.exec("CREATE TABLE topic_participants_seed (anchor TEXT, user_id TEXT, opened_at INTEGER, channel_id TEXT)");
  // Rows sharing an anchor were one subject; keep the newest and move the others' transcript into it, placement intact.
  for (const dup of db.query<{ channel_id: string; user_id: string; opened_at: number; anchor_message_id: string }, []>(
    `SELECT c.channel_id,c.user_id,c.opened_at,c.anchor_message_id FROM conversations c WHERE EXISTS (
      SELECT 1 FROM conversations n WHERE n.anchor_message_id=c.anchor_message_id AND n.rowid>c.rowid)`).all()) {
    const keep = db.query<{ channel_id: string; user_id: string; opened_at: number }, [string]>(
      "SELECT channel_id,user_id,opened_at FROM conversations WHERE anchor_message_id=? ORDER BY rowid DESC LIMIT 1").get(dup.anchor_message_id)!;
    db.run(`UPDATE OR IGNORE transcript SET channel_id=?,user_id=?,opened_at=? WHERE channel_id=? AND user_id=? AND opened_at=?`,
      [keep.channel_id, keep.user_id, keep.opened_at, dup.channel_id, dup.user_id, dup.opened_at]);
    db.run("DELETE FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=?", [dup.channel_id, dup.user_id, dup.opened_at]);
    db.run("INSERT INTO topic_participants_seed VALUES (?,?,?,?)", [dup.anchor_message_id, dup.user_id, dup.opened_at, dup.channel_id]);
    db.run("DELETE FROM conversations WHERE channel_id=? AND user_id=? AND opened_at=?", [dup.channel_id, dup.user_id, dup.opened_at]);
  }
  // A person's message belongs to one topic; earlier duplicates keep the newest topic's copy.
  db.exec(`DELETE FROM transcript WHERE is_helio=0 AND rowid NOT IN (SELECT max(rowid) FROM transcript WHERE is_helio=0 GROUP BY message_id);
    CREATE UNIQUE INDEX conversations_anchor ON conversations(anchor_message_id);
    ALTER TABLE conversations ADD COLUMN waiting_on_user TEXT;
    ALTER TABLE conversations ADD COLUMN question_channel_id TEXT;
    ALTER TABLE conversations ADD COLUMN question_message_id TEXT;
    ALTER TABLE conversations ADD COLUMN merged_into TEXT;
    UPDATE conversations SET waiting_on_user=user_id,question_channel_id=channel_id,
      question_message_id=coalesce(latest_input_id,anchor_message_id)
      WHERE reply_disposition='question' AND question_started_at IS NOT NULL;
    CREATE TABLE topic_participants (
      anchor_message_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
      via TEXT NOT NULL CHECK(via IN ('opened','answered','covered','lead','merge','issue')),
      last_channel_id TEXT NOT NULL, last_message_id TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(anchor_message_id,user_id));
    INSERT INTO topic_participants
      SELECT anchor_message_id,user_id,opened_at,'opened',channel_id,coalesce(latest_input_id,anchor_message_id),1 FROM conversations;
    INSERT OR IGNORE INTO topic_participants SELECT anchor,user_id,opened_at,'merge',channel_id,anchor,1 FROM topic_participants_seed;
    DROP TABLE topic_participants_seed;
    CREATE INDEX transcript_message ON transcript(message_id);
    CREATE UNIQUE INDEX transcript_person ON transcript(message_id) WHERE is_helio=0;
    CREATE INDEX participants_user ON topic_participants(user_id);`);
  topicFollowups(db, now);
}

/** Person-keyed follow-ups become topic subscriptions; delivered rows stay as history. */
function topicFollowups(db: Database, now: number): void {
  const legacy = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='followups'").get() !== null;
  if (legacy) db.exec("ALTER TABLE followups RENAME TO followups_legacy");
  db.exec(`CREATE TABLE followups (
      repo TEXT NOT NULL, issue INTEGER NOT NULL, anchor_message_id TEXT NOT NULL, kind TEXT, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','announced','done')), announcement TEXT, observed_at INTEGER,
      PRIMARY KEY(repo,issue,anchor_message_id));
    CREATE TABLE followup_groups (
      repo TEXT NOT NULL, issue INTEGER NOT NULL, anchor_message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      target TEXT NOT NULL, users TEXT NOT NULL, reply_id TEXT, disposition TEXT,
      PRIMARY KEY(repo,issue,anchor_message_id,channel_id));`);
  if (!legacy) return;
  const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(followups_legacy)").all().map(row => row.name));
  // A pre-subscription table names no person or message, so its rows stay as history only.
  if (!["repo", "user_id", "channel_id", "reply_to"].every(name => columns.has(name))) return;
  // Without a delivery_version column an announcement has no delivery proof; it stays history, never re-announced.
  const version = columns.has("delivery_version") ? "delivery_version" : "0";
  const open = db.query<{ repo: string; issue: number; user_id: string; channel_id: string; reply_to: string; kind: string;
    created_at: number; status: string; announcement: string | null; observed_at: number | null }, []>(
    `SELECT repo,issue,user_id,channel_id,reply_to,kind,created_at,status,${columns.has("announcement") ? "announcement" : "NULL"} AS announcement,
      ${columns.has("observed_at") ? "observed_at" : "NULL"} AS observed_at FROM followups_legacy
      WHERE status='open' OR (status='announced' AND ${version}=1)`).all();
  for (const row of open) {
    const url = `https://github.com/${row.repo}/issues/${row.issue}`;
    let anchor = db.query<{ anchor_message_id: string }, [string, string]>(
      `SELECT c.anchor_message_id FROM conversations c WHERE c.anchor_message_id=? OR EXISTS (SELECT 1 FROM transcript t
        WHERE t.channel_id=c.channel_id AND t.user_id=c.user_id AND t.opened_at=c.opened_at AND t.message_id=?)`)
      .get(row.reply_to, row.reply_to)?.anchor_message_id ?? db.query<{ anchor_message_id: string }, [string, string]>(
      "SELECT anchor_message_id FROM conversations WHERE issue=? AND channel_id=? ORDER BY opened_at DESC LIMIT 1")
      .get(url, row.channel_id)?.anchor_message_id;
    if (!anchor) {
      anchor = row.reply_to;
      const opened = Math.max(row.created_at * 1000, (db.query<{ opened_at: number | null }, [string, string]>(
        "SELECT max(opened_at) AS opened_at FROM conversations WHERE channel_id=? AND user_id=?").get(row.channel_id, row.user_id)?.opened_at ?? -1) + 1);
      db.run(`INSERT INTO conversations (channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status,outcome,closed_at,
          summary,resolved_at,issue) VALUES (?,?,?,?,?,?,'resolved','issue',?,?,?,?)`,
      [row.channel_id, row.user_id, opened, opened, anchor, `Issue #${row.issue}`, now, `Issue #${row.issue}`, now, url]);
    }
    db.run(`INSERT OR IGNORE INTO topic_participants VALUES (?,?,?,'issue',?,?,1)`,
      [anchor, row.user_id, row.created_at * 1000, row.channel_id, row.reply_to]);
    db.run(`INSERT OR IGNORE INTO followups (repo,issue,anchor_message_id,kind,created_at,status,announcement,observed_at)
      VALUES (?,?,?,?,?,?,?,?)`, [row.repo, row.issue, anchor, row.kind, row.created_at, row.status, row.announcement, row.observed_at]);
    db.run("DELETE FROM followups_legacy WHERE repo=? AND issue=? AND user_id=?", [row.repo, row.issue, row.user_id]);
  }
}
