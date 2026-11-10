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
  /** Who and where Helio's delivered question waits on; a topic's opener and origin channel for legacy rows. */
  readonly waiting_on_user: string | null;
  readonly question_channel_id: string | null;
  readonly question_message_id: string | null;
  readonly merged_into: string | null;
}
export type TopicRevision = Pick<Conversation,
  "channel_id" | "user_id" | "opened_at" | "anchor_message_id" | "revision" | "last_activity"> & {
    readonly covered?: readonly string[];
    /** Where the reply was sent and whose message it answered; a question waits on that person there. */
    readonly reply_channel?: string;
    readonly asked_user?: string;
    readonly asked_message?: string;
  };

/** Who may see a message: untrusted chats, the trusted chat and its threads, or one DM. */
export type Audience = "public" | "staff" | "dm";
export interface Placement { readonly channel: string; readonly audience: Audience }
export const PARTICIPANT_VIA = ["opened", "answered", "covered", "lead", "merge", "issue"] as const;
export interface Participant {
  readonly anchor_message_id: string;
  readonly user_id: string;
  readonly joined_at: number;
  readonly via: typeof PARTICIPANT_VIA[number];
  readonly last_channel_id: string;
  readonly last_message_id: string;
  readonly notify: number;
}
const VISIBLE: Record<Audience, readonly Audience[]> = { public: ["public"], staff: ["public", "staff"], dm: ["public", "staff", "dm"] };
/** Everyone in a channel saw what was said there; elsewhere a DM entry is never shown and the audience matrix applies. */
export function visibleTo(entry: { readonly audience: Audience; readonly message_channel_id: string }, viewer: Placement): boolean {
  return entry.message_channel_id === viewer.channel || (entry.audience !== "dm" && VISIBLE[viewer.audience].includes(entry.audience));
}

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
        latest_input_id: anchor, waiting_on_user: null, question_channel_id: null, question_message_id: null, merged_into: null,
      };
      if (this.db.query("SELECT 1 FROM conversations WHERE anchor_message_id=?").get(anchor)) {
        throw new RangeError("This message already anchors a topic; reopen or merge it instead");
      }
      this.db.query(`INSERT INTO conversations
        (channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status,latest_input_id)
        VALUES (?,?,?,?,?,?,'open',?)`).run(channel, user, opened_at, now, anchor, topic, anchor);
      this.db.query("INSERT INTO topic_participants VALUES (?,?,?,'opened',?,?,1)").run(anchor, user, now, channel, anchor);
      // A claim can precede topic selection. The new anchor belongs only to this topic, wherever it was recorded.
      this.db.query("UPDATE transcript SET channel_id=?,user_id=?,opened_at=? WHERE message_id=? AND is_helio=0")
        .run(channel, user, opened_at, anchor);
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
        .run(outcome, now, now, summary, issue ?? null, row.channel_id, row.user_id, row.opened_at);
      // Text goes now; message IDs stay until archiving so a later reply still finds its topic.
      this.db.query("UPDATE transcript SET entry=NULL WHERE channel_id=? AND user_id=? AND opened_at=?")
        .run(row.channel_id, row.user_id, row.opened_at);
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

  /**
   * An active topic. A named topic is found by its anchor alone; otherwise the person's most recently active topic
   * present in this channel (opened here, or where they last spoke on it).
   */
  get(channel: string, user: string, topic?: string): Conversation | null {
    if (topic) {
      return this.db.query<Conversation, [string]>(
        "SELECT * FROM conversations WHERE anchor_message_id=? AND status IN ('open','on_hold')").get(topic);
    }
    return this.presentIn(channel, user)[0] ?? null;
  }

  /** Active topics this person takes part in that are present in this channel, most recent first. */
  private presentIn(channel: string, user: string): Conversation[] {
    return this.db.query<Conversation, [string, string, string]>(`SELECT c.* FROM conversations c
      JOIN topic_participants p ON p.anchor_message_id=c.anchor_message_id AND p.user_id=?
      WHERE c.status IN ('open','on_hold') AND (c.channel_id=? OR p.last_channel_id=?)
      ORDER BY c.last_activity DESC, c.opened_at DESC`).all(user, channel, channel);
  }

  /**
   * The active topic a person's message belongs to: an explicit reply into a topic, an answer to the question that
   * waits on this person in this channel, or an unthreaded continuation of their only topic present here.
   * A reply that matches no active topic never falls into another one.
   */
  forReply(channel: string, user: string, replyTo?: string): Conversation | null {
    if (replyTo) return this.topicOfMessage(replyTo);
    const awaited = this.list().filter(row => this.state(row) === "waiting_on_requester" &&
      (row.waiting_on_user ?? row.user_id) === user && (row.question_channel_id ?? row.channel_id) === channel);
    if (awaited.length === 1) return awaited[0]!;
    const rows = this.presentIn(channel, user);
    return rows.length === 1 ? rows[0]! : null;
  }

  /** The topic holding this message (anchor or recorded entry), following merges; resolved topics only on request. */
  topicOfMessage(messageId: string, now?: number): Conversation | null {
    const row = this.db.query<Conversation, [string, string]>(`SELECT c.* FROM conversations c
      WHERE c.anchor_message_id=? OR EXISTS (SELECT 1 FROM transcript t WHERE t.channel_id=c.channel_id
        AND t.user_id=c.user_id AND t.opened_at=c.opened_at AND t.message_id=?)
      ORDER BY c.last_activity DESC LIMIT 1`).get(messageId, messageId);
    const current = row ? this.followMerge(row) : null;
    if (!current) return null;
    if (current.status === "open" || current.status === "on_hold") return current;
    return now !== undefined && current.status === "resolved" && (current.resolved_at ?? 0) > now - 7 * DAY_MS ? current : null;
  }

  /** Any retained topic by its anchor, following merges. */
  topic(anchor: string): Conversation | null {
    const row = this.db.query<Conversation, [string]>("SELECT * FROM conversations WHERE anchor_message_id=?").get(anchor);
    return row ? this.followMerge(row) : null;
  }

  private followMerge(row: Conversation): Conversation {
    let current = row;
    for (let hops = 0; current.merged_into && hops < 10; hops++) {
      const next = this.db.query<Conversation, [string]>("SELECT * FROM conversations WHERE anchor_message_id=?").get(current.merged_into);
      if (!next) break;
      current = next;
    }
    return current;
  }

  belongs(row: Conversation, messageId: string): boolean {
    return row.anchor_message_id === messageId || this.db.query(
      "SELECT 1 FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=? AND message_id=?")
      .get(row.channel_id, row.user_id, row.opened_at, messageId) !== null;
  }

  participants(anchor: string): Participant[] {
    return this.db.query<Participant, [string]>(
      "SELECT * FROM topic_participants WHERE anchor_message_id=? ORDER BY joined_at,user_id").all(anchor);
  }

  isParticipant(anchor: string, user: string): boolean {
    return this.db.query("SELECT 1 FROM topic_participants WHERE anchor_message_id=? AND user_id=?").get(anchor, user) !== null;
  }

  /** Adds a person, or records where they last spoke; a later message never moves their location backwards. */
  join(anchor: string, user: string, via: Participant["via"], channel: string, messageId: string, now: number): void {
    this.db.query(`INSERT INTO topic_participants VALUES (?,?,?,?,?,?,1)
      ON CONFLICT(anchor_message_id,user_id) DO UPDATE SET
        last_channel_id=CASE WHEN length(excluded.last_message_id)>length(last_message_id) OR
          (length(excluded.last_message_id)=length(last_message_id) AND excluded.last_message_id>last_message_id)
          THEN excluded.last_channel_id ELSE last_channel_id END,
        last_message_id=CASE WHEN length(excluded.last_message_id)>length(last_message_id) OR
          (length(excluded.last_message_id)=length(last_message_id) AND excluded.last_message_id>last_message_id)
          THEN excluded.last_message_id ELSE last_message_id END`).run(anchor, user, now, via, channel, messageId);
  }

  /** The closing-note groups of a topic: the first computation is kept, so retries post to the same place. */
  closureGroups(anchor: string, channel: string): { readonly channel: string; readonly target: string; readonly users: readonly string[] }[] {
    return this.db.transaction(() => {
      if (!this.db.query("SELECT 1 FROM closure_notes WHERE anchor_message_id=?").get(anchor)) {
        const elsewhere = Map.groupBy(this.participants(anchor).filter(person => person.notify && person.last_channel_id !== channel),
          person => person.last_channel_id);
        for (const [where, people] of elsewhere) {
          const target = people.map(person => person.last_message_id).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
          this.db.run("INSERT INTO closure_notes VALUES (?,?,?,?)", [anchor, where, target, JSON.stringify(people.map(person => person.user_id))]);
        }
      }
      const muted = new Set(this.participants(anchor).filter(person => !person.notify).map(person => person.user_id));
      return this.db.query<{ channel_id: string; target: string; users: string }, [string]>(
        "SELECT channel_id,target,users FROM closure_notes WHERE anchor_message_id=? ORDER BY channel_id").all(anchor)
        .map(row => ({ channel: row.channel_id, target: row.target, users: (JSON.parse(row.users) as string[]).filter(user => !muted.has(user)) }));
    }).immediate();
  }

  /** Stops closure pings for a person while keeping their history. */
  leave(anchor: string, user: string): void {
    if (!this.db.query("UPDATE topic_participants SET notify=0 WHERE anchor_message_id=? AND user_id=?").run(anchor, user).changes) {
      throw new RangeError("That person is not a participant of this topic");
    }
  }

  /** A person's active topics in any channel, most recent first. */
  topicsFor(user: string, limit = 5): Conversation[] {
    return this.db.query<Conversation, [string, number]>(`SELECT c.* FROM conversations c
      JOIN topic_participants p ON p.anchor_message_id=c.anchor_message_id AND p.user_id=?
      WHERE c.status IN ('open','on_hold') ORDER BY c.last_activity DESC, c.opened_at DESC LIMIT ?`).all(user, limit);
  }

  /**
   * Folds one topic into another: participants and transcript move, the source resolves as a duplicate pointing at
   * the target, and its issue subscription moves with it.
   */
  merge(from: string, into: string, now: number): Conversation {
    return this.db.transaction((): Conversation => {
      const source = this.get("", "", from), target = this.topic(into);
      if (!source) throw new RangeError("The topic to merge is not active");
      if (!target || (target.status !== "open" && target.status !== "on_hold")) throw new RangeError("The target topic is not active");
      if (source.anchor_message_id === target.anchor_message_id) throw new RangeError("A topic cannot merge into itself");
      if (source.issue && target.issue && source.issue !== target.issue) throw new RangeError("The topics track different issues");
      for (const person of this.participants(from)) {
        this.join(into, person.user_id, "merge", person.last_channel_id, person.last_message_id, now);
        if (!person.notify) this.db.run("UPDATE topic_participants SET notify=0 WHERE anchor_message_id=? AND user_id=?", [into, person.user_id]);
      }
      this.db.run(`INSERT OR IGNORE INTO transcript SELECT message_id,?,?,?,author_id,sent_at,entry,message_channel_id,audience,is_helio
        FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=? AND is_helio=1`,
      [target.channel_id, target.user_id, target.opened_at, source.channel_id, source.user_id, source.opened_at]);
      this.db.run(`UPDATE transcript SET channel_id=?,user_id=?,opened_at=? WHERE channel_id=? AND user_id=? AND opened_at=? AND is_helio=0`,
        [target.channel_id, target.user_id, target.opened_at, source.channel_id, source.user_id, source.opened_at]);
      this.db.run("DELETE FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=?", [source.channel_id, source.user_id, source.opened_at]);
      if (source.issue && !target.issue) {
        this.db.run("UPDATE conversations SET issue=? WHERE anchor_message_id=?", [source.issue, into]);
      }
      this.db.run("UPDATE OR IGNORE followups SET anchor_message_id=? WHERE anchor_message_id=?", [into, from]);
      this.db.run("DELETE FROM followups WHERE anchor_message_id=?", [from]);
      this.db.run(`UPDATE conversations SET revision=revision+1,last_activity=max(last_activity,?) WHERE anchor_message_id=?`, [now, into]);
      this.close(source.channel_id, source.user_id, "duplicate", now, undefined, from);
      this.db.run("UPDATE conversations SET merged_into=? WHERE anchor_message_id=?", [into, from]);
      return this.topic(into)!;
    }).immediate();
  }

  /** Subscribes a topic to its issue's terminal outcome; the subscription survives the topic's own resolution. */
  private subscribe(row: Conversation, issue: string, now: number): void {
    const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(issue);
    if (!match) return;
    this.db.run("INSERT OR IGNORE INTO followups (repo,issue,anchor_message_id,created_at) VALUES (?,?,?,?)",
      [match[1]!, Number(match[2]), row.anchor_message_id, Math.floor(now / 1000)]);
  }

  /** Links an issue: another active topic with that issue absorbs the newer one, so each issue has one topic. */
  private linkTopicIssue(row: Conversation, issue: string, now: number): Conversation {
    const other = this.db.query<Conversation, [string, string]>(`SELECT * FROM conversations WHERE issue=? AND anchor_message_id<>?
      AND status IN ('open','on_hold') ORDER BY opened_at LIMIT 1`).get(issue, row.anchor_message_id);
    if (!other) { this.subscribe(row, issue, now); return row; }
    const [older, newer] = other.opened_at <= row.opened_at ? [other, row] : [row, other];
    const merged = this.merge(newer.anchor_message_id, older.anchor_message_id, now);
    this.subscribe(merged, issue, now);
    return merged;
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

  /** A topic resolved within 7 days: the named one, or the person's latest as a participant present in this channel. */
  recentlyResolved(channel: string, user: string, now: number, topic?: string): Conversation | null {
    if (topic) {
      return this.db.query<Conversation, [string, number]>(
        "SELECT * FROM conversations WHERE anchor_message_id=? AND status='resolved' AND resolved_at>? AND merged_into IS NULL")
        .get(topic, now - 7 * DAY_MS);
    }
    return this.db.query<Conversation, [string, number, string, string]>(`SELECT c.* FROM conversations c
      JOIN topic_participants p ON p.anchor_message_id=c.anchor_message_id AND p.user_id=?
      WHERE c.status='resolved' AND c.resolved_at>? AND c.merged_into IS NULL AND (c.channel_id=? OR p.last_channel_id=?)
      ORDER BY c.resolved_at DESC LIMIT 1`).get(user, now - 7 * DAY_MS, channel, channel);
  }

  /** Helio's delivered question waits on this person, asked in this channel. */
  awaitingAnswer(channel: string, user: string): boolean {
    return this.list().some(row => this.state(row) === "waiting_on_requester" &&
      (row.waiting_on_user ?? row.user_id) === user && (row.question_channel_id ?? row.channel_id) === channel);
  }

  /** The conversation-backed admission callbacks every intake reader shares. */
  intakeCallbacks() {
    return {
      awaitingAnswer: (channel: string, user: string) => this.awaitingAnswer(channel, user),
      workingAnchor: (channel: string, user: string, messageId: string) => this.workingAnchor(channel, user, messageId),
      topicMessage: (messageId: string) => this.topicOfMessage(messageId, Date.now()) !== null,
    };
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

  /**
   * Records a message in the topic it belongs to. A participant's message needs an open claim; Helio's replies are
   * always recorded; anyone else joins only through a topic reply (`recordAnswered`).
   */
  append(channel: string, user: string, entry: ConversationEntry, now = Date.now(), placement?: Placement): void {
    if (this.isNotice(entry.message_id)) return;
    this.db.transaction(() => {
      const row = this.get(channel, user, entry.message_id) ?? this.forReply(channel, user, entry.reply_to);
      if (!row) return;
      if (!entry.bot) {
        const claim = this.working(entry.message_id);
        if (!this.isParticipant(row.anchor_message_id, entry.author_id) || claim?.claimed_at == null || claim.closed_at !== null) return;
      }
      this.record(row, entry, placement ?? { channel, audience: this.audienceIn(channel) }, now);
    }).immediate();
  }

  /**
   * A delivered topic reply answered or covered this message: its author joins and the message is recorded. The reply
   * already covers it, so this neither reopens questions nor invalidates that reply's revision.
   */
  recordAnswered(row: Conversation, entry: ConversationEntry, placement: Placement, via: "answered" | "covered" | "lead", now: number): void {
    this.db.transaction(() => {
      this.join(row.anchor_message_id, entry.author_id, via, placement.channel, entry.message_id, now);
      this.db.run(`INSERT OR IGNORE INTO transcript
        (message_id,channel_id,user_id,opened_at,author_id,sent_at,entry,message_channel_id,audience,is_helio) VALUES (?,?,?,?,?,?,?,?,?,0)`,
      [entry.message_id, row.channel_id, row.user_id, row.opened_at, entry.author_id, entry.sent_at ?? null, JSON.stringify(entry),
        placement.channel, placement.audience]);
      this.db.run(`UPDATE conversations SET last_activity=max(last_activity,?),
        latest_input_id=CASE WHEN latest_input_id IS NULL OR length(?)>length(latest_input_id) OR (length(?)=length(latest_input_id) AND ?>latest_input_id)
          THEN ? ELSE latest_input_id END WHERE channel_id=? AND user_id=? AND opened_at=?`,
      [now, entry.message_id, entry.message_id, entry.message_id, entry.message_id, row.channel_id, row.user_id, row.opened_at]);
    }).immediate();
  }

  private record(row: Conversation, entry: ConversationEntry, placement: Placement, now: number): void {
    const helio = entry.bot === true;
    const inserted = this.db.query(`INSERT OR IGNORE INTO transcript
      (message_id,channel_id,user_id,opened_at,author_id,sent_at,entry,message_channel_id,audience,is_helio) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(entry.message_id, row.channel_id, row.user_id, row.opened_at, entry.author_id, entry.sent_at ?? null,
        JSON.stringify(entry), placement.channel, placement.audience, helio ? 1 : 0);
    if (!inserted.changes) return;
    if (!helio) {
      this.join(row.anchor_message_id, entry.author_id, "answered", placement.channel, entry.message_id, now);
      this.inputFor(row, entry.message_id, now);
    }
    this.db.query(`UPDATE conversations SET last_activity=max(last_activity,?),nudged_at=NULL
      WHERE channel_id=? AND user_id=? AND opened_at=?`).run(now, row.channel_id, row.user_id, row.opened_at);
  }

  /** The audience last recorded for a channel; unknown channels are treated as staff so nothing becomes public. */
  audienceIn(channel: string): Audience {
    return this.db.query<{ audience: Audience }, [string]>(
      "SELECT audience FROM transcript WHERE message_channel_id=? ORDER BY rowid DESC LIMIT 1").get(channel)?.audience ?? "staff";
  }

  /** Authorized, prepared input invalidates a covered revision before the lead claims its turn. */
  observeInput(channel: string, user: string, messageId: string, now: number, replyTo?: string): void {
    this.db.transaction(() => {
      const row = this.get(channel, user, messageId) ?? this.forReply(channel, user, replyTo);
      if (row) this.inputFor(row, messageId, now);
    }).immediate();
  }

  /** New participant input puts the topic back on Helio and clears its question. */
  private inputFor(row: Conversation, messageId: string, now: number): void {
    if (row.latest_input_id && BigInt(messageId) <= BigInt(row.latest_input_id)) return;
    this.db.run(`UPDATE conversations SET latest_input_id=?,revision=revision+1,last_activity=max(last_activity,?),
      waiting_on='',question_started_at=NULL,reply_disposition=NULL,nudged_at=NULL,waiting_on_user=NULL
      WHERE channel_id=? AND user_id=? AND opened_at=?`, [messageId, now, row.channel_id, row.user_id, row.opened_at]);
  }

  claim(channel: string, user: string, entry: ConversationEntry, now: number, placement?: Placement): void {
    this.db.transaction(() => {
      this.claimWorking(channel, user, entry.message_id, now);
      this.append(channel, user, entry, now, placement);
    }).immediate();
  }

  /** Recorded text, optionally limited to what a viewer in this place may see. */
  transcriptOf(row: Conversation, viewer?: Placement): ConversationEntry[] {
    return this.db.query<{ entry: string; audience: Audience; message_channel_id: string }, [string, string, number]>(
      `SELECT entry,audience,message_channel_id FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=?
        AND entry IS NOT NULL ORDER BY rowid`,
    ).all(row.channel_id, row.user_id, row.opened_at)
      .filter(entry => !viewer || visibleTo(entry, viewer)).map((entry) => JSON.parse(entry.entry));
  }

  /** Recorded text with the channel each message was said in, for callers that check access per message. */
  placedTranscriptOf(row: Conversation): { readonly entry: ConversationEntry; readonly channel: string }[] {
    return this.db.query<{ entry: string; message_channel_id: string }, [string, string, number]>(
      `SELECT entry,message_channel_id FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=? AND entry IS NOT NULL ORDER BY rowid`,
    ).all(row.channel_id, row.user_id, row.opened_at).map(item => ({ entry: JSON.parse(item.entry), channel: item.message_channel_id }));
  }

  /** Every active topic's entries that this person opened in this channel. */
  transcript(channel: string, user: string): ConversationEntry[] {
    return this.db.query<{ entry: string }, [string, string]>(`SELECT t.entry FROM transcript t
      JOIN conversations c ON c.channel_id=t.channel_id AND c.user_id=t.user_id AND c.opened_at=t.opened_at
      WHERE c.status IN ('open','on_hold') AND t.channel_id=? AND t.user_id=? AND t.entry IS NOT NULL ORDER BY t.rowid`)
      .all(channel, user).map((row) => JSON.parse(row.entry));
  }

  note(channel: string, user: string, text: string, topic?: string): void {
    if (!text.trim() || text.length > 600) throw new TypeError("Summary must be 1-600 characters");
    const row = this.requireOpen(channel, user, topic);
    this.db.query("UPDATE conversations SET summary=? WHERE channel_id=? AND user_id=? AND opened_at=?")
      .run(text, row.channel_id, row.user_id, row.opened_at);
  }

  /** Records what Helio understood; an empty string clears a field. Linking an issue may merge into its existing topic. */
  setState(channel: string, user: string, fields: Understanding & { readonly job?: string; readonly issue?: string }, topic?: string,
    now = Date.now()): Conversation {
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
      WHERE channel_id=? AND user_id=? AND opened_at=?`).run(...updates.map(([, value]) => value), row.channel_id, row.user_id, row.opened_at);
    const current = this.topic(row.anchor_message_id)!;
    return fields.issue ? this.linkTopicIssue(current, fields.issue, now) : current;
  }

  hold(channel: string, user: string, reason: string, topic?: string): void {
    if (!reason.trim() || reason.length > 600) throw new TypeError("Hold reason must be 1-600 characters");
    const row = this.requireOpen(channel, user, topic);
    this.db.query("UPDATE conversations SET revision=revision+1,status='on_hold',hold_reason=? WHERE channel_id=? AND user_id=? AND opened_at=?")
      .run(reason, row.channel_id, row.user_id, row.opened_at);
  }

  resume(channel: string, user: string, topic?: string): void {
    const row = this.requireOpen(channel, user, topic);
    this.db.query(`UPDATE conversations SET revision=revision+1,status='open',hold_reason=NULL
      WHERE channel_id=? AND user_id=? AND opened_at=? AND status='on_hold'`).run(row.channel_id, row.user_id, row.opened_at);
  }

  reopen(channel: string, user: string, now: number, topic?: string): Conversation {
    return this.db.transaction((): Conversation => {
      const row = this.recentlyResolved(channel, user, now, topic);
      if (!row) throw new RangeError("No conversation resolved in the last 7 days; open a new one");
      this.requireSlot(row.channel_id, row.user_id);
      this.db.query(`UPDATE conversations SET status='open',outcome=NULL,closed_at=NULL,resolved_at=NULL,
        revision=revision+1,waiting_on='',question_started_at=NULL,last_reply_key=NULL,reply_disposition=NULL,
        archived_at=NULL,last_activity=?,nudged_at=NULL,waiting_on_user=NULL WHERE channel_id=? AND user_id=? AND opened_at=?`)
        .run(now, row.channel_id, row.user_id, row.opened_at);
      return { ...row, status: "open", outcome: null, closed_at: null, resolved_at: null,
        archived_at: null, last_activity: now, nudged_at: null, revision: row.revision + 1, waiting_on: "",
        question_started_at: null, last_reply_key: null, reply_disposition: null, waiting_on_user: null };
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
      let current = this.byAnchor(row.channel_id, row.user_id, row.anchor_message_id);
      if (key && current?.last_reply_key === key) return "applied";
      if (!current || current.opened_at !== row.opened_at || current.revision !== row.revision) return "newer-input";
      // A delivered question or progress note on a recently resolved topic picks it up again.
      if (current.status === "resolved" && meaning.disposition !== "final" && (current.resolved_at ?? 0) > now - 7 * DAY_MS &&
          !current.merged_into) {
        current = this.reopen(current.channel_id, current.user_id, now, current.anchor_message_id);
      }
      if (current.status !== "open") return "newer-input";
      const lastHuman = this.transcriptOf(current).findLast(entry => !entry.bot);
      if (row.covered && lastHuman && !row.covered.includes(lastHuman.message_id)) return "newer-input";
      if (row.covered && current.latest_input_id && !row.covered.includes(current.latest_input_id)) return "newer-input";
      if (meaning.disposition === "question" && !meaning.waiting_on?.trim()) throw new TypeError("Question requires waiting_on");
      const asking = meaning.disposition === "question";
      // A question waits on the person it answered, in the channel and at the message where it was asked.
      this.db.run(`UPDATE conversations SET reply_disposition=?,waiting_on=?,question_started_at=?,
        question_generation=question_generation+?,last_reply_key=?,job=coalesce(job,?),issue=coalesce(issue,?),
        waiting_on_user=?,question_channel_id=?,question_message_id=?,
        revision=revision+? WHERE channel_id=? AND user_id=? AND opened_at=?`,
      [meaning.disposition, asking ? meaning.waiting_on! : "", asking ? now : null, asking ? 1 : 0,
        key ?? null, meaning.job ?? null, meaning.issue ?? null,
        asking ? row.asked_user ?? row.user_id : null, asking ? row.reply_channel ?? row.channel_id : null,
        asking ? row.asked_message ?? row.anchor_message_id : null, meaning.disposition === "final" ? 0 : 1,
        row.channel_id, row.user_id, row.opened_at]);
      // Linking an issue through a reply is the same as `conversation set --issue`: an older topic with it absorbs this one.
      if (meaning.issue && !current.issue) {
        const linked = this.linkTopicIssue(this.topic(row.anchor_message_id)!, meaning.issue, now);
        if (linked.anchor_message_id !== row.anchor_message_id) return "applied";
      }
      if (meaning.disposition === "final") {
        const tracked = this.db.query(`SELECT 1 FROM followups WHERE anchor_message_id=? AND status<>'done'`).get(row.anchor_message_id);
        this.close(row.channel_id, row.user_id, tracked ? "issue" : "answered", now, undefined, row.anchor_message_id);
      }
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
      this.db.query("DELETE FROM transcript WHERE entry IS NULL AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.channel_id=transcript.channel_id AND c.user_id=transcript.user_id AND c.opened_at=transcript.opened_at AND c.status IN ('open','on_hold','resolved'))").run();
      // A topic whose issue subscription is still undelivered keeps its participants and summary until delivery.
      this.db.query(`DELETE FROM conversations WHERE status='archived' AND resolved_at<=? AND NOT EXISTS (
        SELECT 1 FROM followups f WHERE f.anchor_message_id=conversations.anchor_message_id AND f.status<>'done')`).run(now - 30 * DAY_MS);
      this.db.exec(`DELETE FROM closure_notes WHERE NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.anchor_message_id=closure_notes.anchor_message_id)`);
      this.db.exec(`DELETE FROM topic_participants WHERE NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.anchor_message_id=topic_participants.anchor_message_id)`);
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
