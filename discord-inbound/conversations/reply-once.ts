import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Rest } from "../discord/rest.ts";

export const STALE_SEND_MS = 120_000;
/** Identity receipts (target and text hash only) outlive every replay and catch-up horizon. */
const RETAIN_MS = 180 * 24 * 60 * 60 * 1000;

export interface SendOnce {
  readonly path: string;
  readonly target: string;
  readonly text: string;
  /** The request's logical delivery event, independent of a producer's wording. */
  readonly event?: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly send: () => Promise<string>;
  /** A reply Discord already has for this target with this text, after a send whose outcome is unknown. */
  readonly findSent: (text: string, otherReplyIds: readonly string[]) => Promise<string | undefined>;
  /** Asynchronous notices retain an occupied/uncertain send instead of waiting or posting again. */
  readonly waitForOther?: boolean;
  readonly retryUncertain?: boolean;
  /** A definitive rejection proves no remote effect and releases only this send claim. */
  readonly definitiveFailure?: (error: unknown) => boolean;
  /** Persisted before dispatch so the gateway can identify a terminal echo before the HTTP response. */
  readonly notification?: { readonly channel: string; readonly nonce: string };
}

type Claim = { kind: "mine" | "wait" } | { kind: "sent"; id: string } | { kind: "stale"; since: number; text: string };

export function isTerminalReply(path: string, channel: string, messageId: string, nonce?: string | number): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='reply_sends'").get()) return false;
    if (db.query("SELECT 1 FROM reply_sends WHERE text_hash LIKE 'event:followup:%' AND reply_id=?")
      .get(messageId)) return true;
    if (nonce === undefined) return false;
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(reply_sends)").all().map(row => row.name));
    return columns.has("notification_nonce") && columns.has("notification_channel_id") &&
      db.query(`SELECT 1 FROM reply_sends WHERE text_hash LIKE 'event:followup:%'
        AND notification_channel_id=? AND notification_nonce=?`).get(channel, String(nonce)) !== null;
  } finally { db.close(); }
}

/** Find a previously accepted reply before an uncertain send is retried. */
export async function findSentReply(rest: Rest, target: {
  readonly channel_id: string; readonly message_id: string; readonly referenced?: boolean; readonly otherReplyIds?: readonly string[];
},
  text: string): Promise<string | undefined> {
  const me = await rest<{ id: string }>("/users/@me");
  let after = target.message_id;
  for (let page = 0; page < 50; page++) {
    const messages = await rest<{ id: string; content: string; author: { id: string }; message_reference?: { message_id?: string } }[]>(
      `/channels/${target.channel_id}/messages?after=${after}&limit=100`);
    const found = messages.find((message) => !target.otherReplyIds?.includes(message.id) && message.author.id === me.id &&
      (target.referenced === false || message.message_reference?.message_id === target.message_id) &&
      message.content === text);
    if (found) return found.id;
    if (messages.length < 100) return undefined;
    after = messages.map((message) => message.id).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  }
  throw new Error("Reply history is incomplete; inspect before retrying the uncertain send");
}

/**
 * Sends one reply per (target, event or exact text), across processes. A second producer waits for the
 * first and returns its reply instead of posting again. A send that failed or never finished leaves a stale
 * claim, so the next attempt first asks Discord whether that reply went out.
 */
export async function sendOnce(o: SendOnce): Promise<{ id: string; duplicate: boolean }> {
  const db = new Database(o.path, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS reply_sends (
      target TEXT NOT NULL, text_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('sending', 'sent')),
      reply_id TEXT, started_at INTEGER NOT NULL, PRIMARY KEY (target, text_hash))`);
    db.transaction(() => {
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(reply_sends)").all();
      if (!columns.some((column) => column.name === "pending_text")) {
        db.exec("ALTER TABLE reply_sends ADD COLUMN pending_text TEXT");
      }
      if (!columns.some(column => column.name === "notification_channel_id")) {
        db.exec("ALTER TABLE reply_sends ADD COLUMN notification_channel_id TEXT");
      }
      if (!columns.some(column => column.name === "notification_nonce")) {
        db.exec("ALTER TABLE reply_sends ADD COLUMN notification_nonce TEXT");
      }
    }).immediate();
    db.run("DELETE FROM reply_sends WHERE started_at < ? AND state = 'sent'", [o.now() - RETAIN_MS]);
    const hash = o.event ? `event:${o.event}` : new Bun.CryptoHasher("sha256").update(o.text).digest("hex");
    const key = [o.target, hash] as const;
    const claim = db.transaction((): Claim => {
      const row = db.query<{ state: string; reply_id: string | null; started_at: number; pending_text: string | null }, [string, string]>(
        "SELECT state, reply_id, started_at, pending_text FROM reply_sends WHERE target = ? AND text_hash = ?").get(...key);
      if (!row) {
        db.run(`INSERT INTO reply_sends
          (target,text_hash,state,reply_id,started_at,pending_text,notification_channel_id,notification_nonce)
          VALUES (?, ?, 'sending', NULL, ?, ?, ?, ?)`,
          [...key, o.now(), o.text, o.notification?.channel ?? null, o.notification?.nonce ?? null]);
        return { kind: "mine" };
      }
      if (o.notification) {
        db.run(`UPDATE reply_sends SET notification_channel_id=?,notification_nonce=?
          WHERE target=? AND text_hash=? AND notification_channel_id IS NULL AND notification_nonce IS NULL`,
        [o.notification.channel, o.notification.nonce, ...key]);
      }
      if (row.state === "sent" && row.reply_id) return { kind: "sent", id: row.reply_id };
      return o.now() - row.started_at < STALE_SEND_MS ? { kind: "wait" } :
        { kind: "stale", since: row.started_at, text: row.pending_text ?? o.text };
    });
    const takeOver = db.transaction((since: number) =>
      db.run("UPDATE reply_sends SET started_at = ?, pending_text = ? WHERE target = ? AND text_hash = ? AND state = 'sending' AND started_at = ?",
        [o.now(), o.text, ...key, since]).changes === 1);
    const record = (id: string) =>
      db.run("UPDATE reply_sends SET state = 'sent', reply_id = ?, started_at = ?, pending_text = NULL WHERE target = ? AND text_hash = ?",
        [id, o.now(), ...key]);
    for (;;) {
      const current = claim.immediate();
      if (current.kind === "sent") return { id: current.id, duplicate: true };
      if (current.kind === "wait") {
        if (o.waitForOther === false) throw new Error("Another sender owns this delivery; retained pending");
        await o.sleep(500);
        continue;
      }
      if (current.kind === "stale") {
        const otherReplies = db.query<{ reply_id: string }, [string, string]>(
          "SELECT reply_id FROM reply_sends WHERE target=? AND state='sent' AND reply_id IS NOT NULL AND text_hash != ?")
          .all(o.target, hash).map((row) => row.reply_id);
        const existing = await o.findSent(current.text, otherReplies);
        if (existing) {
          record(existing);
          return { id: existing, duplicate: true };
        }
        if (o.retryUncertain === false) throw new Error("Delivery outcome remains uncertain; no second message was sent");
        if (!takeOver.immediate(current.since)) continue;
      }
      let id: string;
      try {
        id = await o.send();
      } catch (error) {
        if (o.definitiveFailure?.(error)) {
          db.run("DELETE FROM reply_sends WHERE target=? AND text_hash=? AND state='sending'", [...key]);
          throw error;
        }
        // Discord may still have accepted it: leave a stale claim so the next attempt checks before sending.
        db.run("UPDATE reply_sends SET started_at = 0 WHERE target = ? AND text_hash = ? AND state = 'sending'", [...key]);
        throw error;
      }
      record(id);
      return { id, duplicate: false };
    }
  } finally {
    db.close();
  }
}
