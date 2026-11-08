import { Database } from "bun:sqlite";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "./done-flow.ts";
import { withLaunchLock } from "./launch.ts";
import { listPanes, type Pane } from "./panes.ts";
import { type Lane, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";
import { START_WINDOW_MS } from "./session-id.ts";
import type { SessionExecution } from "./session-state.ts";

async function legacyOrigin(lane: Lane, checkpoint: string, sessionId: string): Promise<boolean> {
  try {
    const lines = (await Bun.file(checkpoint).slice(0, 131_072).text()).split("\n");
    const header: unknown = JSON.parse(lines[0] ?? "");
    if (typeof header !== "object" || header === null || !("type" in header) || header.type !== "session" ||
        !("id" in header) || header.id !== sessionId || !("cwd" in header) || header.cwd !== lane.cwd ||
        !("timestamp" in header) || typeof header.timestamp !== "string") return false;
    const delta = Date.parse(header.timestamp) - Date.parse(lane.openedAt);
    if (!Number.isFinite(delta) || delta < -5000 || delta > START_WINDOW_MS) return false;
    for (const line of lines.slice(1, -1)) {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
      const message = entry.message;
      if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user" || !("content" in message)) continue;
      const content = message.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part: unknown) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
      const brief = lane.brief.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[\\s"'\\x60])${brief}(?=$|[\\s"'\\x60]|[.,;](?:$|\\s))`).test(text);
    }
    return false;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error)) return false;
    throw error;
  }
}

const questionHold = (deps: FlowDeps, key: string): string | undefined => {
  const path = join(deps.config.stateDir, "discord-questions.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    using db = new Database(path, { readonly: true });
    return db.query("SELECT 1 FROM questions WHERE lane = ? AND status NOT IN ('done','cancelled','expired','withdrawn') LIMIT 1").get(key) !== null ?
      "an unanswered question needs this worker" : undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return "question state is unreadable; inspect the questions database before releasing this slot";
  }
};

const readableCheckpoint = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))) return false;
    throw error;
  }
};

export interface ReclaimResult {
  readonly released: boolean;
  readonly lines: readonly string[];
}

const releaseReady = (pane: Pane, paused: boolean): pane is Pane & {
  readonly execution: Extract<SessionExecution, { readonly session: string }>;
} =>
  pane.agent_status === "idle" && pane.execution?.status === "idle" ||
  paused && pane.agent_status === "blocked" && pane.execution?.status === "blocked" && pane.execution.stopReady;

async function finishRelease(deps: FlowDeps, lane: Lane): Promise<ReclaimResult> {
  const release = lane.release;
  if (!release || statusOf(lane) !== "cleanup-pending") return { released: false, lines: [] };
  const hold = async (reason: string): Promise<ReclaimResult> => {
    if (release.problem === reason) return { released: false, lines: [] };
    await deps.registry.write({ ...lane, release: { ...release, problem: reason } });
    return { released: false, lines: [`LANE_RECLAIM_HELD ${lane.key} ${reason}; checkpoint kept; read="dori show ${lane.key}" retry="dori reclaim ${lane.key}"`] };
  };
  const pane = (await listPanes(deps.run)).find(item => item.pane_id === lane.pane);
  const current = await deps.registry.read(lane.key);
  if (!current || current.release?.operation !== release.operation) return { released: false,
    lines: [`LANE_RECLAIM_CANCELLED ${lane.key} release ownership changed; no terminal closed`] };
  if (current.revision !== lane.revision || current.pane !== release.pane || current.tab !== release.tab ||
      current.job !== release.job || current.source !== release.source ||
      (pane && releaseReady(pane, release.from === "paused") &&
        pane.execution.version !== release.version)) {
    await deps.registry.write(withStatus(current, statusOf(current) === "cleanup-pending" ? release.from : statusOf(current),
      "idle release cancelled after newer lane or execution state; terminal kept", iso(deps.clock),
      { release: undefined, idleSince: undefined }));
    return { released: false, lines: [`LANE_RECLAIM_CANCELLED ${lane.key} newer state takes precedence; no terminal closed`] };
  }
  if (!release.version) return hold("release has no authenticated ownership proof; inspect the original checkpoint before retry");
  if (!readableCheckpoint(release.session)) return hold("resumable checkpoint is missing or unreadable");
  if (pane) {
    if (!releaseReady(pane, release.from === "paused")) return hold(`session is ${pane.agent_status ?? "unknown"}; authenticated safe stopping is unavailable; no terminal closed`);
    if (pane.execution.session !== release.session) return hold("pane now belongs to a different session");
    const question = questionHold(deps, lane.key);
    if (question) return hold(question);
    const target = lane.tab ? ["tab", lane.tab] : ["pane", lane.pane ?? ""];
    if ((await deps.run(["herdr", target[0] ?? "", "close", target[1] ?? ""])).code !== 0) return hold("terminal close failed");
    if ((await listPanes(deps.run)).some(item => item.pane_id === lane.pane)) return hold("terminal still exists after close");
  }
  await deps.registry.write(withStatus(lane, "hibernated", "idle session checkpointed; work and files retained, completion unchanged", iso(deps.clock),
    { pane: undefined, tab: undefined, idleSince: undefined, release: undefined }));
  return { released: true, lines: [`LANE_HIBERNATED ${lane.key} session kept; ${lane.job ?
    `wake="dori resume ${lane.key}"` : "legacy job binding remains unverified; no new work was authorized"}`] };
}

/** Release a resource, never manufacture a completion or abandon unfinished work. */
export const reclaimLane = async (deps: FlowDeps, key: string, stop?: { readonly expected: number }): Promise<ReclaimResult> => withLaunchLock(deps, async () => {
  const lane = await deps.registry.read(key);
  if (!lane) return { released: false, lines: [`REFUSED ${key}: lane not found`] };
  if (stop && (lane.revision ?? 0) !== stop.expected) return { released: false, lines: [`REFUSED ${key}: lane changed before stopping; refresh its confirmation`] };
  if (lane.release) return finishRelease(deps, lane);
  if (!["working", "not-done", ...(stop ? ["paused"] : [])].includes(statusOf(lane)) || !lane.pane) {
    return { released: false, lines: [`REFUSED ${key}: ${statusOf(lane)} is not an idle reclaim candidate`] };
  }
  const paneId = lane.pane;
  const pane = (await listPanes(deps.run)).find(item => item.pane_id === paneId);
  if (!pane || !releaseReady(pane, Boolean(stop) && statusOf(lane) === "paused")) return { released: false,
    lines: [`REFUSED ${key}: current session is ${pane?.agent_status ?? "missing"}; no terminal closed`] };
  const execution = pane.execution;
  const question = questionHold(deps, key);
  if (question) return { released: false, lines: [`REFUSED ${key}: ${question}`] };
  if (lane.session && lane.session !== execution.session && lane.session !== execution.id &&
      !lane.session.endsWith(`_${execution.id}.jsonl`)) {
    return { released: false, lines: [`REFUSED ${key}: pane belongs to another session; recorded checkpoint unchanged`] };
  }
  const checkpoint = execution.session;
  if (!lane.session && !(await legacyOrigin(lane, checkpoint, execution.id))) {
    return { released: false, lines: [`REFUSED ${key}: legacy session ownership is unverified; inspect its original brief and session header`] };
  }
  if (!checkpoint || !readableCheckpoint(checkpoint)) return { released: false, lines: [`REFUSED ${key}: no readable resumable session checkpoint`] };
  const pending = withStatus(lane, "cleanup-pending", "releasing an idle worker slot; completion remains unverified", iso(deps.clock),
    { session: checkpoint, sessionVia: "control",
      release: { operation: crypto.randomUUID(), session: checkpoint,
        from: statusOf(lane) === "paused" ? "paused" : statusOf(lane) === "not-done" ? "not-done" : "working", pane: paneId,
        ...(lane.tab ? { tab: lane.tab } : {}), ...(lane.job ? { job: lane.job } : {}),
        ...(lane.source ? { source: lane.source } : {}), version: execution.version } });
  await deps.registry.write(pending);
  return finishRelease(deps, pending);
});
