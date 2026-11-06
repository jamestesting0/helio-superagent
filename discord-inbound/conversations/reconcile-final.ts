import type { Database } from "bun:sqlite";
import type { TopicSelection } from "./reconcile-topic.ts";
import { object } from "../delivery/monitor-summary.ts";

export interface AnswerSelection { readonly source: string; readonly reply: string }
const table = (db: Database, name: string) => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
const topicKey = (topic: TopicSelection) => `${topic.channel}:${topic.user}:${topic.anchor}`;

/** Only an existing final-disposition send receipt can authorize local fulfillment repair. */
export function finalReceipt(sends: Database, topics: Database, selected: TopicSelection, allowed: readonly TopicSelection[],
  answer: AnswerSelection): string | undefined {
  if (!table(sends, "reply_settlements") || !table(sends, "reply_sends")) return undefined;
  const rows = sends.query<{ key: string; topics: string; meaning: string; delivered: number; required_sends: string; outcomes: string | null }, [string]>(
    "SELECT * FROM reply_settlements WHERE key LIKE ? ORDER BY key LIMIT 25")
    .all(`${selected.channel}:${answer.source}:%`);
  for (const row of rows) {
    if (row.outcomes !== null || object(JSON.parse(row.meaning)).disposition !== "final") continue;
    const refs: unknown = JSON.parse(row.topics), required: unknown = JSON.parse(row.required_sends);
    if (!Array.isArray(refs) || !refs.length || !Array.isArray(required) || !required.length) continue;
    let includesSelected = false;
    const covered = refs.every(value => {
      const ref = object(value);
      if (typeof ref.channel_id !== "string" || typeof ref.user_id !== "string" || typeof ref.anchor_message_id !== "string") return false;
      const key = `${ref.channel_id}:${ref.user_id}:${ref.anchor_message_id}`;
      if (!allowed.some(topic => topicKey(topic) === key)) return false;
      if (key === topicKey(selected)) includesSelected = true;
      const current = topics.query<{ opened_at: number; revision: number; status: string }, [string, string, string]>(
        "SELECT opened_at,revision,status FROM conversations WHERE channel_id=? AND user_id=? AND anchor_message_id=? ORDER BY opened_at DESC LIMIT 1")
        .get(ref.channel_id, ref.user_id, ref.anchor_message_id);
      return current?.status === "open" && current.opened_at === ref.opened_at && current.revision === ref.revision;
    });
    if (!covered || !includesSelected) continue;
    let includesReply = false;
    const delivered = required.every(value => {
      const send = object(value);
      if (typeof send.target !== "string" || typeof send.event !== "string") return false;
      const receipt = sends.query<{ reply_id: string | null }, [string, string]>(
        "SELECT reply_id FROM reply_sends WHERE target=? AND text_hash=? AND state='sent'").get(send.target, `event:${send.event}`);
      if (receipt?.reply_id === answer.reply) includesReply = true;
      return receipt?.reply_id != null;
    });
    if (delivered && includesReply) return row.key;
  }
  return undefined;
}

export function finalAlreadyApplied(topics: Database, selected: TopicSelection, key: string): boolean {
  return topics.query<{ last_reply_key: string | null }, [string, string, string]>(
    "SELECT last_reply_key FROM conversations WHERE channel_id=? AND user_id=? AND anchor_message_id=? ORDER BY opened_at DESC LIMIT 1")
    .get(selected.channel, selected.user, selected.anchor)?.last_reply_key === key;
}
