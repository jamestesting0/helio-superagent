import { Database } from "bun:sqlite";

interface Followup {
  readonly repo: string; readonly issue: number; readonly anchor_message_id: string; readonly status: string;
  readonly announcement: string | null; readonly observed_at: number | null;
}
interface Group { readonly channel_id: string; readonly target: string; readonly users: string; readonly reply_id: string | null; readonly disposition: string | null }

/** A topic's issue subscriptions with their per-channel deliveries; rendering never refreshes GitHub. */
export function followupStatus(path: string, topic: string, now: number) {
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='followup_groups'").get()) return [];
    return db.query<Followup, [string]>(
      "SELECT * FROM followups WHERE anchor_message_id=? ORDER BY created_at DESC LIMIT 25").all(topic)
      .map(row => {
        const observation = row.announcement ? JSON.parse(row.announcement) as { event?: string } : undefined;
        const groups = db.query<Group, [string, number, string]>(
          "SELECT channel_id,target,users,reply_id,disposition FROM followup_groups WHERE repo=? AND issue=? AND anchor_message_id=?")
          .all(row.repo, row.issue, row.anchor_message_id);
        return {
          issue: `https://github.com/${row.repo}/issues/${row.issue}`, subscription_state: row.status,
          observed_event: observation?.event ?? null,
          observation_age_seconds: row.observed_at == null ? null : Math.max(0, Math.floor(now / 1000) - row.observed_at),
          deliveries: groups.map(group => ({ channel_id: group.channel_id, target: group.target, users: JSON.parse(group.users),
            reply_id: group.reply_id, disposition: group.disposition })),
          read: `helio followups show ${row.issue}`,
        };
      });
  } finally { db.close(); }
}
