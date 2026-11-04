import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { object } from "./monitor-summary.ts";

export type RecoveryOutcome = "resume" | "settled" | "informational" | "needs-review";
export interface RecoveryReview {
  readonly outcome: RecoveryOutcome;
  readonly reason: string;
  readonly evidence: string;
}

export class RecoveryRequiredError extends Error {}

export function sourceHash(payload: string): string {
  const message = object(JSON.parse(payload));
  const origin = message.discord_origin ? object(message.discord_origin) : {};
  return typeof origin.content_sha256 === "string" ? origin.content_sha256 :
    new Bun.CryptoHasher("sha256").update(typeof message.content === "string" ? message.content : "").digest("hex");
}

/** Review receipts share the delivery database; they never authorize an external action. */
export class RecoveryStore {
  constructor(private readonly db: Database) {
    db.exec(readFileSync(new URL("./recovery-schema.sql", import.meta.url), "utf8"));
  }

  begin(now = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const rows = this.db.query<{ id: string; payload: string }, []>(
        "SELECT id,payload FROM delivery WHERE stream='inbound' AND payload IS NOT NULL").all();
      for (const row of rows) this.flag(row.id, row.payload, now, true);
      return rows.length;
    }).immediate();
  }

  flag(id: string, payload: string, now = new Date().toISOString(), reset = false): void {
    let hash: string;
    try { hash = sourceHash(payload); }
    catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
      hash = "malformed";
    }
    if (reset) {
      this.db.run(`INSERT INTO inbound_recovery(id,source_hash,required_at) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,required_at=excluded.required_at,
        reviewed_at=NULL,outcome=NULL,reason=NULL,evidence=NULL`, [id, hash, now]);
    } else {
      this.db.run(`INSERT INTO inbound_recovery(id,source_hash,required_at) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,required_at=excluded.required_at,
        reviewed_at=NULL,outcome=NULL,reason=NULL,evidence=NULL
        WHERE inbound_recovery.source_hash!=excluded.source_hash`, [id, hash, now]);
    }
  }

  status(id: string) {
    return this.db.query<{
      source_hash: string; required_at: string; reviewed_at: string | null;
      outcome: RecoveryOutcome | null; reason: string | null; evidence: string | null;
    }, [string]>("SELECT source_hash,required_at,reviewed_at,outcome,reason,evidence FROM inbound_recovery WHERE id=?").get(id);
  }

  requireReviewed(id: string, payload: string): void {
    const review = this.status(id);
    if (!review) return;
    if (review.source_hash !== sourceHash(payload) || !review.reviewed_at || review.outcome !== "resume") {
      throw new RecoveryRequiredError(`Recovered delivery ${id} needs current-state review; use helio recovery scan/review before replying.`);
    }
  }

  priorReply(id: string): string | undefined {
    const review = this.status(id);
    if (!review?.evidence) return undefined;
    const evidence = object(JSON.parse(review.evidence));
    const replies = evidence.prior_replies;
    return Array.isArray(replies) ? replies.find((value): value is string => typeof value === "string") : undefined;
  }

  review(id: string, payload: string, review: RecoveryReview): void {
    if (!review.reason.trim() || review.reason.length > 1000) throw new TypeError("Recovery review needs a reason of 1-1000 characters");
    const current = this.status(id);
    if (!current || current.source_hash !== sourceHash(payload)) {
      throw new RecoveryRequiredError("Delivery changed or is not recovery work; scan it again.");
    }
    this.db.run("UPDATE inbound_recovery SET reviewed_at=?,outcome=?,reason=?,evidence=? WHERE id=?",
      [new Date().toISOString(), review.outcome, review.reason.trim(), review.evidence, id]);
  }

  saveReport(data: string): string {
    const id = crypto.randomUUID();
    this.db.run("DELETE FROM recovery_reports WHERE created_at<?", [new Date(Date.now() - 7 * 86400_000).toISOString()]);
    this.db.run("INSERT INTO recovery_reports VALUES (?,?,?)", [id, new Date().toISOString(), data]);
    return id;
  }

  report(id: string): string | undefined {
    return this.db.query<{ data: string }, [string]>("SELECT data FROM recovery_reports WHERE id=?").get(id)?.data;
  }
}
