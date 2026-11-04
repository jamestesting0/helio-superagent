import { existsSync } from "node:fs";

import { type DoriConfig, fill } from "./config.ts";
import { type Lane, type Registry, statusOf, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import { sendVerified, statusLookup } from "./panes.ts";
import { checkDone, type SignalIo } from "./signals.ts";
import { monitorLine } from "./monitor.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
};

const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false } }));
  if (lane.pane) {
    await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] done claim recorded for ${lane.key}: the ${deps.config.closeAfterMin}-minute close window starts when the lead acknowledges it. Stay idle; an objection arrives here as [LEAD] not done.`);
  }
  return monitorLine(`LANE_DONE_CLAIMED ${lane.key} read="dori show ${lane.key}" ack="dori claim-ack ${lane.key}" preview=${JSON.stringify(evidence.slice(0, 200))}`);
};

export const acknowledgeClaim = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  if (statusOf(lane) !== "done-claimed" || !lane.claim) return `REFUSED ${lane.key}: no pending claim`;
  const acknowledgedAt = lane.claim.acknowledgedAt ?? iso(deps.clock);
  await deps.registry.write({ ...lane, claim: { ...lane.claim, acknowledgedAt } });
  return `LANE_CLAIM_ACK ${lane.key} closesAfter=${new Date(Date.parse(acknowledgedAt) + windowMs(deps)).toISOString()}`;
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  if (lane.pane) await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  for (const wt of await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])) {
    if (!exists(wt)) { reasons.push(`worktree missing: ${wt}; inspect before closing`); continue; }
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=all"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};

/**
 * A launch that failed never did its work, so its Done signals can never read back live. It may be retired without
 * them, but only once no agent can still be running in its pane: the failure is detected from screen text, and an agent
 * that printed such text and recovered must not be closed. The worktree is kept and the work thread is not told "done".
 */
const retireFailedLaunch = async (deps: FlowDeps, lane: Lane, note: string): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const cleanup: string[] = [];
  if (lane.pane) {
    const { status, error } = await statusLookup(deps.run, lane.pane);
    if (error) return { closed: false, lines: [`REFUSED ${lane.key}: cannot confirm pane ${lane.pane} is no longer running an agent: ${error.slice(0, 160)}`] };
    if (status === "working" || status === "idle") {
      return { closed: false, lines: [`REFUSED ${lane.key}: an agent is still ${status} in pane ${lane.pane}; check its screen, and if the launch really failed close the tab first (herdr tab close ${lane.tab ?? "<tab>"})`] };
    }
    if (status !== undefined && lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  }
  const exists = deps.exists ?? existsSync;
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) cleanup.push(`worktree ${wt} retained for manual review`);
  const at = iso(deps.clock);
  const receipt = { checks: [], note, cleanup, retired: `launch failed (${lane.launchError ?? "no detail"}); no Done signals checked` };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [`CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

export const closeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const unsafe = await unpushedWork(deps, lane);
  if (unsafe.length) return { closed: false, lines: [`REFUSED ${lane.key}: ${unsafe.join("; ")}`] };
  if (lane.launchState === "failed") return retireFailedLaunch(deps, lane, note);
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  const cleanup: string[] = [];
  const hook = deps.config.hooks.threadDone;
  if (hook && lane.thread !== "none") {
    const r = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
    cleanup.push(r.code === 0 ? "thread marked done" : `thread hook failed: ${r.err.slice(0, 160)}`);
  }
  if (lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  else if (lane.pane) cleanup.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) {
    cleanup.push(`worktree ${wt} retained for manual review`);
  }
  const at = iso(deps.clock);
  const receipt = { checks, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  return { closed: true, lines: [...lines, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return objectDone(deps, lane, blocked);
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return objectDone(deps, lane, failing);
  const verified = withStatus(lane, "verified-done", "Done signals read back live", iso(deps.clock));
  await deps.registry.write(verified);
  const result = await closeLane(deps, verified, `Done: ${evidence}`);
  if (!result.closed) return objectDone(deps, (await deps.registry.read(lane.key)) ?? verified, result.lines.filter((l) => l.startsWith("SIGNAL NOT")));
  return `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`;
};

export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  const pending: Lane[] = [];
  const errorLine = (key: string, error: unknown) => out.push(monitorLine(`LANE_WATCH_ERROR ${key} ${error instanceof Error ? error.message : String(error)}`));
  for (const listed of await deps.registry.list(errorLine)) {
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    const claim = listed.claim;
    if (!claim.acknowledgedAt) {
      pending.push(listed);
      continue;
    }
    if (deps.clock.now() - Date.parse(claim.acknowledgedAt) < windowMs(deps)) continue;
    try {
      const result = await settle(deps, listed, claim.evidence);
      out.push(monitorLine(`${result.split(" ").slice(0, 2).join(" ")} read="dori show ${listed.key}"`));
    } catch (error) {
      // Each lane is a separate delivery boundary; a broken lane must not erase other receipts.
      errorLine(listed.key, error);
    }
  }
  const oldest = pending.sort((a, b) => (a.claim?.at ?? "").localeCompare(b.claim?.at ?? ""))[0];
  if (oldest) {
    out.push(`LANE_CLAIMS_PENDING count=${pending.length} oldest=${oldest.key} read="dori show ${oldest.key}" ack="dori claim-ack ${oldest.key}"`);
  }
  return out;
};
