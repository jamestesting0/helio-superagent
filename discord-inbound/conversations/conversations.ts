import type { describeMessage } from "../messages/reply-context.ts";
import { conversationDatabase } from "./conversation-db.ts";
import { WorkingStore } from "./working-store.ts";
export { WORKING_WINDOW_MS, snowflakeTime, type Working } from "./working-store.ts";

export type ConversationEntry = ReturnType<typeof describeMessage>["entry"];
export const CONVERSATION_OUTCOMES = ["issue", "duplicate", "not-a-bug", "answered", "declined", "irrelevant", "other", "timed_out"] as const;
export type ConversationOutcome = typeof CONVERSATION_OUTCOMES[number];
export const CONVERSATION_MAX_IDLE_MS = 72 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export type ConversationState = "waiting_on_requester" | "waiting_on_helio" | "on_hold" | "resolved" | "archived";

export interface Conversation {
  readonly channel_id: string;
  readonly user_id: string;
  readonly opened_at: number;
  readonly last_activity: number;
  readonly anchor_message_id: string;
  readonly topic: string;
  readonly status: "open" | "on_hold" | "resolved" | "archived";
  readonly outcome: ConversationOutcome | null;
  readonly closed_at: number | null;
  readonly summary: string;
  readonly hold_reason: string | null;
  readonly nudged_at: number | null;
  readonly resolved_at: number | null;
  readonly archived_at: number | null;
  readonly issue: string | null;
}

export class Conversations extends WorkingStore {
  constructor(path: string, now = Date.now(), busyMs = 5000) { super(conversationDatabase(path, now, busyMs)); }

  open(channel: string, user: string, anchor: string, topic: string, now: number): Conversation {
    if (!topic.trim() || topic.length > 200) throw new TypeError("Topic must be 1-200 characters");
    return this.db.transaction((): Conversation => {
      this.requireSlot(channel, user);
      const opened = this.db.query<{ opened_at: number }, [string, string]>(
        "SELECT max(opened_at) AS opened_at FROM conversations WHERE channel_id=? AND user_id=?",
      ).get(channel, user);
      const opened_at = Math.max(now, (opened?.opened_at ?? -1) + 1);
      const row: Conversation = {
        channel_id: channel, user_id: user, opened_at, last_activity: now,
        anchor_message_id: anchor, topic, status: "open", outcome: null, closed_at: null,
        summary: "", hold_reason: null, nudged_at: null, resolved_at: null, archived_at: null, issue: null,
      };
      this.db.query(`INSERT INTO conversations
        (channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status)
        VALUES (?,?,?,?,?,?,'open')`).run(channel, user, opened_at, now, anchor, topic);
      return row;
    }).immediate();
  }

  close(channel: string, user: string, outcome: ConversationOutcome, now: number, issue?: string): Conversation {
    if (!CONVERSATION_OUTCOMES.includes(outcome)) throw new TypeError("Invalid conversation outcome");
    return this.db.transaction((): Conversation => {
      const row = this.requireOpen(channel, user);
      const summary = row.summary || row.topic;
      this.db.query(`UPDATE conversations SET status='resolved',outcome=?,closed_at=?,resolved_at=?,
        summary=?,hold_reason=NULL,issue=coalesce(?,issue) WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(outcome, now, now, summary, issue ?? null, channel, user, row.opened_at);
      this.db.query("DELETE FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=?")
        .run(channel, user, row.opened_at);
      return { ...row, status: "resolved", outcome, closed_at: now, resolved_at: now,
        summary, hold_reason: null, issue: issue ?? row.issue };
    }).immediate();
  }

  get(channel: string, user: string): Conversation | null {
    return this.db.query<Conversation, [string, string]>(
      "SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND status IN ('open','on_hold')",
    ).get(channel, user);
  }

  latest(channel: string, user: string): Conversation | null {
    return this.db.query<Conversation, [string, string]>(
      "SELECT * FROM conversations WHERE channel_id=? AND user_id=? ORDER BY opened_at DESC LIMIT 1",
    ).get(channel, user);
  }

  recentlyResolved(channel: string, user: string, now: number): Conversation | null {
    return this.db.query<Conversation, [string, string, number]>(`SELECT * FROM conversations
      WHERE channel_id=? AND user_id=? AND status='resolved' AND resolved_at>?
      ORDER BY resolved_at DESC LIMIT 1`).get(channel, user, now - 7 * DAY_MS);
  }

  isOpen(channel: string, user: string): boolean { return this.get(channel, user) !== null; }

  list(): Conversation[] {
    return this.db.query<Conversation, []>(
      "SELECT * FROM conversations WHERE status IN ('open','on_hold') ORDER BY opened_at,channel_id,user_id",
    ).all();
  }

  state(row: Conversation): ConversationState {
    switch (row.status) {
      case "on_hold": case "resolved": case "archived": return row.status;
      case "open": {
        const last = this.transcript(row.channel_id, row.user_id).at(-1);
        return last?.author_id === row.user_id ? "waiting_on_helio" : "waiting_on_requester";
      }
      default: { const unreachable: never = row.status; return unreachable; }
    }
  }

  append(channel: string, user: string, entry: ConversationEntry, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.get(channel, user);
      if (!row) return;
      const claim = this.working(entry.message_id);
      if (entry.author_id === user && (claim?.claimed_at == null || claim.closed_at !== null)) return;
      const inserted = this.db.query(`INSERT OR IGNORE INTO transcript
        (message_id,channel_id,user_id,opened_at,author_id,sent_at,entry) VALUES (?,?,?,?,?,?,?)`)
        .run(entry.message_id, channel, user, row.opened_at, entry.author_id, entry.sent_at ?? null, JSON.stringify(entry));
      if (!inserted.changes) return;
      this.db.query(`UPDATE conversations SET last_activity=max(last_activity,?),nudged_at=NULL,
        status=CASE WHEN ? THEN 'open' ELSE status END,hold_reason=CASE WHEN ? THEN NULL ELSE hold_reason END
        WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(now, entry.author_id === user ? 1 : 0, entry.author_id === user ? 1 : 0, channel, user, row.opened_at);
    }).immediate();
  }

  claim(channel: string, user: string, entry: ConversationEntry, now: number): void {
    this.db.transaction(() => {
      this.claimWorking(channel, user, entry.message_id, now);
      this.append(channel, user, entry, now);
    }).immediate();
  }

  transcript(channel: string, user: string): ConversationEntry[] {
    return this.db.query<{ entry: string }, [string, string]>(`SELECT t.entry FROM transcript t
      JOIN conversations c ON c.channel_id=t.channel_id AND c.user_id=t.user_id AND c.opened_at=t.opened_at
      WHERE c.status IN ('open','on_hold') AND t.channel_id=? AND t.user_id=? ORDER BY t.rowid`)
      .all(channel, user).map((row) => JSON.parse(row.entry));
  }

  note(channel: string, user: string, text: string): void {
    if (!text.trim() || text.length > 600) throw new TypeError("Summary must be 1-600 characters");
    this.requireOpen(channel, user);
    this.db.query("UPDATE conversations SET summary=? WHERE channel_id=? AND user_id=? AND status IN ('open','on_hold')")
      .run(text, channel, user);
  }

  hold(channel: string, user: string, reason: string): void {
    if (!reason.trim() || reason.length > 600) throw new TypeError("Hold reason must be 1-600 characters");
    this.requireOpen(channel, user);
    this.db.query("UPDATE conversations SET status='on_hold',hold_reason=? WHERE channel_id=? AND user_id=? AND status IN ('open','on_hold')")
      .run(reason, channel, user);
  }

  resume(channel: string, user: string): void {
    this.requireOpen(channel, user);
    this.db.query(`UPDATE conversations SET status='open',hold_reason=NULL
      WHERE channel_id=? AND user_id=? AND status='on_hold'`).run(channel, user);
  }

  reopen(channel: string, user: string, now: number): Conversation {
    return this.db.transaction((): Conversation => {
      this.requireSlot(channel, user);
      const row = this.recentlyResolved(channel, user, now);
      if (!row) throw new RangeError("No conversation resolved in the last 7 days; open a new one");
      this.db.query(`UPDATE conversations SET status='open',outcome=NULL,closed_at=NULL,resolved_at=NULL,
        archived_at=NULL,last_activity=?,nudged_at=NULL WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(now, channel, user, row.opened_at);
      return { ...row, status: "open", outcome: null, closed_at: null, resolved_at: null,
        archived_at: null, last_activity: now, nudged_at: null };
    }).immediate();
  }

  markNudged(row: Conversation, now: number): void {
    this.db.query(`UPDATE conversations SET nudged_at=? WHERE channel_id=? AND user_id=? AND opened_at=?
      AND status='open' AND last_activity=?`).run(now, row.channel_id, row.user_id, row.opened_at, row.last_activity);
  }

  recordNotice(messageId: string, now: number): void {
    this.db.query("INSERT OR IGNORE INTO conversation_notices VALUES (?,?)").run(messageId, now);
  }

  isNotice(messageId: string): boolean {
    return this.db.query("SELECT 1 FROM conversation_notices WHERE message_id=?").get(messageId) !== null;
  }

  resolveIfCurrent(row: Conversation, outcome: ConversationOutcome, now: number): void {
    this.db.transaction(() => {
      const current = this.get(row.channel_id, row.user_id);
      if (current?.opened_at === row.opened_at && current.last_activity === row.last_activity) {
        this.close(row.channel_id, row.user_id, outcome, now);
      }
    }).immediate();
  }

  dailyWaiting(now: number): Conversation[] {
    return this.db.transaction(() => {
      const day = Math.floor(now / DAY_MS);
      const previous = this.db.query<{ value: number }, []>(
        "SELECT value FROM conversation_upkeep WHERE name='waiting_day'",
      ).get();
      if (previous?.value === day) return [];
      this.db.query("INSERT OR REPLACE INTO conversation_upkeep VALUES ('waiting_day',?)").run(day);
      return this.list().filter((row) => now - row.last_activity >= DAY_MS && this.state(row) === "waiting_on_helio");
    }).immediate();
  }

  retain(now: number): void {
    this.db.transaction(() => {
      this.db.query(`UPDATE conversations SET status='archived',archived_at=resolved_at+?
        WHERE status='resolved' AND resolved_at<=?`).run(7 * DAY_MS, now - 7 * DAY_MS);
      this.db.query("DELETE FROM conversations WHERE status='archived' AND archived_at<=?").run(now - 30 * DAY_MS);
      this.db.query("DELETE FROM conversation_notices WHERE created_at<=?").run(now - 37 * DAY_MS);
      this.db.exec(`DELETE FROM conversation_migrations WHERE NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.channel_id=conversation_migrations.channel_id
          AND c.user_id=conversation_migrations.user_id AND c.opened_at=conversation_migrations.opened_at)`);
    }).immediate();
  }

  resolveLegacy(now: number): Conversation[] {
    return this.db.transaction(() => {
      const rows = this.db.query<Conversation, []>(`SELECT c.* FROM conversations c JOIN conversation_migrations m
        USING(channel_id,user_id,opened_at) WHERE m.resolved_at IS NULL AND c.status='open'
        AND NOT EXISTS (SELECT 1 FROM working w WHERE w.channel_id=c.channel_id AND w.user_id=c.user_id
          AND w.claimed_at>=m.migrated_at)`).all();
      for (const row of rows) {
        this.close(row.channel_id, row.user_id, "other", now);
        this.db.query(`UPDATE conversation_migrations SET resolved_at=?
          WHERE channel_id=? AND user_id=? AND opened_at=?`).run(now, row.channel_id, row.user_id, row.opened_at);
      }
      this.db.exec("DELETE FROM conversation_migrations WHERE resolved_at IS NULL");
      return rows;
    }).immediate();
  }

  private requireOpen(channel: string, user: string): Conversation {
    const row = this.get(channel, user);
    if (!row) throw new RangeError("No open conversation in this channel");
    return row;
  }

  private requireSlot(channel: string, user: string): void {
    if (this.isOpen(channel, user)) throw new RangeError("Conversation already open in this channel");
    if (this.list().filter((row) => row.user_id === user).length >= 2) throw new RangeError("User already has 2 open conversations");
  }
}
