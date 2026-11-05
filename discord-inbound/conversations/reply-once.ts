import { Database } from "bun:sqlite";
import type { Rest } from "../discord/rest.ts";

export const STALE_SEND_MS = 120_000;
/** Identity receipts (target and text hash only) outlive every replay and catch-up horizon. */
const RETAIN_MS = 180 * 24 * 60 * 60 * 1000;

export interface SendOnce {
  readonly path: string;
  readonly target: string;
  readonly text: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly send: () => Promise<string>;
  /** A reply Discord already has for this target with this text, after a send whose outcome is unknown. */
  readonly findSent: () => Promise<string | undefined>;
}

type Claim = { kind: "mine" | "wait" } | { kind: "sent"; id: string } | { kind: "stale"; since: number };

/** Find a previously accepted reply before an uncertain send is retried. */
export async function findSentReply(rest: Rest, target: { readonly channel_id: string; readonly message_id: string },
  text: string): Promise<string | undefined> {
  const me = await rest<{ id: string }>("/users/@me");
  let after = target.message_id;
  for (let page = 0; page < 50; page++) {
    const messages = await rest<{ id: string; content: string; author: { id: string }; message_reference?: { message_id?: string } }[]>(
      `/channels/${target.channel_id}/messages?after=${after}&limit=100`);
    const found = messages.find((message) => message.author.id === me.id && message.message_reference?.message_id === target.message_id &&
      message.content === text);
    if (found) return found.id;
    if (messages.length < 100) return undefined;
    after = messages.map((message) => message.id).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  }
  throw new Error("Reply history is incomplete; inspect before retrying the uncertain send");
}

/**
 * Sends one reply per (target message, exact text), across processes. A second identical send waits for the
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
    db.run("DELETE FROM reply_sends WHERE started_at < ? AND state = 'sent'", [o.now() - RETAIN_MS]);
    const hash = new Bun.CryptoHasher("sha256").update(o.text).digest("hex");
    const key = [o.target, hash] as const;
    const claim = db.transaction((): Claim => {
      const row = db.query<{ state: string; reply_id: string | null; started_at: number }, [string, string]>(
        "SELECT state, reply_id, started_at FROM reply_sends WHERE target = ? AND text_hash = ?").get(...key);
      if (!row) {
        db.run("INSERT INTO reply_sends VALUES (?, ?, 'sending', NULL, ?)", [...key, o.now()]);
        return { kind: "mine" };
      }
      if (row.state === "sent" && row.reply_id) return { kind: "sent", id: row.reply_id };
      return o.now() - row.started_at < STALE_SEND_MS ? { kind: "wait" } : { kind: "stale", since: row.started_at };
    });
    const takeOver = db.transaction((since: number) =>
      db.run("UPDATE reply_sends SET started_at = ? WHERE target = ? AND text_hash = ? AND state = 'sending' AND started_at = ?",
        [o.now(), ...key, since]).changes === 1);
    const record = (id: string) =>
      db.run("UPDATE reply_sends SET state = 'sent', reply_id = ? WHERE target = ? AND text_hash = ?", [id, ...key]);
    for (;;) {
      const current = claim.immediate();
      if (current.kind === "sent") return { id: current.id, duplicate: true };
      if (current.kind === "wait") {
        await o.sleep(500);
        continue;
      }
      if (current.kind === "stale") {
        const existing = await o.findSent();
        if (existing) {
          record(existing);
          return { id: existing, duplicate: true };
        }
        if (!takeOver.immediate(current.since)) continue;
      }
      let id: string;
      try {
        id = await o.send();
      } catch (error) {
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
