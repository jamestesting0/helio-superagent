import type { Database } from "bun:sqlite";
import type { Conversation } from "./conversations.ts";

export interface NoticeIntent {
  readonly channel_id: string;
  readonly user_id: string;
  readonly opened_at: number;
  readonly generation: number;
  readonly kind: "nudge" | "timeout";
  readonly revision: number;
  readonly target_id: string;
  readonly nonce: string;
  readonly owner: string;
  readonly created_at: number;
  readonly state: "sending" | "uncertain" | "sent" | "cancelled";
  readonly message_id: string | null;
  readonly settled: number;
  /** Where the notice is sent; a question can wait in a channel other than the topic's origin. */
  readonly send_channel_id: string | null;
}

/** One owner may send an intent. An interrupted owner is reconciled, never replaced by a lease. */
export class NoticeStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_notice_intents (
      channel_id TEXT NOT NULL,user_id TEXT NOT NULL,opened_at INTEGER NOT NULL,generation INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('nudge','timeout')),revision INTEGER NOT NULL,target_id TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sending','uncertain','sent','cancelled')),
      message_id TEXT,settled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id,user_id,opened_at,generation,kind))`);
    if (!db.query<{ name: string }, []>("PRAGMA table_info(conversation_notice_intents)").all().some(column => column.name === "send_channel_id")) {
      db.exec("ALTER TABLE conversation_notice_intents ADD COLUMN send_channel_id TEXT");
    }
  }

  current(intent: NoticeIntent): boolean {
    return this.db.query(`SELECT 1 FROM conversations WHERE channel_id=? AND user_id=? AND opened_at=?
      AND revision=? AND question_generation=? AND status='open' AND reply_disposition='question'
      AND question_started_at IS NOT NULL AND waiting_on!=''`)
      .get(intent.channel_id, intent.user_id, intent.opened_at, intent.revision, intent.generation) !== null;
  }

  claim(row: Conversation, kind: NoticeIntent["kind"], target: string, now: number, channel = row.channel_id):
    { readonly intent: NoticeIntent; readonly mine: boolean } | undefined {
    return this.db.transaction(() => {
      const values = [row.channel_id, row.user_id, row.opened_at, row.question_generation, kind] as const;
      const existing = this.db.query<NoticeIntent, [string, string, number, number, string]>(
        `SELECT * FROM conversation_notice_intents WHERE channel_id=? AND user_id=? AND opened_at=? AND generation=? AND kind=?`)
        .get(...values);
      if (existing) return { intent: existing, mine: false };
      const nonce = new Bun.CryptoHasher("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 25);
      const intent: NoticeIntent = { channel_id: row.channel_id, user_id: row.user_id, opened_at: row.opened_at,
        generation: row.question_generation, kind, revision: row.revision, target_id: target,
        nonce, owner: crypto.randomUUID(), created_at: now, state: "sending", message_id: null, settled: 0, send_channel_id: channel };
      if (!this.current(intent)) return undefined;
      this.db.run(`INSERT INTO conversation_notice_intents
        (channel_id,user_id,opened_at,generation,kind,revision,target_id,nonce,owner,created_at,state,send_channel_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,'sending',?)`,
      [...values, row.revision, target, nonce, intent.owner, now, channel]);
      return { intent, mine: true };
    }).immediate();
  }

  complete(intent: NoticeIntent, messageId: string, now: number): NoticeIntent {
    return this.db.transaction((): NoticeIntent => {
      const previous = this.db.query<NoticeIntent, [string]>(
        "SELECT * FROM conversation_notice_intents WHERE nonce=?").get(intent.nonce)!;
      if (previous.message_id && previous.message_id !== messageId) throw new RangeError("Notice nonce has conflicting Discord receipts");
      this.db.run("UPDATE conversation_notice_intents SET state='sent',message_id=? WHERE nonce=?", [messageId, intent.nonce]);
      this.db.run("INSERT OR IGNORE INTO conversation_notices(message_id,created_at) VALUES(?,?)", [messageId, now]);
      return { ...previous, state: "sent", message_id: messageId };
    }).immediate();
  }

  observe(channel: string, nonce: string | number | undefined, messageId: string, now: number): boolean {
    if (nonce === undefined) return false;
    const intent = this.db.query<NoticeIntent, [string, string]>(
      "SELECT * FROM conversation_notice_intents WHERE coalesce(send_channel_id,channel_id)=? AND nonce=?").get(channel, String(nonce));
    if (!intent) return false;
    this.complete(intent, messageId, now);
    return true;
  }

  uncertain(intent: NoticeIntent): void {
    this.db.run("UPDATE conversation_notice_intents SET state='uncertain' WHERE nonce=? AND owner=? AND state='sending'",
      [intent.nonce, intent.owner]);
  }

  cancel(intent: NoticeIntent): void {
    this.db.run("UPDATE conversation_notice_intents SET state='cancelled' WHERE nonce=? AND owner=? AND state='sending'",
      [intent.nonce, intent.owner]);
  }

  markSettled(intent: NoticeIntent): void {
    this.db.run("UPDATE conversation_notice_intents SET settled=1 WHERE nonce=?", [intent.nonce]);
  }
}
