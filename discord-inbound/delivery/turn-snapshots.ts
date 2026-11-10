import type { Database } from "bun:sqlite";
import { object } from "./monitor-summary.ts";

/** A burst owns one cached evidence snapshot, independently of any individual intake receipt. */
export class TurnSnapshots {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_context_snapshots (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  capture(ids: readonly string[]): void {
    if (ids.length < 2) return;
    this.db.transaction(() => {
      const pending = ids.flatMap(id => {
        const row = this.db.query<{ payload: string | null }, [string]>(
          "SELECT payload FROM delivery WHERE stream='inbound' AND id=?").get(id);
        return row?.payload ? [{ id, payload: row.payload, message: object(JSON.parse(row.payload)) }] : [];
      });
      const first = pending[0];
      if (pending.length < 2 || !first || !first.message.conversation) return;
      const initial = this.hydrate(first.message), conversation = object(initial.conversation);
      const channel = first.message.channel_id;
      if (typeof channel !== "string" || pending.some(row => row.message.channel_id !== channel)) {
        throw new TypeError("A context snapshot requires one authorized channel");
      }
      const seen = new Set(ids);
      const recent = (Array.isArray(conversation.recent) ? conversation.recent : []).slice(-10).filter(entry => {
        const id = object(entry).message_id;
        if (typeof id !== "string" || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const snapshot = typeof conversation.context_snapshot === "string" ? conversation.context_snapshot : first.id;
      this.db.run("INSERT OR IGNORE INTO turn_context_snapshots(id,channel_id,payload,created_at) VALUES(?,?,?,?)",
        [snapshot, channel, JSON.stringify(recent), Math.floor(Date.now() / 1000)]);
      for (const row of pending) {
        const context = row.message.conversation ? object(row.message.conversation) : {};
        const compact: Record<string, unknown> = { ...context, context_snapshot: snapshot };
        delete compact.recent;
        this.db.run("UPDATE delivery SET payload=? WHERE stream='inbound' AND id=? AND payload=?",
          [JSON.stringify({ ...row.message, conversation: compact }), row.id, row.payload]);
      }
    }).immediate();
  }

  hydrate(message: Record<string, unknown>): Record<string, unknown> {
    if (!message.conversation) return message;
    const conversation = object(message.conversation), snapshot = conversation.context_snapshot;
    if (typeof snapshot !== "string") return message;
    const row = this.db.query<{ channel_id: string; payload: string }, [string]>(
      "SELECT channel_id,payload FROM turn_context_snapshots WHERE id=?").get(snapshot);
    if (!row || row.channel_id !== message.channel_id) {
      throw new RangeError("Cached turn snapshot is unavailable or changed channel; inspect the retained input");
    }
    return { ...message, conversation: { ...conversation, recent: JSON.parse(row.payload) } };
  }
}
