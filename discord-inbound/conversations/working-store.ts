import type { Database } from "bun:sqlite";

export const WORKING_WINDOW_MS = 30 * 60 * 1000;
export const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + 1420070400000n);

export interface Working {
  readonly message_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly started_at: number;
  readonly closed_at: number | null;
  readonly claimed_at: number | null;
  readonly intake_at: number | null;
  /** 1 when an add was attempted and the reaction may still need removing. */
  readonly reacted: number;
  readonly warned: number;
  readonly guards: number;
  readonly first_guard_at: number | null;
}

/** Claim and intake-window persistence shared by the conversation database's writers. */
export class WorkingStore {
  constructor(protected readonly db: Database) {}

  openWorking(channel: string, user: string, messageId: string, now: number): Working {
    return this.db.transaction(() => {
      const open = this.db.query<Working, [string, string, number]>(`SELECT * FROM working
        WHERE channel_id=? AND user_id=? AND closed_at IS NULL
          AND coalesce(intake_at,claimed_at) >= ?
        ORDER BY coalesce(intake_at,claimed_at) DESC LIMIT 1`).get(channel, user, now - WORKING_WINDOW_MS);
      if (open) return open;
      const row = this.ensureWorking(channel, user, messageId);
      if (row.closed_at !== null) return row;
      const intake_at = row.intake_at ?? snowflakeTime(messageId);
      this.db.query("UPDATE working SET intake_at=? WHERE message_id=?").run(intake_at, messageId);
      return { ...row, intake_at };
    }).immediate();
  }

  ensureWorking(channel: string, user: string, messageId: string): Working {
    const existing = this.working(messageId);
    if (existing) return existing;
    const row: Working = {
      message_id: messageId, channel_id: channel, user_id: user, started_at: snowflakeTime(messageId),
      closed_at: null, claimed_at: null, intake_at: null, reacted: 0, warned: 0, guards: 0, first_guard_at: null,
    };
    this.db.query("INSERT OR IGNORE INTO working (message_id,channel_id,user_id,started_at) VALUES (?,?,?,?)")
      .run(messageId, channel, user, row.started_at);
    return row;
  }

  claimWorking(channel: string, user: string, messageId: string, now: number): Working {
    return this.db.transaction(() => {
      const row = this.ensureWorking(channel, user, messageId);
      if (row.closed_at !== null || row.claimed_at !== null) return row;
      this.db.query("UPDATE working SET claimed_at=? WHERE message_id=?").run(now, messageId);
      return { ...row, claimed_at: now };
    }).immediate();
  }

  working(messageId: string): Working | null {
    return this.db.query<Working, [string]>("SELECT * FROM working WHERE message_id=?").get(messageId);
  }

  /** A guard-only or unclaimed row cannot admit another message. */
  workingAnchor(channel: string, user: string, messageId: string): string | undefined {
    const sent = snowflakeTime(messageId);
    return this.db.query<{ message_id: string }, [string, string, string, number, number]>(`SELECT message_id FROM working
      WHERE channel_id=? AND user_id=? AND message_id<>?
        AND coalesce(intake_at,claimed_at) < ?4
        AND ?4 <= min(coalesce(closed_at,?4),coalesce(intake_at,claimed_at)+?5)
      ORDER BY coalesce(intake_at,claimed_at) DESC LIMIT 1`)
      .get(channel, user, messageId, sent, WORKING_WINDOW_MS)?.message_id;
  }

  setReacted(messageId: string, reacted: boolean): void {
    this.db.query("UPDATE working SET reacted=? WHERE message_id=?").run(reacted ? 1 : 0, messageId);
  }

  markWarned(messageId: string): void {
    this.db.query("UPDATE working SET warned=1 WHERE message_id=?").run(messageId);
  }

  closeWorking(messageIds: readonly string[], now: number): Working[] {
    return this.db.transaction(() => {
      const out: Working[] = [];
      for (const id of new Set(messageIds)) {
        this.db.query("UPDATE working SET closed_at=? WHERE message_id=? AND closed_at IS NULL").run(now, id);
        const row = this.working(id);
        if (row?.reacted) out.push(row);
      }
      return out;
    }).immediate();
  }

  holdReply(channel: string, user: string, messageId: string, now: number, limit = 2, withinMs = 120_000): boolean {
    return this.db.transaction(() => {
      const row = this.ensureWorking(channel, user, messageId);
      if (row.guards >= limit || (row.first_guard_at !== null && now - row.first_guard_at >= withinMs)) return false;
      this.db.query("UPDATE working SET guards=guards+1,first_guard_at=coalesce(first_guard_at,?) WHERE message_id=?")
        .run(now, messageId);
      return true;
    }).immediate();
  }

  openWorkingRows(): Working[] {
    return this.db.query<Working, []>("SELECT * FROM working WHERE closed_at IS NULL OR reacted=1 ORDER BY started_at").all();
  }

  pruneWorking(now: number): void {
    this.db.query("DELETE FROM working WHERE reacted=0 AND coalesce(closed_at,started_at) < ?")
      .run(now - 72 * 60 * 60 * 1000);
  }

  dispose(): void { this.db.close(); }
}
