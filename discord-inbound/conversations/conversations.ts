import type { describeMessage } from "../messages/reply-context.ts";
import { conversationDatabase } from "./conversation-db.ts";
import { WorkingStore } from "./working-store.ts";
import type { ReplyMeaning } from "./reply-settlement.ts";
import { NoticeStore, type NoticeIntent } from "./notice-store.ts";
import { TopicReconciliation } from "./reconcile-topic.ts";
export { WORKING_WINDOW_MS, snowflakeTime, type Working } from "./working-store.ts";

export type ConversationEntry = ReturnType<typeof describeMessage>["entry"];
export const CONVERSATION_OUTCOMES = ["issue", "duplicate", "not-a-bug", "answered", "declined", "irrelevant", "other", "timed_out"] as const;
export type ConversationOutcome = typeof CONVERSATION_OUTCOMES[number];
export const CONVERSATION_MAX_IDLE_MS = 72 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export type ConversationState = "waiting_on_requester" | "waiting_on_helio" | "on_hold" | "resolved" | "archived";
export type ConversationAdminAction =
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "resume" }
  | { readonly kind: "close"; readonly outcome: ConversationOutcome }
  | { readonly kind: "reopen" };

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
  readonly request: string;
  readonly decided: string;
  readonly waiting_on: string;
  readonly result: string;
  readonly revision: number;
  readonly job: string | null;
  readonly reply_disposition: string | null;
  readonly question_started_at: number | null;
  readonly question_generation: number;
  readonly last_reply_key: string | null;
  readonly latest_input_id: string | null;
}
export type TopicRevision = Pick<Conversation,
  "channel_id" | "user_id" | "opened_at" | "anchor_message_id" | "revision" | "last_activity"> & {
    readonly covered?: readonly string[];
  };

export const UNDERSTANDING_FIELDS = ["request", "decided", "waiting_on", "result"] as const;
export type Understanding = Partial<Record<typeof UNDERSTANDING_FIELDS[number], string>>;

export class Conversations extends WorkingStore {
  readonly notices: NoticeStore;
  readonly reconciliation: TopicReconciliation;
  constructor(path: string, now = Date.now(), busyMs = 5000) {
    super(conversationDatabase(path, now, busyMs));
    this.notices = new NoticeStore(this.db);
    this.reconciliation = new TopicReconciliation(this.db);
  }

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
        request: "", decided: "", waiting_on: "", result: "",
        revision: 0, job: null, reply_disposition: null, question_started_at: null, question_generation: 0, last_reply_key: null,
        latest_input_id: anchor,
      };
      this.db.query(`INSERT INTO conversations
        (channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status,latest_input_id)
        VALUES (?,?,?,?,?,?,'open',?)`).run(channel, user, opened_at, now, anchor, topic, anchor);
      // A claim can precede topic selection. The new anchor belongs only to this topic, not the previous default.
      this.db.query("UPDATE transcript SET opened_at=? WHERE channel_id=? AND user_id=? AND message_id=?")
        .run(opened_at, channel, user, anchor);
      return row;
    }).immediate();
  }

  close(channel: string, user: string, outcome: ConversationOutcome, now: number, issue?: string, topic?: string): Conversation {
    if (!CONVERSATION_OUTCOMES.includes(outcome)) throw new TypeError("Invalid conversation outcome");
    return this.db.transaction((): Conversation => {
      const row = this.requireOpen(channel, user, topic);
      const summary = row.summary || row.topic;
      this.db.query(`UPDATE conversations SET status='resolved',outcome=?,closed_at=?,resolved_at=?,
        summary=?,hold_reason=NULL,issue=coalesce(?,issue),revision=revision+1 WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(outcome, now, now, summary, issue ?? null, channel, user, row.opened_at);
      this.db.query("DELETE FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=?")
        .run(channel, user, row.opened_at);
      return { ...row, status: "resolved", outcome, closed_at: now, resolved_at: now,
        summary, hold_reason: null, issue: issue ?? row.issue, revision: row.revision + 1 };
    }).immediate();
  }

  /** Links an open conversation to the issue it is about; an existing link is kept. */
  linkIssue(channel: string, user: string, issue: string): void {
    const row = this.get(channel, user);
    if (row && !row.issue) {
      this.db.query("UPDATE conversations SET issue=? WHERE channel_id=? AND user_id=? AND opened_at=?")
        .run(issue, channel, user, row.opened_at);
    }
  }

  /** The person's most recently active conversation in this channel; commands act on it unless a topic is named. */
  get(channel: string, user: string, topic?: string): Conversation | null {
    return this.db.query<Conversation, [string, string, string | null, string | null]>(
      `SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND status IN ('open','on_hold')
        AND (? IS NULL OR anchor_message_id=?) ORDER BY last_activity DESC, opened_at DESC LIMIT 1`,
    ).get(channel, user, topic ?? null, topic ?? null);
  }

  /** Explicit replies never fall through; an unthreaded continuation needs exactly one active topic. */
  forReply(channel: string, user: string, replyTo?: string): Conversation | null {
    if (replyTo) {
      const owner = this.db.query<Conversation, [string, string, string, string]>(`SELECT c.* FROM conversations c
        WHERE c.channel_id=? AND c.user_id=? AND c.status IN ('open','on_hold') AND (c.anchor_message_id=? OR EXISTS (
          SELECT 1 FROM transcript t WHERE t.channel_id=c.channel_id AND t.user_id=c.user_id AND t.opened_at=c.opened_at
            AND t.message_id=?)) ORDER BY c.last_activity DESC LIMIT 1`).get(channel, user, replyTo, replyTo);
      return owner;
    }
    const rows = this.list().filter(row => row.channel_id === channel && row.user_id === user);
    return rows.length === 1 ? rows[0]! : null;
  }

  belongs(row: Conversation, messageId: string): boolean {
    return row.anchor_message_id === messageId || this.transcriptOf(row).some((entry) => entry.message_id === messageId);
  }

  /** Any retained conversation (open, resolved or archived) with this anchor, for reading only. */
  byAnchor(channel: string, user: string, anchor: string): Conversation | null {
    return this.db.query<Conversation, [string, string, string]>(
      "SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND anchor_message_id=? ORDER BY opened_at DESC LIMIT 1",
    ).get(channel, user, anchor);
  }

  latest(channel: string, user: string): Conversation | null {
    return this.db.query<Conversation, [string, string]>(
      "SELECT * FROM conversations WHERE channel_id=? AND user_id=? ORDER BY opened_at DESC LIMIT 1",
    ).get(channel, user);
  }

  recentlyResolved(channel: string, user: string, now: number, topic?: string): Conversation | null {
    return this.db.query<Conversation, [string, string, number, string | null, string | null]>(`SELECT * FROM conversations
      WHERE channel_id=? AND user_id=? AND status='resolved' AND resolved_at>?
      AND (? IS NULL OR anchor_message_id=?)
      ORDER BY resolved_at DESC LIMIT 1`).get(channel, user, now - 7 * DAY_MS, topic ?? null, topic ?? null);
  }

  isOpen(channel: string, user: string): boolean { return this.get(channel, user) !== null; }

  talkedRecently(channel: string, user: string, now: number): boolean {
    return this.isOpen(channel, user) || this.recentlyResolved(channel, user, now) !== null;
  }

  list(): Conversation[] {
    return this.db.query<Conversation, []>(
      "SELECT * FROM conversations WHERE status IN ('open','on_hold') ORDER BY opened_at,channel_id,user_id",
    ).all();
  }

  /**
   * A new message from the requester always needs Helio. Otherwise the structured `waiting_on` decides; a conversation
   * without a delivered question remains an internal Helio review.
   */
  state(row: Conversation): ConversationState {
    switch (row.status) {
      case "on_hold": case "resolved": case "archived": return row.status;
      case "open": {
        if (row.reply_disposition === "question" && row.waiting_on && row.question_started_at !== null) return "waiting_on_requester";
        return "waiting_on_helio";
      }
      default: { const unreachable: never = row.status; return unreachable; }
    }
  }

  append(channel: string, user: string, entry: ConversationEntry, now = Date.now()): void {
    if (this.isNotice(entry.message_id)) return;
    this.db.transaction(() => {
      const row = this.get(channel, user, entry.message_id) ?? this.forReply(channel, user, entry.reply_to);
      if (!row) return;
      const claim = this.working(entry.message_id);
      if (entry.author_id === user && (claim?.claimed_at == null || claim.closed_at !== null)) return;
      const inserted = this.db.query(`INSERT OR IGNORE INTO transcript
        (message_id,channel_id,user_id,opened_at,author_id,sent_at,entry) VALUES (?,?,?,?,?,?,?)`)
        .run(entry.message_id, channel, user, row.opened_at, entry.author_id, entry.sent_at ?? null, JSON.stringify(entry));
      if (!inserted.changes) return;
      if (entry.author_id === user) this.observeInput(channel, user, entry.message_id, now, entry.reply_to);
      this.db.query(`UPDATE conversations SET last_activity=max(last_activity,?),nudged_at=NULL,
        waiting_on=CASE WHEN ? THEN '' ELSE waiting_on END,
        question_started_at=NULL,reply_disposition=NULL
        WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(now, entry.author_id === user ? 1 : 0, channel, user, row.opened_at);
    }).immediate();
  }

  /** Authorized, prepared input invalidates a covered revision before the lead claims its turn. */
  observeInput(channel: string, user: string, messageId: string, now: number, replyTo?: string): void {
    this.db.transaction(() => {
      const row = this.get(channel, user, messageId) ?? this.forReply(channel, user, replyTo);
      if (!row || (row.latest_input_id && BigInt(messageId) <= BigInt(row.latest_input_id))) return;
      this.db.run(`UPDATE conversations SET latest_input_id=?,revision=revision+1,last_activity=max(last_activity,?),
        waiting_on='',question_started_at=NULL,reply_disposition=NULL,nudged_at=NULL
        WHERE channel_id=? AND user_id=? AND opened_at=?`, [messageId, now, channel, user, row.opened_at]);
    }).immediate();
  }

  claim(channel: string, user: string, entry: ConversationEntry, now: number): void {
    this.db.transaction(() => {
      this.claimWorking(channel, user, entry.message_id, now);
      this.append(channel, user, entry, now);
    }).immediate();
  }

  transcriptOf(row: Conversation): ConversationEntry[] {
    return this.db.query<{ entry: string }, [string, string, number]>(
      "SELECT entry FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=? ORDER BY rowid",
    ).all(row.channel_id, row.user_id, row.opened_at).map((entry) => JSON.parse(entry.entry));
  }

  /** Every active topic's entries for this person in this channel. */
  transcript(channel: string, user: string): ConversationEntry[] {
    return this.db.query<{ entry: string }, [string, string]>(`SELECT t.entry FROM transcript t
      JOIN conversations c ON c.channel_id=t.channel_id AND c.user_id=t.user_id AND c.opened_at=t.opened_at
      WHERE c.status IN ('open','on_hold') AND t.channel_id=? AND t.user_id=? ORDER BY t.rowid`)
      .all(channel, user).map((row) => JSON.parse(row.entry));
  }

  note(channel: string, user: string, text: string, topic?: string): void {
    if (!text.trim() || text.length > 600) throw new TypeError("Summary must be 1-600 characters");
    const row = this.requireOpen(channel, user, topic);
    this.db.query("UPDATE conversations SET summary=? WHERE channel_id=? AND user_id=? AND opened_at=?")
      .run(text, channel, user, row.opened_at);
  }

  /** Records what Helio understood; an empty string clears a field. */
  setState(channel: string, user: string, fields: Understanding & { readonly job?: string; readonly issue?: string }, topic?: string): void {
    const entries = UNDERSTANDING_FIELDS.flatMap((name) => fields[name] === undefined ? [] : [[name, fields[name]] as const]);
    const task = (["job", "issue"] as const).flatMap(name => fields[name] === undefined ? [] : [[name, fields[name]] as const]);
    if (fields.job !== undefined && (!/^[a-z0-9][a-z0-9._-]{1,60}$/.test(fields.job) || fields.job.includes(".."))) throw new TypeError("Invalid stable job");
    if (fields.issue !== undefined && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(fields.issue)) {
      throw new TypeError("Expected canonical issue URL");
    }
    if (!entries.length && !task.length) throw new TypeError("Nothing to set");
    for (const [name, value] of entries) if (value.length > 300) throw new TypeError(`${name} must be at most 300 characters`);
    const row = this.requireOpen(channel, user, topic);
    for (const [name, value] of task) {
      if (row[name] && row[name] !== value) throw new RangeError(`Topic already belongs to another ${name}`);
    }
    const updates = [...entries, ...task];
    this.db.query(`UPDATE conversations SET revision=revision+1,
      ${fields.waiting_on !== undefined ? "question_started_at=NULL,reply_disposition=NULL," : ""}
      ${updates.map(([name]) => `${name}=?`).join(",")}
      WHERE channel_id=? AND user_id=? AND opened_at=?`).run(...updates.map(([, value]) => value), channel, user, row.opened_at);
  }

  hold(channel: string, user: string, reason: string, topic?: string): void {
    if (!reason.trim() || reason.length > 600) throw new TypeError("Hold reason must be 1-600 characters");
    const row = this.requireOpen(channel, user, topic);
    this.db.query("UPDATE conversations SET revision=revision+1,status='on_hold',hold_reason=? WHERE channel_id=? AND user_id=? AND opened_at=?")
      .run(reason, channel, user, row.opened_at);
  }

  resume(channel: string, user: string, topic?: string): void {
    const row = this.requireOpen(channel, user, topic);
    this.db.query(`UPDATE conversations SET revision=revision+1,status='open',hold_reason=NULL
      WHERE channel_id=? AND user_id=? AND opened_at=? AND status='on_hold'`).run(channel, user, row.opened_at);
  }

  reopen(channel: string, user: string, now: number, topic?: string): Conversation {
    return this.db.transaction((): Conversation => {
      this.requireSlot(channel, user);
      const row = this.recentlyResolved(channel, user, now, topic);
      if (!row) throw new RangeError("No conversation resolved in the last 7 days; open a new one");
      this.db.query(`UPDATE conversations SET status='open',outcome=NULL,closed_at=NULL,resolved_at=NULL,
        revision=revision+1,waiting_on='',question_started_at=NULL,last_reply_key=NULL,reply_disposition=NULL,
        archived_at=NULL,last_activity=?,nudged_at=NULL WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(now, channel, user, row.opened_at);
      return { ...row, status: "open", outcome: null, closed_at: null, resolved_at: null,
        archived_at: null, last_activity: now, nudged_at: null, revision: row.revision + 1, waiting_on: "",
        question_started_at: null, last_reply_key: null, reply_disposition: null };
    }).immediate();
  }

  administer(operation: string, actor: string, expected: TopicRevision, action: ConversationAdminAction, now: number): Conversation {
    const fingerprint = JSON.stringify([actor, expected.channel_id, expected.user_id, expected.opened_at,
      expected.anchor_message_id, expected.revision, action]);
    return this.db.transaction(() => {
      const applied = this.db.query<{ fingerprint: string; result: string }, [string]>(
        "SELECT fingerprint,result FROM conversation_admin_operations WHERE id=?").get(operation);
      if (applied) {
        if (applied.fingerprint !== fingerprint) throw new RangeError("Administration operation was already used");
        return JSON.parse(applied.result);
      }
      const row = this.byAnchor(expected.channel_id, expected.user_id, expected.anchor_message_id);
      if (!row || row.opened_at !== expected.opened_at || row.revision !== expected.revision) {
        throw new RangeError("Conversation changed; refresh its preview");
      }
      switch (action.kind) {
        case "hold": this.hold(row.channel_id, row.user_id, action.reason, row.anchor_message_id); break;
        case "resume":
          if (row.status !== "on_hold") throw new RangeError("Conversation is not on hold");
          this.resume(row.channel_id, row.user_id, row.anchor_message_id);
          break;
        case "close": this.close(row.channel_id, row.user_id, action.outcome, now, undefined, row.anchor_message_id); break;
        case "reopen":
          if (row.status !== "resolved") throw new RangeError("Conversation is not resolved");
          this.reopen(row.channel_id, row.user_id, now, row.anchor_message_id);
          break;
        default: { const unreachable: never = action; return unreachable; }
      }
      const result = this.byAnchor(row.channel_id, row.user_id, row.anchor_message_id);
      if (!result || result.opened_at !== row.opened_at) throw new RangeError("Conversation changed during administration");
      this.db.query("INSERT INTO conversation_admin_operations VALUES (?,?,?,?)")
        .run(operation, fingerprint, JSON.stringify(result), now);
      return result;
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

  observeNotice(channel: string, nonce: string | number | undefined, messageId: string, now: number): boolean {
    return this.notices.observe(channel, nonce, messageId, now) || this.isNotice(messageId);
  }

  settleNotice(intent: NoticeIntent, now: number): void {
    this.db.transaction(() => {
      if (!intent.message_id || intent.settled) return;
      if (this.notices.current(intent)) {
        const row = this.db.query<Conversation, [string, string, number]>(
          "SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND opened_at=?")
          .get(intent.channel_id, intent.user_id, intent.opened_at)!;
        if (intent.kind === "timeout") this.resolveIfCurrent(row, "timed_out", now);
        else this.markNudged(row, now);
      }
      this.notices.markSettled(intent);
    }).immediate();
  }

  resolveIfCurrent(row: Conversation, outcome: ConversationOutcome, now: number): void {
    this.db.transaction(() => {
      const current = this.get(row.channel_id, row.user_id, row.anchor_message_id);
      if (current?.opened_at === row.opened_at && current.revision === row.revision && current.last_activity === row.last_activity) {
        this.close(row.channel_id, row.user_id, outcome, now, undefined, row.anchor_message_id);
      }
    }).immediate();
  }

  /** Compare the covered human revision; a retry recognizes its own already-applied receipt. */
  applyReply(row: TopicRevision, meaning: ReplyMeaning, now: number, key?: string): "applied" | "newer-input" {
    return this.db.transaction(() => {
      const current = this.byAnchor(row.channel_id, row.user_id, row.anchor_message_id);
      if (key && current?.last_reply_key === key) return "applied";
      if (!current || current.opened_at !== row.opened_at || current.revision !== row.revision ||
          current.status !== "open") return "newer-input";
      const lastHuman = this.transcriptOf(current).findLast(entry => entry.author_id === row.user_id);
      if (row.covered && lastHuman && !row.covered.includes(lastHuman.message_id)) return "newer-input";
      if (row.covered && current.latest_input_id && !row.covered.includes(current.latest_input_id)) return "newer-input";
      if (meaning.disposition === "question" && !meaning.waiting_on?.trim()) throw new TypeError("Question requires waiting_on");
      this.db.run(`UPDATE conversations SET reply_disposition=?,waiting_on=?,question_started_at=?,
        question_generation=question_generation+?,last_reply_key=?,job=coalesce(job,?),issue=coalesce(issue,?),
        revision=revision+? WHERE channel_id=? AND user_id=? AND opened_at=?`,
      [meaning.disposition, meaning.disposition === "question" ? meaning.waiting_on! : "",
        meaning.disposition === "question" ? now : null, meaning.disposition === "question" ? 1 : 0,
        key ?? null, meaning.job ?? null, meaning.issue ?? null, meaning.disposition === "final" ? 0 : 1,
        row.channel_id, row.user_id, row.opened_at]);
      if (meaning.disposition === "final") this.close(row.channel_id, row.user_id, "answered", now, undefined, row.anchor_message_id);
      return "applied";
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
      // Raw conversation text has a 30-day ceiling counted from resolution, archived or not.
      this.db.query("DELETE FROM conversations WHERE status='archived' AND resolved_at<=?").run(now - 30 * DAY_MS);
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
        this.close(row.channel_id, row.user_id, "other", now, undefined, row.anchor_message_id);
        this.db.query(`UPDATE conversation_migrations SET resolved_at=?
          WHERE channel_id=? AND user_id=? AND opened_at=?`).run(now, row.channel_id, row.user_id, row.opened_at);
      }
      this.db.exec("DELETE FROM conversation_migrations WHERE resolved_at IS NULL");
      return rows;
    }).immediate();
  }

  private requireOpen(channel: string, user: string, topic?: string): Conversation {
    const row = this.get(channel, user, topic);
    if (!row) throw new RangeError(topic ? `No open conversation with topic anchor ${topic} in this channel` : "No open conversation in this channel");
    return row;
  }

  private requireSlot(_channel: string, user: string): void {
    if (this.list().filter((row) => row.user_id === user).length >= 2) throw new RangeError("User already has 2 open conversations");
  }
}
