import { Database } from "bun:sqlite";

interface Followup {
  readonly repo: string; readonly issue: number; readonly user_id: string;
  readonly reply_to: string; readonly status: string; readonly announcement: string | null;
  readonly observed_at?: number | null; readonly delivered_reply_id?: string | null;
}

/** A local observation is displayed with its age; rendering never refreshes GitHub. */
export function followupStatus(path: string, channel: string, user: string, now: number) {
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='followups'").get()) return [];
    return db.query<Followup, [string, string]>(
      "SELECT * FROM followups WHERE channel_id=? AND user_id=? ORDER BY created_at DESC LIMIT 25").all(channel, user)
      .map(row => {
        const observation = row.announcement ? JSON.parse(row.announcement) as { event?: string } : undefined;
        return {
          issue: `https://github.com/${row.repo}/issues/${row.issue}`, subscription_state: row.status,
          source_target: row.reply_to, delivered_reply_id: row.delivered_reply_id ?? null,
          observed_event: observation?.event ?? null,
          observation_age_seconds: row.observed_at == null ? null : Math.max(0, Math.floor(now / 1000) - row.observed_at),
          read: `helio followups show ${row.issue}`,
        };
      });
  } finally { db.close(); }
}
