import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AdminError, object, type RuntimeResult } from "./protocol.ts";

export function syncWarning(state: string, repo: string): string | undefined {
  const path = join(state, "issue-sync.sqlite");
  if (!existsSync(path)) return undefined;
  using db = new Database(path, { readonly: true });
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(tracked)").all().map(row => row.name);
  if (!columns.includes("last_outcome")) return "GitHub synchronization has no durable outcome history.";
  const row = db.query<{ issue: number; last_outcome: string }, [string]>(
    "SELECT issue,last_outcome FROM tracked WHERE repo=? AND last_outcome IN ('failed','partial','uncertain') ORDER BY attempted_at DESC,issue LIMIT 1").get(repo);
  return row ? `GitHub issue #${row.issue} synchronization is ${row.last_outcome}.` : undefined;
}

export async function probeGithub(home: string): Promise<RuntimeResult> {
  const child = Bun.spawn(["python3", join(home, "helio-agent/scripts/helio_github_status.py"), "--json"], {
    env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new AdminError("unavailable", error.slice(-300) || "GitHub diagnostics are unavailable");
  const data = object(JSON.parse(output));
  const fields = Object.entries(data).map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value) }));
  return { records: [{ id: "github", title: "GitHub", summary: "Read-only isolated-runtime observation",
    revision: String(Date.now()), fields }] };
}
