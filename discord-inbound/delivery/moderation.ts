import type { Database } from "bun:sqlite";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BURST_MS = 2 * MINUTE;

export interface ModerationSettings {
  readonly strikes: number;
  readonly windowMs: number;
  readonly pingsPerHour: number;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

export function moderationSettings(env: Readonly<Record<string, string | undefined>>): ModerationSettings {
  return {
    strikes: positive(env.HELIO_AUTOBLOCK_STRIKES, 5, "HELIO_AUTOBLOCK_STRIKES"),
    windowMs: positive(env.HELIO_AUTOBLOCK_WINDOW_H, 12, "HELIO_AUTOBLOCK_WINDOW_H") * HOUR,
    pingsPerHour: positive(env.HELIO_PING_LIMIT_PER_HOUR, 20, "HELIO_PING_LIMIT_PER_HOUR"),
  };
}

export interface Blocked {
  readonly user_id: string;
  readonly source: "owner" | "auto";
  readonly reason: string;
  readonly created_by: string;
  readonly evidence_message_id: string | null;
  readonly evidence_channel_id: string | null;
  readonly created_at: number;
  readonly reacted: number;
  readonly review_question: string | null;
}

export interface BlockRequest {
  readonly source: "owner" | "auto";
  readonly reason: string;
  readonly by: string;
  readonly evidenceMessageId?: string;
  readonly evidenceChannelId?: string;
}

/** Blacklist, strikes and ping throttle share the delivery database so a strike commits with its dismissal. */
export class Moderation {
  constructor(private readonly db: Database, readonly settings: ModerationSettings = moderationSettings(process.env)) {
    db.exec(`CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('owner', 'auto')), reason TEXT NOT NULL,
      created_by TEXT NOT NULL, evidence_message_id TEXT, evidence_channel_id TEXT, created_at INTEGER NOT NULL,
      reacted INTEGER NOT NULL DEFAULT 0 CHECK (reacted IN (0, 1)), review_question TEXT
    );
    CREATE TABLE IF NOT EXISTS strikes (
      message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS strikes_user ON strikes (user_id, at);
    CREATE TABLE IF NOT EXISTS ping_log (
      message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ping_log_user ON ping_log (user_id, at);
    CREATE TABLE IF NOT EXISTS ping_notices (user_id TEXT PRIMARY KEY, noticed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS moderation_proofs (
      proof TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('add', 'remove')), used_at INTEGER NOT NULL
    );`);
  }

  /**
   * Spends an owner proof on exactly one change, in the same transaction. Repeating the same proof while its change
   * still holds is a harmless repeat; any other reuse (such as an old Block after a later Undo) is refused.
   */
  withProof<T>(proof: string, userId: string, action: "add" | "remove", now: number, apply: () => T): T | "repeat" {
    return this.db.transaction((): T | "repeat" => {
      const used = this.db.query<{ user_id: string; action: string }, [string]>(
        "SELECT user_id, action FROM moderation_proofs WHERE proof = ?").get(proof);
      if (used) {
        if (used.user_id === userId && used.action === action && this.isBlocked(userId) === (action === "add")) return "repeat";
        throw new RangeError(`Proof ${proof} was already used; ask the owner again`);
      }
      this.db.query("INSERT INTO moderation_proofs (proof, user_id, action, used_at) VALUES (?, ?, ?, ?)").run(proof, userId, action, now);
      return apply();
    }).immediate();
  }

  isBlocked(userId: string): boolean {
    return this.db.query("SELECT 1 FROM blocked_users WHERE user_id = ?").get(userId) !== null;
  }

  get(userId: string): Blocked | undefined {
    return this.db.query<Blocked, [string]>("SELECT * FROM blocked_users WHERE user_id = ?").get(userId) ?? undefined;
  }

  list(): Blocked[] {
    return this.db.query<Blocked, []>("SELECT * FROM blocked_users ORDER BY created_at").all();
  }

  /** Callers run this inside the transaction that dismisses the message. */
  insertBlock(userId: string, request: BlockRequest, protectedIds: ReadonlySet<string>, now: number): Blocked {
    if (protectedIds.has(userId)) throw new RangeError(`User ${userId} is the owner or trusted and cannot be blacklisted`);
    this.db.query(`INSERT OR IGNORE INTO blocked_users
      (user_id, source, reason, created_by, evidence_message_id, evidence_channel_id, created_at, reacted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, request.source, request.reason, request.by,
      request.evidenceMessageId ?? null, request.evidenceChannelId ?? null, now, request.evidenceMessageId ? 0 : 1);
    return this.get(userId) as Blocked;
  }

  unblock(userId: string): boolean {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM strikes WHERE user_id = ?").run(userId);
      return this.db.query("DELETE FROM blocked_users WHERE user_id = ?").run(userId).changes === 1;
    }).immediate();
  }

  strike(messageId: string, userId: string, channelId: string, at: number): boolean {
    if (this.isBlocked(userId)) return false;
    const burst = this.db.query("SELECT 1 FROM strikes WHERE user_id = ? AND (message_id = ? OR abs(at - ?) < ?)")
      .get(userId, messageId, at, BURST_MS);
    if (burst === null) {
      this.db.query("INSERT INTO strikes (message_id, user_id, channel_id, at) VALUES (?, ?, ?, ?)")
        .run(messageId, userId, channelId, at);
    }
    return this.strikeCount(userId, at) >= this.settings.strikes;
  }

  strikeCount(userId: string, at: number): number {
    return this.db.query<{ n: number }, [string, number, number]>(
      "SELECT count(*) AS n FROM strikes WHERE user_id = ? AND at > ? AND at <= ?",
    ).get(userId, at - this.settings.windowMs, at)?.n ?? 0;
  }

  /** Durable per-hour ping budget by message time; a replayed message is admitted again. */
  admitPing(userId: string, messageId: string, at: number): { readonly admitted: boolean; readonly notify: boolean } {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM ping_log WHERE message_id = ?").get(messageId) !== null) {
        return { admitted: true, notify: false };
      }
      const recent = this.db.query<{ n: number }, [string, number, number]>(
        "SELECT count(*) AS n FROM ping_log WHERE user_id = ? AND at > ? AND at <= ?",
      ).get(userId, at - HOUR, at)?.n ?? 0;
      if (recent < this.settings.pingsPerHour) {
        this.db.query("INSERT INTO ping_log (message_id, user_id, at) VALUES (?, ?, ?)").run(messageId, userId, at);
        return { admitted: true, notify: false };
      }
      const notify = this.db.query(`INSERT INTO ping_notices (user_id, noticed_at) VALUES (?1, ?2)
        ON CONFLICT (user_id) DO UPDATE SET noticed_at = ?2 WHERE noticed_at <= ?2 - ?3`).run(userId, at, HOUR).changes === 1;
      return { admitted: false, notify };
    }).immediate();
  }

  pendingReactions(): { user_id: string; channel_id: string; message_id: string }[] {
    return this.db.query<{ user_id: string; channel_id: string; message_id: string }, []>(`SELECT user_id,
      evidence_channel_id AS channel_id, evidence_message_id AS message_id FROM blocked_users
      WHERE reacted = 0 AND evidence_message_id IS NOT NULL AND evidence_channel_id IS NOT NULL`).all();
  }

  reacted(userId: string): void {
    this.db.query("UPDATE blocked_users SET reacted = 1 WHERE user_id = ?").run(userId);
  }

  unreviewed(): Blocked[] {
    return this.db.query<Blocked, []>("SELECT * FROM blocked_users WHERE source = 'auto' AND review_question IS NULL").all();
  }

  reviewing(userId: string, questionId: string): boolean {
    return this.db.query("UPDATE blocked_users SET review_question = ? WHERE user_id = ? AND source = 'auto'")
      .run(questionId, userId).changes === 1;
  }
}

const OMITTED = "[message from a blocked user omitted]";

/** Stored context quoted from a now-blacklisted user keeps its place but none of its content. */
export function redactBlocked(value: unknown, blocked: (userId: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => redactBlocked(item, blocked));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, redactBlocked(item, blocked)] as const);
  const record = Object.fromEntries(entries);
  const author = typeof record.author_id === "string" ? record.author_id : undefined;
  if (author === undefined || !blocked(author)) return record;
  const { embed_text: _embeds, component_text: _components, attachments: _files, ...kept } = record;
  return { ...kept, content: OMITTED };
}
