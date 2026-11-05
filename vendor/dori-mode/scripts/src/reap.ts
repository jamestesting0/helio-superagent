import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { type FlowDeps, unpushedWork } from "./done-flow.ts";
import { jobOf, LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WORKTREE_GRACE_MS = 3 * DAY_MS;
const STALE_STATUSES = new Set(["paused", "not-done", "cleanup-pending"]);

export type StaleLane = { readonly key: string; readonly job: string; readonly status: string; readonly age_hours: number; readonly has_unpushed: boolean };

const lastChange = (lane: Lane): number => Date.parse(lane.history?.at(-1)?.at ?? lane.openedAt);

export const staleLanes = async (deps: FlowDeps, hours: number): Promise<StaleLane[]> => {
  const out: StaleLane[] = [];
  for (const lane of await deps.registry.list()) {
    const status = statusOf(lane);
    if (!STALE_STATUSES.has(status) && lane.launchState !== "failed") continue;
    const age = (deps.clock.now() - lastChange(lane)) / 3_600_000;
    if (age < hours) continue;
    out.push({ key: lane.key, job: jobOf(lane), status: lane.launchState === "failed" ? "launch-failed" : status, age_hours: Math.floor(age), has_unpushed: (await unpushedWork(deps, lane)).length > 0 });
  }
  return out;
};

export type ReapRow = { readonly key: string; readonly path: string; readonly action: "removed" | "kept" | "would_remove"; readonly reason: string };

/** When the lane's PR (its `merged owner/repo#N` Done signal) was merged or closed; anything unknown keeps the worktree. */
const prSettledAt = async (deps: FlowDeps, lane: Lane): Promise<{ readonly at?: number; readonly reason: string }> => {
  const signal = /\bmerged\s+([\w.-]+\/[\w.-]+)#(\d+)/.exec(lane.done);
  if (!signal?.[1] || !signal[2]) return { reason: "PR state unknown: the Done line names no merged PR" };
  const view = await deps.run(["gh", "pr", "view", signal[2], "--repo", signal[1], "--json", "state,mergedAt,closedAt"]);
  if (view.code !== 0) return { reason: `PR state unknown: ${(view.err || view.out).slice(0, 160)}` };
  const pr = JSON.parse(view.out) as { state?: string; mergedAt?: string | null; closedAt?: string | null };
  if (pr.state !== "MERGED" && pr.state !== "CLOSED") return { reason: `PR ${signal[1]}#${signal[2]} is ${pr.state ?? "unknown"}` };
  const at = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
  return Number.isFinite(at) ? { at, reason: `PR ${signal[1]}#${signal[2]} ${pr.state.toLowerCase()}` } : { reason: "PR settle time unknown" };
};

export const reapWorktrees = async (deps: FlowDeps, apply: boolean): Promise<ReapRow[]> => {
  const root = join(deps.config.stateDir, "worktrees");
  if (!existsSync(root)) return [];
  const rows: ReapRow[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const key = entry.name, path = join(root, key);
    const keep = (reason: string) => rows.push({ key, path, action: "kept", reason });
    const lane = LANE_KEY.test(key) ? await deps.registry.read(key) : null;
    if (!lane) { keep("no lane record"); continue; }
    if (statusOf(lane) !== "closed") { keep(`lane is ${statusOf(lane)}`); continue; }
    const pr = await prSettledAt(deps, lane);
    if (pr.at === undefined) { keep(pr.reason); continue; }
    const days = (deps.clock.now() - pr.at) / DAY_MS;
    if (deps.clock.now() - pr.at < WORKTREE_GRACE_MS) { keep(`${pr.reason} ${days.toFixed(1)} days ago; kept for 3 days`); continue; }
    const unsafe = await unpushedWork(deps, { ...lane, worktrees: [path], cwd: path });
    if (unsafe.length) { keep(unsafe.join("; ")); continue; }
    const reason = `${pr.reason} ${Math.floor(days)} days ago; no uncommitted or unpushed work`;
    if (!apply) { rows.push({ key, path, action: "would_remove", reason }); continue; }
    const head = (await deps.run(["git", "-C", path, "rev-parse", "HEAD"])).out.trim();
    const common = await deps.run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const main = common.code === 0 && common.out.trim() ? dirname(common.out.trim()) : deps.config.defaultCwd;
    const removed = await deps.run(["git", "-C", main, "worktree", "remove", path]);
    if (removed.code !== 0) { keep(`git worktree remove failed: ${(removed.err || removed.out).slice(0, 160)}`); continue; }
    await deps.run(["git", "-C", main, "worktree", "prune"]);
    await deps.registry.write({ ...lane, worktreeRemoved: { at: iso(deps.clock), path, branch: `helio/${key}`, head } });
    rows.push({ key, path, action: "removed", reason });
  }
  return rows;
};
