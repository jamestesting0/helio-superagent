import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RecoveryStore } from "./recovery-store.ts";
import { Moderation, type Blocked, type BlockRequest } from "./moderation.ts";

export type Stream = "inbound" | "context";
type Disposition = "done" | "irrelevant";
export const REQUEST_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const BLOCKED_REASON = "Sender is blacklisted";

export interface Gap {
  readonly id: number;
  readonly stream: Stream;
  readonly channel_id: string;
  readonly after_id: string;
  readonly before_id: string;
  readonly reason: string;
  readonly recorded_at: string;
}

export interface BlockResult {
  readonly blocked?: Blocked;
  readonly dismissed: readonly string[];
}

export function requestTimestamp(sentAt: unknown): number | undefined {
  const match = typeof sentAt === "string" ?
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(sentAt) : null;
  const timestamp = typeof sentAt === "string" ? Date.parse(sentAt) : NaN;
  if (!match || !Number.isFinite(timestamp) ||
      Number(match[3]) > new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate()) return undefined;
  return timestamp;
}

export class Delivery {
  private readonly db: Database;
  readonly recovery: RecoveryStore;
  readonly moderation: Moderation;

  constructor(path: string, busyMs = 5000) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=${busyMs};`);
    // SQLite may return SQLITE_BUSY immediately during concurrent first WAL initialization.
    const deadline = Date.now() + 5000;
    for (;;) {
      try { this.db.exec("PRAGMA journal_mode=WAL;"); break; }
      catch (err) {
        if ((err as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) {
          this.db.close();
          throw err;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    this.db.exec("PRAGMA synchronous=FULL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery (
      stream TEXT NOT NULL, id TEXT NOT NULL, payload TEXT,
      PRIMARY KEY (stream, id)
    )`);
    // A separate table leaves the queue readable by already-running watchers.
    this.db.exec(`CREATE TABLE IF NOT EXISTS handling (
      stream TEXT NOT NULL, id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('done', 'irrelevant')),
      reason TEXT, handled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (stream, id)
    )`);
    // Additive migration: preserve handling's existing CHECK and all legacy receipts.
    this.db.exec(`CREATE TABLE IF NOT EXISTS acceptance (
      stream TEXT NOT NULL CHECK (stream = 'inbound'), id TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (stream, id)
    );
    CREATE TABLE IF NOT EXISTS expiry (
      stream TEXT NOT NULL CHECK (stream = 'inbound'), id TEXT NOT NULL,
      reason TEXT NOT NULL, expired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attachments_cleaned INTEGER NOT NULL DEFAULT 0 CHECK (attachments_cleaned IN (0, 1)),
      PRIMARY KEY (stream, id)
    )`);
    this.recovery = new RecoveryStore(this.db);
    this.moderation = new Moderation(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbound_gaps (
      id INTEGER PRIMARY KEY, stream TEXT NOT NULL, channel_id TEXT NOT NULL, after_id TEXT NOT NULL, before_id TEXT NOT NULL,
      reason TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, acknowledged_at TEXT,
      UNIQUE (stream, channel_id, after_id, before_id))`);
  }

  /** Messages between the two IDs were never read; returns the new gap's id, or undefined if already recorded. */
  recordGap(gap: { readonly stream: Stream; readonly channel: string; readonly after: string; readonly before: string; readonly reason: string }): number | undefined {
    const result = this.db.query("INSERT OR IGNORE INTO inbound_gaps (stream, channel_id, after_id, before_id, reason) VALUES (?, ?, ?, ?, ?)")
      .run(gap.stream, gap.channel, gap.after, gap.before, gap.reason);
    return result.changes === 1 ? Number(result.lastInsertRowid) : undefined;
  }

  gaps(): Gap[] {
    return this.db.query<Gap, []>("SELECT id, stream, channel_id, after_id, before_id, reason, recorded_at FROM inbound_gaps WHERE acknowledged_at IS NULL ORDER BY id").all();
  }

  acknowledgeGap(id: number): boolean {
    return this.db.query("UPDATE inbound_gaps SET acknowledged_at = CURRENT_TIMESTAMP WHERE id = ? AND acknowledged_at IS NULL").run(id).changes === 1;
  }

  /** Blocks a user and dismisses their unaccepted pending messages in one transaction. */
  block(userId: string, request: BlockRequest, protectedIds: ReadonlySet<string>): BlockResult {
    return this.db.transaction(() => {
      const blocked = this.moderation.insertBlock(userId, request, protectedIds, Date.now());
      return { blocked, dismissed: this.dismissFrom(userId) };
    }).immediate();
  }

  private dismissFrom(userId: string): string[] {
    const rows = this.db.query<{ id: string; payload: string }, []>(`SELECT d.id, d.payload FROM delivery d
      LEFT JOIN acceptance a ON a.stream = d.stream AND a.id = d.id
      WHERE d.stream = 'inbound' AND d.payload IS NOT NULL AND a.id IS NULL`).all();
    const dismissed: string[] = [];
    for (const row of rows) {
      let author: unknown;
      try { author = (JSON.parse(row.payload) as { author_id?: unknown }).author_id; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (author !== userId) continue;
      this.db.query("INSERT OR IGNORE INTO handling (stream, id, disposition, reason) VALUES ('inbound', ?, 'irrelevant', ?)")
        .run(row.id, BLOCKED_REASON);
      this.db.query("UPDATE delivery SET payload = NULL WHERE stream = 'inbound' AND id = ?").run(row.id);
      dismissed.push(row.id);
    }
    return dismissed;
  }

  stage(stream: Stream, id: string, payload: string): boolean {
    this.db.query("INSERT OR IGNORE INTO delivery (stream, id, payload) VALUES (?, ?, ?)").run(stream, id, payload);
    return this.db.query<{ payload: string | null }, [string, string]>(
      "SELECT payload FROM delivery WHERE stream = ? AND id = ?",
    ).get(stream, id)?.payload !== null;
  }

  pending(stream: Stream): readonly { id: string; payload: string }[] {
    return this.db.query<{ id: string; payload: string }, [string]>(
      "SELECT id, payload FROM delivery WHERE stream = ? AND payload IS NOT NULL ORDER BY length(id), id",
    ).all(stream);
  }

  contains(stream: Stream, id: string): boolean {
    return this.db.query("SELECT 1 FROM delivery WHERE stream = ? AND id = ?").get(stream, id) !== null;
  }

  refresh(id: string, previous: string, payload: string): boolean {
    return this.db.query("UPDATE delivery SET payload = ? WHERE stream = 'inbound' AND id = ? AND payload = ?")
      .run(payload, id, previous).changes === 1;
  }

  recover(id: string, previous: string, payload: string): boolean {
    return this.db.transaction(() => {
      if (this.status("inbound", id).disposition !== "pending") return false;
      return this.refresh(id, previous, payload);
    }).immediate();
  }

  /** Only unaccepted inbound requests can age out. Callers clean the returned IDs after commit. */
  expire(now?: number, id?: string): { readonly expired: readonly string[]; readonly warnings: readonly string[] } {
    const warnings: string[] = [];
    this.db.transaction(() => {
      const evaluatedAt = now ?? Date.now();
      const rows = this.db.query<{ id: string; payload: string }, [string | null]>(`
        SELECT d.id, d.payload FROM delivery d
        LEFT JOIN acceptance a ON a.stream = d.stream AND a.id = d.id
        LEFT JOIN handling h ON h.stream = d.stream AND h.id = d.id
        WHERE d.stream = 'inbound' AND d.payload IS NOT NULL AND a.id IS NULL AND h.id IS NULL
          AND (?1 IS NULL OR d.id = ?1)`).all(id ?? null);
      for (const row of rows) {
        let payload: unknown;
        try { payload = JSON.parse(row.payload); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        const sentAt = typeof payload === "object" && payload !== null && "sent_at" in payload ? payload.sent_at : undefined;
        const timestamp = requestTimestamp(sentAt);
        if (timestamp === undefined) {
          warnings.push(`message_id=${row.id} invalid or missing sent_at; retained pending`);
          continue;
        }
        if (evaluatedAt - timestamp <= REQUEST_MAX_AGE_MS) continue;
        this.db.query("INSERT INTO expiry (stream, id, reason) VALUES ('inbound', ?, ?)")
          .run(row.id, `Unhandled inbound request older than 72h from sent_at=${sentAt}`);
        this.db.query("UPDATE delivery SET payload = NULL WHERE stream = 'inbound' AND id = ?").run(row.id);
      }
    }).immediate();
    return {
      expired: this.db.query<{ id: string }, []>("SELECT id FROM expiry WHERE attachments_cleaned = 0").all().map((row) => row.id),
      warnings,
    };
  }

  cleaned(id: string): void {
    this.db.query("UPDATE expiry SET attachments_cleaned = 1 WHERE stream = 'inbound' AND id = ?").run(id);
  }

  check(id: string, now?: number): void {
    for (const warning of this.expire(now, id).warnings) console.warn(`DELIVERY_WARN ${warning}`);
    const state = this.status("inbound", id).disposition;
    if (state !== "pending" && state !== "accepted") throw new RangeError(`Delivery ${id} has disposition ${state}; cannot act`);
    this.requireKnownTimestamp(id);
  }

  accept(id: string, now?: number): void {
    const accepted = this.db.transaction(() => {
      for (const warning of this.expire(now, id).warnings) console.warn(`DELIVERY_WARN ${warning}`);
      const state = this.status("inbound", id).disposition;
      if (state !== "pending" && state !== "accepted") return false;
      this.requireKnownTimestamp(id);
      this.db.query("INSERT OR IGNORE INTO acceptance (stream, id) VALUES ('inbound', ?)").run(id);
      return true;
    }).immediate();
    if (!accepted) this.check(id, now);
  }

  acknowledge(stream: Stream, id: string): void {
    this.finish(stream, id, "done", null);
  }

  irrelevant(id: string, reason: string): BlockResult {
    if (!reason.trim() || reason.length > 500) throw new TypeError("An irrelevant disposition needs a reason of 1-500 characters");
    return this.finish("inbound", id, "irrelevant", reason.trim());
  }

  status(stream: Stream, id: string) {
    const row = this.db.query<{
      payload: string | null; disposition: Disposition | null; reason: string | null; handled_at: string | null;
      expired_reason: string | null; expired_at: string | null; accepted_at: string | null;
    }, [string, string]>(`SELECT d.payload, h.disposition, h.reason, h.handled_at,
        e.reason AS expired_reason, e.expired_at, a.accepted_at
      FROM delivery d LEFT JOIN handling h ON d.stream = h.stream AND d.id = h.id
      LEFT JOIN expiry e ON d.stream = e.stream AND d.id = e.id
      LEFT JOIN acceptance a ON d.stream = a.stream AND d.id = a.id
      WHERE d.stream = ? AND d.id = ?`).get(stream, id);
    if (!row) throw new RangeError(`Unknown ${stream} delivery ${id}`);
    return {
      disposition: row.expired_at !== null ? "expired" :
        row.payload !== null ? row.accepted_at !== null ? "accepted" : "pending" : row.disposition ?? "legacy-done",
      reason: row.expired_reason ?? row.reason,
      handled_at: row.expired_at ?? row.handled_at,
    };
  }

  private finish(stream: Stream, id: string, disposition: Disposition, reason: string | null): BlockResult {
    if (stream === "inbound") {
      for (const warning of this.expire(undefined, id).warnings) console.warn(`DELIVERY_WARN ${warning}`);
    }
    return this.db.transaction((): BlockResult => {
      const row = this.db.query<{ payload: string | null }, [string, string]>(
        "SELECT payload FROM delivery WHERE stream = ? AND id = ?",
      ).get(stream, id);
      if (!row) throw new RangeError(`Unknown ${stream} delivery ${id}`);
      if (row.payload === null) {
        const previous = this.status(stream, id).disposition;
        if (previous !== disposition && !(previous === "legacy-done" && disposition === "done")) {
          throw new RangeError(`Delivery ${id} already has disposition ${previous}`);
        }
        return { dismissed: [] };
      }
      if (stream === "inbound") this.requireKnownTimestamp(id);
      if (disposition === "irrelevant") {
        const payload: unknown = JSON.parse(row.payload);
        if (typeof payload !== "object" || payload === null ||
            !("attention" in payload) || !("role" in payload) || !("scope" in payload) ||
            payload.role === "BOT_BUG_REPORT" || payload.scope === "evidence-only" ||
            (payload.attention !== "review" &&
              !(payload.attention === "direct" && "channel_policy" in payload && payload.channel_policy === "normal")) ||
            this.status(stream, id).disposition === "accepted") {
          throw new RangeError(`Delivery ${id} is protected or lacks relevance metadata; keep it pending`);
        }
      }
      this.db.query("INSERT INTO handling (stream, id, disposition, reason) VALUES (?, ?, ?, ?)")
        .run(stream, id, disposition, reason);
      this.db.query("UPDATE delivery SET payload = NULL WHERE stream = ? AND id = ?").run(stream, id);
      return disposition === "irrelevant" ? this.strikeFor(id, JSON.parse(row.payload)) : { dismissed: [] };
    }).immediate();
  }

  /** Only an explicit ping by an ordinary user in an untrusted chat counts toward the automatic blacklist. */
  private strikeFor(id: string, payload: Record<string, unknown>): BlockResult {
    const { role, channel_policy, pinged, author_id, channel_id } = payload;
    const at = requestTimestamp(payload.sent_at);
    if (role !== "STAFF_QUESTION" || channel_policy !== "normal" || pinged !== true || at === undefined ||
        typeof author_id !== "string" || typeof channel_id !== "string" ||
        !this.moderation.strike(id, author_id, channel_id, at)) return { dismissed: [] };
    const { strikes, windowMs } = this.moderation.settings;
    const blocked = this.moderation.insertBlock(author_id, {
      source: "auto", reason: `${strikes} irrelevant pings within ${windowMs / 3_600_000} hours`, by: "helio",
      evidenceMessageId: id, evidenceChannelId: channel_id,
    }, new Set(), Date.now());
    return { blocked, dismissed: this.dismissFrom(author_id) };
  }

  close(): void {
    this.db.close();
  }

  private requireKnownTimestamp(id: string): void {
    const row = this.db.query<{ payload: string | null }, [string]>(
      "SELECT payload FROM delivery WHERE stream = 'inbound' AND id = ?",
    ).get(id);
    let payload: unknown;
    try { payload = row?.payload ? JSON.parse(row.payload) : undefined; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const timestamp = typeof payload === "object" && payload !== null && "sent_at" in payload ?
      requestTimestamp(payload.sent_at) : undefined;
    if (timestamp === undefined) {
      console.warn(`DELIVERY_WARN message_id=${id} invalid or missing sent_at; side effects refused`);
      throw new RangeError(`Delivery ${id} has unknown age; keep it pending`);
    }
  }
}
