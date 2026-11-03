import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { describeMessage } from "./reply-context.ts";

export type ConversationEntry = ReturnType<typeof describeMessage>["entry"];
export const CONVERSATION_OUTCOMES = ["issue", "duplicate", "not-a-bug", "answered", "declined", "irrelevant", "other"] as const;
export type ConversationOutcome = typeof CONVERSATION_OUTCOMES[number];
export const CONVERSATION_MAX_IDLE_MS = 72 * 60 * 60 * 1000;
/** A ping opens a working window: the sender's later messages in that channel count as additions until Helio replies. */
export const WORKING_WINDOW_MS = 30 * 60 * 1000;
export const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + 1420070400000n);

export interface Working {
  readonly message_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly started_at: number;
  readonly closed_at: number | null;
  /** 1 while Helio's 👀 is (or may still be) on the message. */
  readonly reacted: number;
  readonly warned: number;
  readonly guards: number;
  readonly first_guard_at: number | null;
}

export interface Conversation {
  readonly channel_id: string;
  readonly user_id: string;
  readonly opened_at: number;
  readonly last_activity: number;
  readonly anchor_message_id: string;
  readonly topic: string;
  readonly status: "open" | "closed" | "timed_out";
  readonly outcome: ConversationOutcome | null;
  readonly closed_at: number | null;
}

export class Conversations {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000;");
    const deadline = Date.now() + 5000;
    for (;;) {
      try { this.db.exec("PRAGMA journal_mode=WAL;"); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) ||
            error.code !== "SQLITE_BUSY" || Date.now() >= deadline) {
          this.db.close();
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations (
        channel_id TEXT NOT NULL, user_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL, anchor_message_id TEXT NOT NULL, topic TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','closed','timed_out')),
        outcome TEXT, closed_at INTEGER, PRIMARY KEY(channel_id,user_id,opened_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_open
        ON conversations(channel_id,user_id) WHERE status = 'open';
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
  }

  open(channel: string, user: string, anchor: string, topic: string, now: number): Conversation {
    if (!topic.trim() || topic.length > 200) throw new TypeError("Topic must be 1-200 characters");
    return this.db.transaction(() => {
      if (this.isOpen(channel, user)) throw new RangeError("Conversation already open in this channel");
      if (this.list().filter((row) => row.user_id === user).length >= 2) {
        throw new RangeError("User already has 2 open conversations");
      }
      const row: Conversation = {
        channel_id: channel, user_id: user, opened_at: now, last_activity: now,
        anchor_message_id: anchor, topic, status: "open", outcome: null, closed_at: null,
      };
      this.db.query(`INSERT INTO conversations
        (channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status)
        VALUES (?,?,?,?,?,?,'open')`).run(channel, user, now, now, anchor, topic);
      return row;
    }).immediate();
  }

  close(channel: string, user: string, outcome: ConversationOutcome, now: number): Conversation {
    if (!CONVERSATION_OUTCOMES.includes(outcome)) throw new TypeError("Invalid conversation outcome");
    return this.db.transaction((): Conversation => {
      const row = this.get(channel, user);
      if (!row) throw new RangeError("No open conversation in this channel");
      this.finish(row, "closed", outcome, now);
      return { ...row, status: "closed", outcome, closed_at: now };
    }).immediate();
  }

  get(channel: string, user: string): Conversation | null {
    return this.db.query<Conversation, [string, string]>(
      "SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND status='open'",
    ).get(channel, user);
  }

  isOpen(channel: string, user: string): boolean { return this.get(channel, user) !== null; }

  list(): Conversation[] {
    return this.db.query<Conversation, []>(
      "SELECT * FROM conversations WHERE status='open' ORDER BY opened_at,channel_id,user_id",
    ).all();
  }

  touch(channel: string, user: string, now: number): void {
    this.db.query("UPDATE conversations SET last_activity=max(last_activity,?) WHERE channel_id=? AND user_id=? AND status='open'")
      .run(now, channel, user);
  }

  append(channel: string, user: string, entry: ConversationEntry): void {
    this.db.transaction(() => {
      const row = this.get(channel, user);
      if (!row) return;
      this.db.query(`INSERT OR IGNORE INTO transcript
        (message_id,channel_id,user_id,opened_at,author_id,sent_at,entry) VALUES (?,?,?,?,?,?,?)`)
        .run(entry.message_id, channel, user, row.opened_at, entry.author_id, entry.sent_at ?? null, JSON.stringify(entry));
    }).immediate();
  }

  transcript(channel: string, user: string): ConversationEntry[] {
    return this.db.query<{ entry: string }, [string, string]>(`SELECT t.entry FROM transcript t
      JOIN conversations c ON c.channel_id=t.channel_id AND c.user_id=t.user_id AND c.opened_at=t.opened_at
      WHERE c.status='open' AND t.channel_id=? AND t.user_id=?
      ORDER BY length(t.message_id),t.message_id`).all(channel, user).map((row) => JSON.parse(row.entry));
  }

  timeouts(now: number): Conversation[] {
    return this.db.transaction((): Conversation[] => {
      const rows = this.db.query<Conversation, [number]>(
        "SELECT * FROM conversations WHERE status='open' AND last_activity < ? ORDER BY opened_at,channel_id,user_id",
      ).all(now - CONVERSATION_MAX_IDLE_MS);
      for (const row of rows) this.finish(row, "timed_out", null, now);
      return rows.map((row) => ({ ...row, status: "timed_out", closed_at: now }));
    }).immediate();
  }

  /** Opens a working window anchored at `messageId`, unless one is already open for this person here. */
  openWorking(channel: string, user: string, messageId: string, now: number): Working {
    return this.db.transaction((): Working => {
      const open = this.db.query<Working, [string, string, number]>(`SELECT * FROM working
        WHERE channel_id=? AND user_id=? AND closed_at IS NULL AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1`).get(channel, user, now - WORKING_WINDOW_MS);
      if (open) return open;
      this.db.query("INSERT OR IGNORE INTO working (message_id,channel_id,user_id,started_at) VALUES (?,?,?,?)")
        .run(messageId, channel, user, snowflakeTime(messageId));
      return this.working(messageId)!;
    }).immediate();
  }

  /** Ensures a row for `messageId` itself (used when Helio starts on a message that opened no window). */
  ensureWorking(channel: string, user: string, messageId: string): Working {
    this.db.query("INSERT OR IGNORE INTO working (message_id,channel_id,user_id,started_at) VALUES (?,?,?,?)")
      .run(messageId, channel, user, snowflakeTime(messageId));
    return this.working(messageId)!;
  }

  working(messageId: string): Working | null {
    return this.db.query<Working, [string]>("SELECT * FROM working WHERE message_id=?").get(messageId);
  }

  /**
   * The anchor whose window contained this message when it was sent. Decided by message time, not by
   * the current state, so re-checking a delivery later gives the same answer.
   */
  workingAnchor(channel: string, user: string, messageId: string): string | undefined {
    const sent = snowflakeTime(messageId);
    return this.db.query<{ message_id: string }, [string, string, string, number, number, number]>(`SELECT message_id FROM working
      WHERE channel_id=? AND user_id=? AND message_id<>? AND started_at < ?
        AND ? <= min(coalesce(closed_at, started_at + ${WORKING_WINDOW_MS}), started_at + ${WORKING_WINDOW_MS})
        AND started_at >= ? - ${WORKING_WINDOW_MS}
      ORDER BY started_at DESC LIMIT 1`).get(channel, user, messageId, sent, sent, sent)?.message_id;
  }

  setReacted(messageId: string, reacted: boolean): void {
    this.db.query("UPDATE working SET reacted=? WHERE message_id=?").run(reacted ? 1 : 0, messageId);
  }

  markWarned(messageId: string): void {
    this.db.query("UPDATE working SET warned=1 WHERE message_id=?").run(messageId);
  }

  /** Closes the listed windows; returns those that may still carry Helio's 👀. */
  closeWorking(messageIds: readonly string[], now: number): Working[] {
    return this.db.transaction((): Working[] => {
      const out: Working[] = [];
      for (const id of new Set(messageIds)) {
        this.db.query("UPDATE working SET closed_at=? WHERE message_id=? AND closed_at IS NULL").run(now, id);
        const row = this.working(id);
        if (row?.reacted) out.push(row);
      }
      return out;
    }).immediate();
  }

  /** Allows holding a reply for newer messages at most `limit` times within `withinMs` of the first hold. */
  holdReply(channel: string, user: string, messageId: string, now: number, limit = 2, withinMs = 120_000): boolean {
    return this.db.transaction((): boolean => {
      const row = this.ensureWorking(channel, user, messageId);
      if (row.guards >= limit || (row.first_guard_at !== null && now - row.first_guard_at >= withinMs)) return false;
      this.db.query("UPDATE working SET guards=guards+1, first_guard_at=coalesce(first_guard_at,?) WHERE message_id=?").run(now, messageId);
      return true;
    }).immediate();
  }

  openWorkingRows(): Working[] {
    return this.db.query<Working, []>("SELECT * FROM working WHERE closed_at IS NULL OR reacted=1 ORDER BY started_at").all();
  }

  pruneWorking(now: number): void {
    this.db.query("DELETE FROM working WHERE reacted=0 AND coalesce(closed_at, started_at) < ?").run(now - CONVERSATION_MAX_IDLE_MS);
  }

  dispose(): void { this.db.close(); }

  private finish(row: Conversation, status: "closed" | "timed_out", outcome: ConversationOutcome | null, now: number): void {
    this.db.query("UPDATE conversations SET status=?,outcome=?,closed_at=? WHERE channel_id=? AND user_id=? AND opened_at=?")
      .run(status, outcome, now, row.channel_id, row.user_id, row.opened_at);
    this.db.query("DELETE FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=?")
      .run(row.channel_id, row.user_id, row.opened_at);
  }
}

/** The injected clock also keeps startup and periodic sweeps deterministic. */
export function conversationTimeoutReporter(
  store: Conversations, emit: (line: string) => void, now: () => number = () => Date.now(),
): () => void {
  return () => {
    for (const row of store.timeouts(now())) {
      const { channel_id, user_id, anchor_message_id, topic, opened_at } = row;
      emit(`INBOUND_CONVERSATION_TIMEOUT ${JSON.stringify({ channel_id, user_id, anchor_message_id, topic, opened_at })}`);
    }
  };
}
