import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Prompt } from "./store.ts";
import { subjects } from "./text.ts";

type Probes = {
  readonly prState: (pr: string) => Promise<string | undefined>;
  readonly opened: (repo: string, issue: number, revision: string) => Promise<boolean>;
  readonly running: () => Promise<string | undefined>;
  readonly trainTip: (id: string) => string | undefined;
};

async function command(argv: readonly string[]): Promise<string | undefined> {
  const child = Bun.spawn([...argv], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const output = (await new Response(child.stdout).text()).trim();
    return await child.exited === 0 ? output : undefined;
  } finally { clearTimeout(timer); }
}

function trainTip(id: string): string | undefined {
  const state = process.env.DORI_STATE_DIR;
  if (!state || !existsSync(join(state, "merge-trains.sqlite"))) return undefined;
  using db = new Database(join(state, "merge-trains.sqlite"), { readonly: true });
  const row = db.query<{ data: string }, [string]>("SELECT data FROM trains WHERE id=?").get(id);
  if (!row) return undefined;
  const data: unknown = JSON.parse(row.data);
  return data !== null && typeof data === "object" && "tip" in data && typeof data.tip === "string" ? data.tip : undefined;
}

const probes: Probes = {
  prState: async (pr) => {
    const hash = pr.lastIndexOf("#");
    return command(["gh", "pr", "view", pr.slice(hash + 1), "--repo", pr.slice(0, hash), "--json", "state", "-q", ".state"]);
  },
  opened: async (repo, issue, revision) => {
    const text = await command(["gh", "pr", "list", "--repo", repo, "--state", "all", "--limit", "100",
      "--json", "headRefOid,closingIssuesReferences"]);
    if (!text) return false;
    const rows: unknown = JSON.parse(text);
    return Array.isArray(rows) && rows.some((row: unknown) => row !== null && typeof row === "object" &&
      "headRefOid" in row && row.headRefOid === revision && "closingIssuesReferences" in row &&
      Array.isArray(row.closingIssuesReferences) && row.closingIssuesReferences.some((linked: unknown) =>
        linked !== null && typeof linked === "object" && "number" in linked && linked.number === issue));
  },
  running: async () => {
    const text = await command(["helio", "release", "inspect"]);
    if (!text) return undefined;
    const result: unknown = JSON.parse(text);
    return result !== null && typeof result === "object" && "running_revision" in result &&
      typeof result.running_revision === "string" ? result.running_revision : undefined;
  },
  trainTip,
};

export async function mergedOnGitHub(row: Prompt, state = probes.prState): Promise<boolean> {
  const about = subjects(row.kind, row.action, row.target).filter((subject) => subject.startsWith("pr:"));
  if (!about.length) return false;
  for (const subject of about) if (await state(subject.slice(3)) !== "MERGED") return false;
  return true;
}

/** Each approval is settled by evidence for its whole action, including a train's requested restart. */
export async function carriedOut(row: Prompt, checks: Probes = probes): Promise<boolean> {
  switch (row.action) {
    case "merge":
    case "train": return mergedOnGitHub(row, checks.prState);
    case "pr": {
      const hash = row.target.lastIndexOf("#");
      return checks.opened(row.target.slice(0, hash), Number(row.target.slice(hash + 1)), row.revision);
    }
    case "restart": return await checks.running() === row.revision;
    case "train-restart": {
      if (!await mergedOnGitHub(row, checks.prState)) return false;
      const tip = checks.trainTip(row.id);
      return tip !== undefined && await checks.running() === tip;
    }
    case "plan": return false;
    default: throw new Error(`unregistered confirmation action ${row.action}`);
  }
}
