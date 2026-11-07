import type { FlowDeps } from "./done-flow.ts";
import { listPanes } from "./panes.ts";
import { statusOf } from "./registry.ts";
import { procTable, resolveSession } from "./session-id.ts";
import type { SessionExecution } from "./session-state.ts";

export type SyncRow = { readonly key: string; readonly thread: string; readonly pane: string; readonly session: string; readonly status: string;
  readonly execution?: SessionExecution };
export type SyncResult = { readonly rows: SyncRow[]; readonly drift: string[]; readonly unregistered: SyncRow[] };

export const syncRegistry = async (deps: FlowDeps, write: boolean): Promise<SyncResult> => {
  const panes = await listPanes(deps.run);
  const live = new Map(panes.map((p) => [p.pane_id, p]));
  const table = await procTable(deps.run);
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const lanes = await deps.registry.open();
  for (const lane of lanes) {
    const pane = lane.pane ? live.get(lane.pane) : undefined;
    if (!pane && statusOf(lane) !== "hibernated") drift.push(`${lane.key}: pane ${lane.pane ?? "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const execution = pane?.execution;
    const observed = execution && "session" in execution ? execution : undefined;
    const hit = observed ? { id: observed.session, via: "control" } :
      pane ? await resolveSession(pane.pane_id, pane.cwd ?? "", table, { run: deps.run, sessionsDir: deps.config.sessionsDir }) : { id: "", via: "none" };
    const sameSession = hit.id === lane.session || (observed !== undefined && lane.session === observed.id);
    if (lane.session && hit.id && !sameSession) drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (lane.launchState && lane.launchState !== "started") drift.push(`${lane.key}: launch ${lane.launchState}${lane.launchError ? `: ${lane.launchError}` : ""}; inspect retained resources before retry`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && hit.id && !sameSession) await deps.registry.write({ ...lane, session: hit.id, sessionVia: hit.via });
    rows.push({ key: lane.key, thread: lane.thread, pane: lane.pane ?? "-", session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"),
      status: statusOf(lane), execution: pane?.execution ?? { status: pane ? "unknown" : "missing", reason: pane ?
        `Process label ${pane.agent_status ?? "unknown"}; current engine state is unavailable` : "No linked pane" } });
  }
  const owned = new Set(lanes.map((l) => l.pane));
  const watch = new Set(deps.config.workspaces);
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  const unregistered: SyncRow[] = [];
  for (const p of panes) {
    if (owned.has(p.pane_id) || skip.has(p.pane_id) || (watch.size > 0 && !watch.has(p.workspace_id))) continue;
    if (p.agent === undefined) continue;
    const hit = await resolveSession(p.pane_id, p.cwd ?? "", table, { run: deps.run, sessionsDir: deps.config.sessionsDir });
    unregistered.push({ key: p.title ?? p.pane_id, thread: "-", pane: p.pane_id, session: hit.id ? `${hit.id} (${hit.via})` : "-", status: "unregistered" });
  }
  return { rows, drift, unregistered };
};
