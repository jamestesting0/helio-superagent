import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Conversations, TopicRevision } from "./conversations.ts";
import { newerInputPending } from "./pending-input.ts";

export type ReplyDisposition = "final" | "progress" | "question";
export interface ReplyMeaning {
  readonly disposition: ReplyDisposition;
  readonly waiting_on?: string;
  readonly job?: string;
  readonly issue?: string;
}
interface Receipt {
  readonly key: string;
  readonly topics: string;
  readonly meaning: string;
  readonly delivered: number;
  readonly outcomes: string | null;
  readonly required_sends: string;
}
export interface RequiredSend { readonly target: string; readonly event: string }

/** Shares the send receipt database. Routed sends must all succeed before delivered is recorded. */
export class ReplySettlements {
  private readonly db: Database;
  constructor(private readonly path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS reply_settlements (
        key TEXT PRIMARY KEY,topics TEXT NOT NULL,meaning TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,outcomes TEXT,required_sends TEXT NOT NULL DEFAULT '[]')`);
  }

  prepare(key: string, topics: readonly TopicRevision[], meaning: ReplyMeaning, required: readonly RequiredSend[] = []): Receipt {
    if (meaning.job && (!/^[a-z0-9][a-z0-9._-]{1,60}$/.test(meaning.job) || meaning.job.includes(".."))) throw new TypeError("Invalid stable job");
    if (meaning.disposition === "question" && (!meaning.waiting_on?.trim() || meaning.waiting_on.length > 300)) {
      throw new TypeError("A question needs --waiting-on with 1-300 characters");
    }
    const repo = process.env.HELIO_GITHUB_REPO;
    if (meaning.issue && repo && !meaning.issue.startsWith(`https://github.com/${repo}/issues/`)) {
      throw new TypeError("Reply issue must belong to the configured repository");
    }
    const issueJob = /^issue-([1-9]\d*)$/.exec(meaning.job ?? "")?.[1];
    if (issueJob && meaning.issue && !meaning.issue.endsWith(`/issues/${issueJob}`)) {
      throw new TypeError("Reply issue and stable job disagree");
    }
    // The reply's own channel and the person it answered decide where a question waits and which input is newer.
    const refs = topics.map(({ channel_id, user_id, opened_at, anchor_message_id, revision, last_activity, covered, reply_channel, asked_user, asked_message }) =>
      ({ channel_id, user_id, opened_at, anchor_message_id, revision, last_activity, ...(covered ? { covered } : {}),
        ...(reply_channel ? { reply_channel } : {}), ...(asked_user ? { asked_user } : {}), ...(asked_message ? { asked_message } : {}) }));
    this.db.run("INSERT OR IGNORE INTO reply_settlements(key,topics,meaning,required_sends) VALUES(?,?,?,?)",
      [key, JSON.stringify(refs), JSON.stringify(meaning), JSON.stringify(required)]);
    const receipt = this.db.query<Receipt, [string]>("SELECT * FROM reply_settlements WHERE key=?").get(key)!;
    if (receipt.meaning !== JSON.stringify(meaning)) throw new RangeError("Reply event already has a different disposition");
    if (!receipt.delivered && receipt.required_sends !== JSON.stringify(required)) {
      throw new RangeError("Reply event has pending routes; resume its original delivery helper");
    }
    return receipt;
  }

  delivered(key: string): void { this.db.run("UPDATE reply_settlements SET delivered=1 WHERE key=?", [key]); }

  /** Recover the send-to-settlement gap from the existing durable send records, without another POST. */
  recover(key: string, store: Conversations, now: number): readonly string[] | undefined {
    const receipt = this.db.query<Receipt, [string]>("SELECT * FROM reply_settlements WHERE key=?").get(key);
    if (!receipt) return undefined;
    if (!receipt.delivered) {
      const required: RequiredSend[] = JSON.parse(receipt.required_sends);
      if (!required.length || !this.db.query("SELECT 1 FROM sqlite_master WHERE name='reply_sends'").get()) return undefined;
      if (!required.every(send => this.db.query(
        "SELECT 1 FROM reply_sends WHERE target=? AND text_hash=? AND state='sent' AND reply_id IS NOT NULL")
        .get(send.target, `event:${send.event}`))) return undefined;
      this.delivered(key);
    }
    return this.settle(key, store, now);
  }

  settle(key: string, store: Conversations, now: number): readonly string[] {
    const receipt = this.db.query<Receipt, [string]>("SELECT * FROM reply_settlements WHERE key=?").get(key);
    if (!receipt?.delivered) return [];
    if (receipt.outcomes !== null) return JSON.parse(receipt.outcomes);
    const refs: TopicRevision[] = JSON.parse(receipt.topics);
    const meaning: ReplyMeaning = JSON.parse(receipt.meaning);
    const queuePath = join(dirname(this.path), "discord-delivery.sqlite");
    let pending: { id: string; payload: string }[] = [];
    if (existsSync(queuePath)) {
      const queue = new Database(queuePath, { readonly: true });
      try { pending = queue.query<{ id: string; payload: string }, []>(
        "SELECT id,payload FROM delivery WHERE stream='inbound' AND payload IS NOT NULL").all(); }
      finally { queue.close(); }
    }
    const outcomes = refs.map(row => newerInputPending(pending, store, row, row.covered ?? [row.anchor_message_id]) ?
      "newer-input" : store.applyReply(row, meaning, now, key));
    this.db.run("UPDATE reply_settlements SET outcomes=? WHERE key=? AND outcomes IS NULL", [JSON.stringify(outcomes), key]);
    return outcomes;
  }

  close(): void { this.db.close(); }
}
