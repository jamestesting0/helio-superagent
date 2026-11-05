import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

const ISSUE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)/g;
// Same table as scripts/helio_issue_sync.py, which marks issues reviewed and repeats reminders.
const SCHEMA = `CREATE TABLE IF NOT EXISTS reviews (repo TEXT NOT NULL, issue INTEGER NOT NULL,
  discussed_at INTEGER NOT NULL DEFAULT 0, reviewed_at INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER NOT NULL DEFAULT 0, reason TEXT, PRIMARY KEY (repo, issue))`;

export function issueUrls(text: string): string[] {
  return [...new Set([...text.matchAll(ISSUE)].map((match) => `https://github.com/${match[1]}/issues/${match[2]}`))];
}

/** Records discussion at `at` (seconds); true while the issue description has not been reviewed since. */
export function recordDiscussion(path: string, url: string, at: number): boolean {
  const [match] = url.matchAll(ISSUE);
  if (!match) return false;
  const created = !existsSync(path);
  const db = new Database(path, { create: true });
  try {
    if (created) chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    const key = [match[1] ?? "", Number(match[2])] as const;
    db.query(`INSERT INTO reviews (repo, issue, discussed_at) VALUES (?, ?, ?)
      ON CONFLICT (repo, issue) DO UPDATE SET discussed_at = max(discussed_at, excluded.discussed_at)`).run(...key, at);
    const row = db.query<{ discussed_at: number; reviewed_at: number }, [string, number]>(
      "SELECT discussed_at, reviewed_at FROM reviews WHERE repo = ? AND issue = ?").get(...key);
    return !!row && row.discussed_at > row.reviewed_at;
  } finally {
    db.close();
  }
}
