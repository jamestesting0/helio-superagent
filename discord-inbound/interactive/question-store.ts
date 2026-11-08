import { openPrivate, QUESTION_TTL_MS, type Question, type ComponentAnswer } from "./store.ts";
import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";

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
    db.transaction(() => {
      const current = db.query<{ name: string }, []>("PRAGMA table_info(questions)").all();
      if (!current.some(column => column.name === "answer_display")) db.exec("ALTER TABLE questions ADD COLUMN answer_display TEXT");
    }).immediate();
    // Only the retired draft flow used this state; old unsubmitted choices become replyable again.
    db.query("UPDATE questions SET status='awaiting_answer',pending_by=NULL,pending_at=NULL WHERE status='answering'").run();
    return new QuestionStore(db);
  }
  close(): void { this.db.close(); }

  get(id: string): Question | undefined {
    return this.db.query<Question, [string]>("SELECT * FROM questions WHERE id=?").get(id) ?? undefined;
  }

  /** The tap itself is the answer: one conditional write wins against clicks and typed replies. */
  answer(questionId: string, answer: ComponentAnswer, now: number): boolean {
    return this.db.query(`UPDATE questions SET status='answered',answer_id=?,answer_author=?,answer_role=?,answer_scope=?,
      answer_text=?,answer_source='component',announced_at=NULL,pending_by=NULL,pending_at=NULL,updated=?
      WHERE id=? AND status='awaiting_answer' AND updated>?`)
      .run(answer.id, answer.author, answer.role, answer.scope, answer.text, now, questionId, now - QUESTION_TTL_MS).changes === 1;
  }

  /** Freeze presentation before posting, so a rename cannot change an uncertain send's identity. */
  bindAnswerDisplay(questionId: string, author: string, display: string): string {
    const saved = this.db.query<{ answer_display: string }, [string, string, string]>(
      "UPDATE questions SET answer_display=coalesce(answer_display,?) WHERE id=? AND answer_author=? RETURNING answer_display")
      .get(display, questionId, author);
    if (!saved) throw new RangeError("The question changed before its answer could be displayed");
    return saved.answer_display;
  }

  expireDue(now: number): Question[] {
    return this.db.transaction(() => {
      const due = this.db.query<Question, [number]>(
        "SELECT * FROM questions WHERE status='awaiting_answer' AND updated<=?").all(now - QUESTION_TTL_MS);
      this.db.query("UPDATE questions SET status='expired',updated=? WHERE status='awaiting_answer' AND updated<=?")
        .run(now, now - QUESTION_TTL_MS);
      return due;
    }).immediate();
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
    return this.db.query<Question, []>(`SELECT * FROM questions WHERE (components IS NOT NULL OR status='expired') AND cleared_at IS NULL
      AND message_id IS NOT NULL AND status IN ('answered','done','cancelled','expired')`).all();
  }
  cleared(id: string, now: number): void { this.db.query("UPDATE questions SET cleared_at=? WHERE id=?").run(now, id); }
}
