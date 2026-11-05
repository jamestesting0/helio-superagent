import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { capacityReasons, dequeue, ordered, readQueue } from "./admission.ts";
import type { FlowDeps } from "./done-flow.ts";
import { launchLane, LaunchBusyError, LaunchError, recordSession, wakeLane, withLaunchLock } from "./launch.ts";
import { monitorLine } from "./monitor.ts";
import { listPanes, type Pane } from "./panes.ts";
import { type Lane, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";

const QUESTIONS_SETTLED = "('done','cancelled','expired','withdrawn')";

/** A lane waiting on a human answer must stay awake to receive it. Unreadable question state counts as waiting. */
export const waitingOnQuestion = (deps: FlowDeps, key: string): boolean => {
  const path = join(deps.config.stateDir, "discord-questions.sqlite");
  if (!existsSync(path)) return false;
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db.query(`SELECT 1 FROM questions WHERE lane = ? AND status NOT IN ${QUESTIONS_SETTLED} LIMIT 1`).get(key) !== null;
    } finally { db.close(); }
  } catch {
    return true;
  }
};

const closeTab = async (deps: FlowDeps, lane: Lane): Promise<boolean> =>
  (await deps.run(lane.tab ? ["herdr", "tab", "close", lane.tab] : ["herdr", "pane", "close", lane.pane ?? ""])).code === 0;

export const hibernateTick = async (deps: FlowDeps, panes: readonly Pane[]): Promise<string[]> => {
  if (deps.config.hibernateAfterMin <= 0) return [];
  const out: string[] = [];
  const now = deps.clock.now();
  for (let lane of await deps.registry.list()) {
    if (statusOf(lane) !== "working" || !lane.pane) continue;
    const pane = panes.find((p) => p.pane_id === lane.pane);
    if (!pane) continue;
    if (pane.agent_status !== "idle") {
      if (lane.idleSince !== undefined) await deps.registry.write({ ...lane, idleSince: undefined });
      continue;
    }
    if (lane.idleSince === undefined) {
      await deps.registry.write({ ...lane, idleSince: now });
      continue;
    }
    if (now - lane.idleSince < deps.config.hibernateAfterMin * 60_000) continue;
    lane = await recordSession(deps, lane);
    if (!lane.session || waitingOnQuestion(deps, lane.key)) continue;
    if (!(await closeTab(deps, lane))) {
      out.push(monitorLine(`LANE_HIBERNATE_FAILED ${lane.key} could not close ${lane.tab ?? lane.pane}`));
      continue;
    }
    await deps.registry.write(withStatus(lane, "hibernated", `idle ${deps.config.hibernateAfterMin}+ minutes; session kept`, iso(deps.clock), { pane: undefined, tab: undefined, idleSince: undefined }));
    out.push(monitorLine(`LANE_HIBERNATED ${lane.key} session kept; wake="dori resume ${lane.key}"`));
  }
  return out;
};

/** Finishes closes whose tab did not go away; a pane that no longer exists counts as closed. */
export const retryCleanup = async (deps: FlowDeps, panes: readonly Pane[]): Promise<string[]> => {
  const out: string[] = [];
  for (const lane of await deps.registry.list()) {
    if (statusOf(lane) !== "cleanup-pending") continue;
    const gone = !lane.pane || !panes.some((p) => p.pane_id === lane.pane) || await closeTab(deps, lane);
    if (!gone) continue;
    const at = iso(deps.clock);
    await deps.registry.write(withStatus(lane, "closed", "terminal cleanup finished", at, { closedAt: at, pane: undefined, tab: undefined }));
    out.push(monitorLine(`LANE_CLOSED ${lane.key} terminal cleanup finished read="dori show ${lane.key}"`));
  }
  return out;
};

export const drainQueue = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of ordered(await readQueue(deps))) {
    if ((await capacityReasons(deps)).length) break;
    try {
      let startup: string;
      if (entry.wake) {
        const lane = await deps.registry.read(entry.key);
        if (!lane || !["hibernated", "closed"].includes(statusOf(lane))) { await withLaunchLock(deps, () => dequeue(deps, entry.key)); continue; }
        startup = (await wakeLane(deps, lane, { ...(entry.briefText ? { briefText: entry.briefText } : {}), priority: entry.priority, note: "woken from the launch queue",
          attempt: { title: entry.title, done: entry.done, ...(entry.thread ? { thread: entry.thread } : {}), ...(entry.model ? { model: entry.model } : {}) } })).startup;
      } else {
        startup = (await launchLane(deps, { ...entry, brief: "" }, entry.briefText)).startup;
      }
      if (startup.startsWith("LAUNCH_QUEUED")) break;
      out.push(monitorLine(`LANE_DEQUEUED ${entry.key} ${startup}`));
    } catch (error) {
      if (error instanceof LaunchBusyError) break;
      if (!(error instanceof LaunchError)) throw error;
      try { await withLaunchLock(deps, () => dequeue(deps, entry.key)); } catch (busy) { if (busy instanceof LaunchBusyError) break; throw busy; }
      out.push(monitorLine(`LANE_DEQUEUE_FAILED ${entry.key} ${error.message}`));
    }
  }
  return out;
};

export const lifecycleTick = async (deps: FlowDeps): Promise<string[]> => {
  let panes: Pane[] | undefined;
  try { panes = await listPanes(deps.run); } catch (error) {
    return [monitorLine(`LANE_LIFECYCLE_HOLD pane list unavailable: ${error instanceof Error ? error.message : String(error)}`)];
  }
  return [...await retryCleanup(deps, panes), ...await hibernateTick(deps, panes), ...await drainQueue(deps)];
};
