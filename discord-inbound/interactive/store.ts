import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, lstatSync } from "node:fs";

export const CONFIRM_TTL_MS = 15 * 60_000;
// Plans and PR prompts are not production actions: they stay clickable while people get to them.
export const PLAN_TTL_MS = 72 * 3_600_000;
export const LAPSE_MS = 15 * 60_000;
export const DRAFT_TTL_MS = 15 * 60_000;
export const PENDING_STALE_MS = 30_000;

export type PromptKind = "confirm" | "plan";
export type PromptStatus = "sending" | "send_failed" | "delivery_unknown" | "open" | "pending" | "confirmed" |
  "cancelled" | "expired" | "superseded" | "lapsed" | "used";
export const CLOSED: readonly PromptStatus[] = ["confirmed", "cancelled", "expired", "superseded", "lapsed", "used"];

export interface Prompt {
  readonly id: string; readonly kind: PromptKind; readonly action: string; readonly target: string;
  readonly revision: string; readonly content: string; readonly channel_id: string; readonly message_id: string | null;
  readonly reply_to: string | null; readonly status: PromptStatus; readonly pending_by: string | null;
  readonly pending_at: number | null; readonly decided_by: string | null; readonly decided_at: number | null;
  readonly result_message_id: string | null; readonly created_at: number; readonly expires_at: number;
  readonly notice_at: number | null; readonly used_at: number | null; readonly cleared_at: number | null;
  readonly error: string | null;
  readonly pending_app: string | null; readonly pending_token: string | null;
  readonly pending_accept: number | null; readonly pending_expected: string | null;
}
/** What a claim needs to be settled later from Discord's own record of the reply. */
export interface Claim { readonly app: string; readonly token: string; readonly accept: boolean; readonly expected: string }
export interface Draft {
  readonly id: string; readonly question_id: string; readonly user_id: string;
  readonly option_index: number | null; readonly label: string; readonly created_at: number;
  readonly app_id: string | null; readonly token: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('confirm','plan')), action TEXT NOT NULL,
  target TEXT NOT NULL, revision TEXT NOT NULL, content TEXT NOT NULL, channel_id TEXT NOT NULL,
  message_id TEXT, reply_to TEXT, status TEXT NOT NULL, pending_by TEXT, pending_at INTEGER,
  decided_by TEXT, decided_at INTEGER, result_message_id TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, notice_at INTEGER, used_at INTEGER, cleared_at INTEGER, error TEXT,
  pending_app TEXT, pending_token TEXT, pending_accept INTEGER, pending_expected TEXT);
CREATE INDEX IF NOT EXISTS prompts_status ON prompts(status, expires_at);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL, user_id TEXT NOT NULL, option_index INTEGER,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, app_id TEXT, token TEXT, UNIQUE (question_id, user_id));
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL,
  message_id TEXT, created_at INTEGER NOT NULL);`;

const CLEAR_CLAIM = "pending_by=NULL,pending_at=NULL,pending_app=NULL,pending_token=NULL,pending_accept=NULL,pending_expected=NULL";

export const newId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 20);

export function openPrivate(path: string, busyMs: number, create: boolean): Database {
  let exists = true;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`unsafe database ${path}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    if (!create) throw error;
    exists = false;
  }
  const db = new Database(path, { create });
  if (!exists) chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout = ${busyMs}`);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/**
 * Durable prompt state shared by the watcher (clicks, expiry) and the CLI (posting, use).
 * Every decision is one conditional UPDATE, so exactly one click, cancel or expiry wins.
 */
export class PromptStore {
  readonly db: Database;
  constructor(path: string, busyMs = 5000) {
    this.db = openPrivate(path, busyMs, true);
    this.db.exec(SCHEMA);
    if ((this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0) < 2) {
      this.db.transaction(() => {
        for (const [table, columns] of [
          ["prompts", [["pending_app", "TEXT"], ["pending_token", "TEXT"], ["pending_accept", "INTEGER"], ["pending_expected", "TEXT"]]],
          ["drafts", [["app_id", "TEXT"], ["token", "TEXT"]]],
        ] as const) {
          const present = new Set(this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name));
          for (const [name, kind] of columns) if (!present.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${kind}`);
        }
        this.db.exec("PRAGMA user_version = 2");
      }).immediate();
    }
  }
  close(): void { this.db.close(); }

  private run(sql: string, ...params: SQLQueryBindings[]): number {
    return this.db.query(sql).run(...params).changes;
  }

  get(id: string): Prompt | undefined {
    return this.db.query<Prompt, [string]>("SELECT * FROM prompts WHERE id=?").get(id) ?? undefined;
  }

  create(row: { id: string; kind: PromptKind; action: string; target: string; revision: string; content: string;
    channel_id: string; reply_to?: string; now: number }): void {
    const ttl = row.kind === "plan" || row.action === "pr" ? PLAN_TTL_MS : CONFIRM_TTL_MS;
    this.run(`INSERT INTO prompts (id,kind,action,target,revision,content,channel_id,reply_to,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,'sending',?,?)`, row.id, row.kind, row.action, row.target, row.revision, row.content,
      row.channel_id, row.reply_to ?? null, row.now, row.now + ttl);
  }

  /** Expiry counts from the moment the prompt is visible, not from when it was queued. */
  sent(id: string, messageId: string, now: number): boolean {
    const row = this.get(id);
    if (!row) return false;
    const ttl = row.kind === "plan" || row.action === "pr" ? PLAN_TTL_MS : CONFIRM_TTL_MS;
    return this.run("UPDATE prompts SET status='open',message_id=?,error=NULL,created_at=?,expires_at=? WHERE id=? AND status IN ('sending','delivery_unknown')",
      messageId, now, now + ttl, id) === 1;
  }

  failed(id: string, status: "send_failed" | "delivery_unknown", error: string): void {
    this.run("UPDATE prompts SET status=?,error=? WHERE id=? AND status IN ('sending','delivery_unknown')", status, error.slice(0, 300), id);
  }

  /** Phase one: claim the decision. Returns undefined on success, or the row that explains why not. */
  begin(id: string, user: string, now: number, claim: Claim): Prompt | undefined {
    return this.db.transaction(() => {
      if (this.run(`UPDATE prompts SET status='pending',pending_by=?,pending_at=?,pending_app=?,pending_token=?,pending_accept=?,
        pending_expected=? WHERE id=? AND status='open' AND expires_at>?`,
        user, now, claim.app, claim.token, claim.accept ? 1 : 0, claim.expected, id, now) === 1) return undefined;
      return this.get(id);
    }).immediate();
  }

  /** Phase two, only after Discord accepted the callback. */
  finish(id: string, user: string, outcome: "confirmed" | "cancelled", now: number, resultId: string | null, cleared: boolean): boolean {
    return this.run(`UPDATE prompts SET status=?,decided_by=?,decided_at=?,result_message_id=?,cleared_at=?,
      ${CLEAR_CLAIM} WHERE id=? AND status='pending' AND pending_by=?`,
      outcome, user, now, resultId, cleared ? now : null, id, user) === 1;
  }

  revert(id: string, user: string): void {
    this.run(`UPDATE prompts SET status='open',${CLEAR_CLAIM} WHERE id=? AND status='pending' AND pending_by=?`, id, user);
  }

  /** A confirmation whose reply Discord never confirmed can no longer be trusted: it closes as expired. */
  abandon(id: string, user: string): boolean {
    return this.run(`UPDATE prompts SET status='expired',${CLEAR_CLAIM} WHERE id=? AND status='pending' AND pending_by=?`, id, user) === 1;
  }

  /** Claims old enough that their click handler has finished or died; each is settled from Discord's record. */
  stalePending(now: number): Prompt[] {
    return this.db.query<Prompt, [number]>("SELECT * FROM prompts WHERE status='pending' AND pending_at<=?").all(now - PENDING_STALE_MS);
  }

  /** The next expiry or lapse; claims to settle are left to the periodic sweep. */
  nextDeadline(): number | undefined {
    return this.db.query<{ at: number | null }, [number]>(`SELECT MIN(at) AS at FROM (
      SELECT expires_at AS at FROM prompts WHERE status='open'
      UNION ALL SELECT decided_at + ? FROM prompts WHERE kind='confirm' AND status='confirmed' AND used_at IS NULL)`).get(LAPSE_MS)?.at ?? undefined;
  }

  expireDue(now: number): Prompt[] {
    return this.db.transaction(() => {
      const due = this.db.query<Prompt, [number]>("SELECT * FROM prompts WHERE status='open' AND expires_at<=?").all(now);
      this.run("UPDATE prompts SET status='expired' WHERE status='open' AND expires_at<=?", now);
      const lapsed = this.db.query<Prompt, [number]>(
        "SELECT * FROM prompts WHERE kind='confirm' AND status='confirmed' AND used_at IS NULL AND decided_at<=?").all(now - LAPSE_MS);
      this.run("UPDATE prompts SET status='lapsed' WHERE kind='confirm' AND status='confirmed' AND used_at IS NULL AND decided_at<=?",
        now - LAPSE_MS);
      return [...due, ...lapsed];
    }).immediate();
  }

  toClose(): Prompt[] {
    return this.db.query<Prompt, []>(`SELECT * FROM prompts WHERE message_id IS NOT NULL AND cleared_at IS NULL
      AND status IN (${CLOSED.map((s) => `'${s}'`).join(",")})`).all();
  }
  cleared(id: string, now: number): void { this.run("UPDATE prompts SET cleared_at=? WHERE id=?", now, id); }

  needingNotice(): Prompt[] {
    return this.db.query<Prompt, []>("SELECT * FROM prompts WHERE status='lapsed' AND notice_at IS NULL AND message_id IS NOT NULL").all();
  }
  noticed(id: string, now: number): void { this.run("UPDATE prompts SET notice_at=? WHERE id=?", now, id); }

  use(id: string, now: number): boolean {
    return this.run("UPDATE prompts SET status='used',used_at=? WHERE id=? AND status='confirmed' AND (kind='plan' OR decided_at>?)",
      now, id, now - LAPSE_MS) === 1;
  }

  cancel(id: string): boolean {
    return this.run("UPDATE prompts SET status='cancelled' WHERE id=? AND status IN ('open','sending','send_failed','delivery_unknown')", id) === 1;
  }

  supersede(target: string, exceptId: string): number {
    return this.run("UPDATE prompts SET status='superseded' WHERE kind='plan' AND target=? AND id!=? AND status IN ('open','confirmed','sending','delivery_unknown','send_failed')",
      target, exceptId);
  }

  list(all: boolean): Prompt[] {
    return this.db.query<Prompt, []>(all ? "SELECT * FROM prompts ORDER BY created_at DESC LIMIT 50" :
      "SELECT * FROM prompts WHERE status IN ('sending','delivery_unknown','send_failed','open','pending','confirmed') ORDER BY created_at").all();
  }

  putDraft(questionId: string, user: string, optionIndex: number | null, label: string, now: number): string {
    const id = newId();
    this.db.transaction(() => {
      this.run("DELETE FROM drafts WHERE question_id=? AND user_id=? AND token IS NULL", questionId, user);
      this.run("INSERT INTO drafts (id,question_id,user_id,option_index,label,created_at) VALUES (?,?,?,?,?,?)", id, questionId, user, optionIndex, label, now);
    }).immediate();
    return id;
  }
  draft(id: string): Draft | undefined {
    return this.db.query<Draft, [string]>("SELECT * FROM drafts WHERE id=?").get(id) ?? undefined;
  }
  /** Saved before the submit reply is sent, so a restart can still read Discord's record of it. */
  claimDraft(id: string, app: string, token: string): void { this.run("UPDATE drafts SET app_id=?,token=? WHERE id=?", app, token, id); }
  releaseDraft(id: string): void { this.run("UPDATE drafts SET app_id=NULL,token=NULL WHERE id=?", id); }
  draftFor(questionId: string, user: string): Draft | undefined {
    return this.db.query<Draft, [string, string]>("SELECT * FROM drafts WHERE question_id=? AND user_id=?").get(questionId, user) ?? undefined;
  }
  deleteDraft(id: string): void { this.run("DELETE FROM drafts WHERE id=?", id); }
  expireDrafts(now: number, keep: ReadonlySet<string>): number {
    return this.run("DELETE FROM drafts WHERE created_at<=? AND question_id NOT IN (SELECT value FROM json_each(?))",
      now - DRAFT_TTL_MS, JSON.stringify([...keep]));
  }

  addFeedback(promptId: string, user: string, text: string, messageId: string | null, now: number): string {
    const id = newId();
    this.run("INSERT INTO feedback VALUES (?,?,?,?,?,?)", id, promptId, user, text, messageId, now);
    return id;
  }
  feedback(promptId: string): { id: string; user_id: string; text: string; message_id: string | null; created_at: number }[] {
    return this.db.query<{ id: string; user_id: string; text: string; message_id: string | null; created_at: number }, [string]>(
      "SELECT id,user_id,text,message_id,created_at FROM feedback WHERE prompt_id=? ORDER BY created_at").all(promptId);
  }
}

export interface Question {
  readonly id: string; readonly audience: string; readonly recipient: string; readonly status: string;
  readonly channel_id: string | null; readonly message_id: string | null; readonly options: string | null;
  readonly components: string | null; readonly answer_author: string | null; readonly answer_text: string | null;
  readonly answer_source: string | null; readonly announced_at: number | null; readonly cleared_at: number | null;
  readonly pending_by: string | null; readonly pending_at: number | null;
}
export interface ComponentAnswer {
  readonly id: string; readonly author: string; readonly role: string; readonly scope: string; readonly text: string;
}

const COLUMNS = ["options", "components", "answer_source", "announced_at", "cleared_at", "pending_by", "pending_at"];

/**
 * Component answers in the Python-owned question database. A database from before the
 * component migration has no option columns, so it never offers clicks.
 */
export class QuestionStore {
  private constructor(private readonly db: Database) {}

  static open(path: string, busyMs: number): QuestionStore | undefined {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("unsafe question database");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const db = openPrivate(path, busyMs, false);
    const names = new Set(db.query<{ name: string }, []>("PRAGMA table_info(questions)").all().map((row) => row.name));
    if (!COLUMNS.every((name) => names.has(name))) { db.close(); return undefined; }
    return new QuestionStore(db);
  }
  close(): void { this.db.close(); }

  get(id: string): Question | undefined {
    return this.db.query<Question, [string]>("SELECT * FROM questions WHERE id=?").get(id) ?? undefined;
  }

  begin(id: string, user: string, now: number): Question | undefined {
    return this.db.transaction(() => {
      const changed = this.db.query(`UPDATE questions SET status='answering',pending_by=?,pending_at=?,updated=?
        WHERE id=? AND status='awaiting_answer' AND options IS NOT NULL`).run(user, now, now, id).changes;
      return changed === 1 ? undefined : this.get(id);
    }).immediate();
  }

  finish(questionId: string, user: string, answer: ComponentAnswer, now: number): boolean {
    return this.db.query(`UPDATE questions SET status='answered',answer_id=?,answer_author=?,answer_role=?,answer_scope=?,
      answer_text=?,answer_source='component',announced_at=NULL,pending_by=NULL,pending_at=NULL,updated=?
      WHERE id=? AND status='answering' AND pending_by=?`)
      .run(answer.id, answer.author, answer.role, answer.scope, answer.text, now, questionId, user).changes === 1;
  }

  revert(id: string, user: string, now: number): void {
    this.db.query("UPDATE questions SET status='awaiting_answer',pending_by=NULL,pending_at=NULL,updated=? WHERE id=? AND status='answering' AND pending_by=?")
      .run(now, id, user);
  }

  answering(): string[] {
    return this.db.query<{ id: string }, []>("SELECT id FROM questions WHERE status='answering'").all().map((row) => row.id);
  }
  stalePending(now: number): Question[] {
    return this.db.query<Question, [number]>("SELECT * FROM questions WHERE status='answering' AND pending_at<=?").all(now - PENDING_STALE_MS);
  }

  toAnnounce(): Question[] {
    return this.db.query<Question, []>(`SELECT * FROM questions WHERE answer_source='component' AND announced_at IS NULL
      AND message_id IS NOT NULL AND status IN ('answered','done')`).all();
  }
  /** An acknowledged answer keeps its text only until its public post exists. */
  announced(id: string, now: number): void {
    this.db.query("UPDATE questions SET announced_at=?,answer_text=CASE WHEN status='done' THEN NULL ELSE answer_text END WHERE id=?").run(now, id);
  }

  toClear(): Question[] {
    return this.db.query<Question, []>(`SELECT * FROM questions WHERE components IS NOT NULL AND cleared_at IS NULL
      AND message_id IS NOT NULL AND status IN ('answered','done','cancelled')`).all();
  }
  cleared(id: string, now: number): void { this.db.query("UPDATE questions SET cleared_at=? WHERE id=?").run(now, id); }
}
