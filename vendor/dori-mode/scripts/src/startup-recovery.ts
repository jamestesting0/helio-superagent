import type { FlowDeps } from "./done-flow.ts";
import { LaunchError, withLaunchLock } from "./launch.ts";
import { listPanes } from "./panes.ts";
import { statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";

/** Reconcile a pre-process reservation; never close a pane or infer delivery. */
export const recoverStart = (deps: FlowDeps, key: string, revision: number): Promise<string> =>
  withLaunchLock(deps, async () => {
    const lane = await deps.registry.read(key);
    if (!lane || lane.revision !== revision) throw new LaunchError("Startup reservation changed; inspect its current revision");
    if (!lane.phase || statusOf(lane) !== "working" || lane.pane || lane.tab ||
        !["reserved", "brief-written", "worktree-created"].includes(lane.launchState ?? "")) {
      throw new LaunchError("Startup is not an unbound pre-process reservation; retained resources need inspection");
    }
    if (!Number.isSafeInteger(lane.launchOwner) || (lane.launchOwner ?? 0) <= 0) {
      throw new LaunchError("Startup reservation has no verified process owner; retained resources need inspection");
    }
    try {
      process.kill(lane.launchOwner!, 0);
      return `STARTUP_PENDING ${key} reservation owner is still alive`;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    const panes = await listPanes(deps.run);
    if (panes.some(pane => !pane.cwd || pane.cwd === lane.cwd || lane.session && pane.execution && "id" in pane.execution &&
        (pane.execution.id === lane.session || pane.execution.session === lane.session))) {
      throw new LaunchError("Startup has possible surviving resources; no retry or resource close was attempted");
    }
    const current = await deps.registry.read(key);
    if (!current || current.revision !== revision) throw new LaunchError("Startup changed during resource inspection");
    await deps.registry.write(withStatus(current, "hibernated", "dead startup owner; no surviving resources; delivery remains unacknowledged",
      iso(deps.clock), { launchState: undefined, launchOwner: undefined }));
    return `STARTUP_RECOVERED ${key} same session and phase retained`;
  });
