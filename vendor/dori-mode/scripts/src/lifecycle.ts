import { capacityReasons, dequeue, occupiesSlot, ordered, readQueue } from "./admission.ts";
import type { FlowDeps } from "./done-flow.ts";
import { launchLane, LaunchBusyError, LaunchError, wakeLane, withLaunchLock } from "./launch.ts";
import { monitorLine } from "./monitor.ts";
import { listPanes, type Pane } from "./panes.ts";
import { type Lane, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";
import { reclaimLane } from "./reclaim.ts";

const closeTab = async (deps: FlowDeps, lane: Lane): Promise<boolean> =>
  (await deps.run(lane.tab ? ["herdr", "tab", "close", lane.tab] : ["herdr", "pane", "close", lane.pane ?? ""])).code === 0;

export const hibernateTick = async (deps: FlowDeps, panes: readonly Pane[]): Promise<string[]> => {
  const out: string[] = [];
  const now = deps.clock.now();
  const lanes = await deps.registry.list();
  const live = new Set(panes.map(pane => pane.pane_id));
  let demand = Math.max(0, lanes.filter(lane => occupiesSlot(lane, live)).length +
    (await readQueue(deps)).length - deps.config.maxWorkers);
  for (const lane of lanes.sort((a, b) => (a.idleSince ?? Date.parse(a.openedAt)) - (b.idleSince ?? Date.parse(b.openedAt)))) {
    if (!["working", "not-done"].includes(statusOf(lane)) || !lane.pane) continue;
    const pane = panes.find((p) => p.pane_id === lane.pane);
    if (!pane) continue;
    if (pane.agent_status !== "idle" || pane.execution?.status !== "idle") {
      if (lane.idleSince !== undefined) await deps.registry.write({ ...lane, idleSince: undefined });
      continue;
    }
    if (lane.idleSince === undefined) {
      const observed = Date.parse(pane.execution?.status === "idle" ? pane.execution.since : "");
      await deps.registry.write({ ...lane, idleSince: Number.isFinite(observed) && observed <= now ? observed : now });
      if (demand <= 0) continue;
    }
    if (demand <= 0 && (deps.config.hibernateAfterMin <= 0 ||
      now - (lane.idleSince ?? now) < deps.config.hibernateAfterMin * 60_000)) continue;
    const result = await reclaimLane(deps, lane.key);
    out.push(...result.lines.map(monitorLine));
    if (result.released) demand--;
  }
  return out;
};

/** Finishes closes whose tab did not go away; a pane that no longer exists counts as closed. */
export const retryCleanup = async (deps: FlowDeps, panes: readonly Pane[]): Promise<string[]> => {
  const out: string[] = [];
  for (const lane of await deps.registry.list()) {
    if (statusOf(lane) !== "cleanup-pending") continue;
    if (lane.release) {
      out.push(...(await reclaimLane(deps, lane.key)).lines.map(monitorLine));
      continue;
    }
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
    if (!entry.job && !entry.wake) {
      out.push(monitorLine(`LANE_DEQUEUE_HELD ${entry.key}: legacy queue entry needs verified job binding`));
      continue;
    }
    if ((await capacityReasons(deps)).length) break;
    try {
      let startup: string;
      if (entry.wake) {
        const lane = await deps.registry.read(entry.key);
        if (!lane || !["hibernated", "closed"].includes(statusOf(lane))) { await withLaunchLock(deps, () => dequeue(deps, entry.key)); continue; }
        startup = (await wakeLane(deps, lane, { ...(entry.briefText ? { briefText: entry.briefText } : {}), priority: entry.priority, note: "woken from the launch queue",
          ...(entry.phase ? { phase: entry.phase } : {}),
          attempt: { title: entry.title, done: entry.done, ...(entry.thread ? { thread: entry.thread } : {}), ...(entry.model ? { model: entry.model } : {}),
            ...(entry.phase ? { phase: entry.phase } : {}) } })).startup;
      } else {
        startup = (await launchLane(deps, { ...entry, job: entry.job!, brief: "" }, entry.briefText)).startup;
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
