import type { Database } from "bun:sqlite";
import { requestTimestamp } from "../delivery/delivery.ts";

export interface TopicSelection { readonly channel: string; readonly user: string; readonly anchor: string }
export interface TopicInspection extends TopicSelection {
  readonly digest: string;
  readonly notices: readonly string[];
  readonly action: "remove-notices" | "preserve";
  readonly reason: string;
  readonly meaningful_activity: number | null;
}
const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

/** SELECT only: preview never constructs a migrating conversation writer. */
export function inspectTopic(db: Database, topic: TopicSelection, requested: readonly string[]): TopicInspection {
  const row = db.query<Record<string, unknown>, [string, string, string]>(
    "SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND anchor_message_id=? ORDER BY opened_at DESC LIMIT 1")
    .get(topic.channel, topic.user, topic.anchor);
  if (!row) return { ...topic, digest: hash(null), notices: [], action: "preserve", reason: "Topic is absent", meaningful_activity: null };
  const transcript = db.query<{ message_id: string; author_id: string; sent_at: string | null; entry: string }, [string, string, number]>(
    "SELECT message_id,author_id,sent_at,entry FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=? ORDER BY rowid")
    .all(topic.channel, topic.user, Number(row.opened_at));
  const notices = requested.filter(id => transcript.some(entry => entry.message_id === id) &&
    db.query("SELECT 1 FROM conversation_notices WHERE message_id=?").get(id) !== null);
  const activity = transcript.map(entry => {
    if (entry.author_id === topic.user) {
      const working = db.query<{ claimed_at: number | null }, [string, string, string]>(
        "SELECT claimed_at FROM working WHERE message_id=? AND channel_id=? AND user_id=?")
        .get(entry.message_id, topic.channel, topic.user);
      return { id: entry.message_id, at: working?.claimed_at ?? undefined };
    }
    const saved: unknown = JSON.parse(entry.entry);
    const bot = typeof saved === "object" && saved !== null && "bot" in saved && saved.bot === true;
    return { id: entry.message_id, at: bot ? requestTimestamp(entry.sent_at) : undefined };
  });
  const complete = activity.every(event => typeof event.at === "number" && Number.isFinite(event.at)) &&
    typeof row.opened_at === "number" && row.last_activity === Math.max(row.opened_at, ...activity.map(event => event.at ?? 0));
  const meaningful = complete ? Math.max(Number(row.opened_at), ...activity.filter(event => !notices.includes(event.id)).map(event => event.at ?? 0)) : null;
  const digest = hash({ row, transcript, requested, notices, activity });
  const action = row.status === "open" && notices.length ? "remove-notices" : "preserve";
  return { ...topic, digest, notices, action, meaningful_activity: meaningful, reason: action === "remove-notices" ?
    meaningful === null ? "Remove proven courtesy entries; retain ambiguous activity and current reply meaning" :
      "Remove proven courtesy entries and derive meaningful activity; preserve current reply meaning" :
    row.status === "on_hold" ? "Explicit hold retained" : "No proven courtesy entry in an open topic" };
}

/** The existing conversation owner commits one topic and its resumable receipt together. */
export class TopicReconciliation {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_repairs (
      repair_key TEXT PRIMARY KEY,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,anchor TEXT NOT NULL,
      before_digest TEXT NOT NULL,after_digest TEXT NOT NULL,notice_ids TEXT NOT NULL,
      repaired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  }

  apply(key: string, expected: TopicInspection, requested: readonly string[]): "applied" | "already-applied" | "changed" | "preserved" {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM conversation_repairs WHERE repair_key=?").get(key)) return "already-applied";
      const current = inspectTopic(this.db, expected, requested);
      if (current.digest !== expected.digest) return "changed";
      if (current.action !== "remove-notices") return "preserved";
      for (const id of current.notices) this.db.run(`DELETE FROM transcript WHERE message_id=? AND channel_id=? AND user_id=?
        AND opened_at=(SELECT opened_at FROM conversations WHERE channel_id=? AND user_id=? AND anchor_message_id=?
          ORDER BY opened_at DESC LIMIT 1)`,
      [id, current.channel, current.user, current.channel, current.user, current.anchor]);
      // Repair only historical activity. Legacy meaning remains unknown; a current explicit question stays valid.
      this.db.run(`UPDATE conversations SET revision=revision+1,
        last_activity=coalesce(?,last_activity)
        WHERE channel_id=? AND user_id=? AND anchor_message_id=? AND status='open'`,
      [current.meaningful_activity, current.channel, current.user, current.anchor]);
      const after = inspectTopic(this.db, current, requested);
      this.db.run(`INSERT INTO conversation_repairs(repair_key,channel_id,user_id,anchor,before_digest,after_digest,notice_ids)
        VALUES(?,?,?,?,?,?,?)`, [key, current.channel, current.user, current.anchor, current.digest, after.digest,
        JSON.stringify(current.notices)]);
      return "applied";
    }).immediate();
  }
}
