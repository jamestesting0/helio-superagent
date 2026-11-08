import { readFile, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./run.ts";

export type SessionExecution =
  | { readonly status: "unknown" | "missing"; readonly reason: string }
  | { readonly status: "working" | "idle" | "blocked"; readonly session: string; readonly id: string;
      readonly pid: number; readonly since: string; readonly state: string; readonly version: string; readonly reason: string;
      readonly stopReady: boolean };

class StateUnavailable extends Error {}
const lifecycleStates = new Set(["running", "waiting_children", "waiting_background", "waiting_human",
  "paused", "held", "done", "failed", "cancelled"]);
const row = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StateUnavailable("Invalid control response");
  return Object.fromEntries(Object.entries(value));
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new StateUnavailable("Invalid pending-work count");
  return value;
};

async function controlState(path: string): Promise<unknown> {
  const secret = await readFile(`${path}.secret`);
  if (secret.length !== 32) throw new StateUnavailable("Invalid control credential");
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = "";
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(1500, () => fail(new StateUnavailable("Session control did not answer")));
    socket.once("error", fail);
    socket.once("connect", () => socket.write(Buffer.concat([secret,
      Buffer.from(JSON.stringify({ id: "dori-state", type: "get_state" }) + "\n")])));
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.length > 1_000_000) { fail(new StateUnavailable("Session control response exceeds its bound")); return; }
      const end = input.indexOf("\n");
      if (end < 0) return;
      try {
        const response = row(JSON.parse(input.slice(0, end)));
        if (response.id !== "dori-state" || response.success !== true) throw new StateUnavailable("Session control refused observation");
        socket.destroy();
        resolve(response.data);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        fail(error);
      }
    });
    socket.once("end", () => fail(new StateUnavailable("Session control ended before its response")));
  });
}

/** A TUI label describes its process; authenticated engine state describes its actual work. */
export async function paneExecution(run: Runner, pane: string): Promise<SessionExecution | undefined> {
  const reply = await run(["herdr", "pane", "process-info", "--pane", pane]);
  if (reply.code !== 0) return { status: "unknown", reason: "Cannot inspect the pane process" };
  try {
    const processes = row(row(JSON.parse(reply.out)).result).process_info;
    const foreground = row(processes).foreground_processes;
    if (!Array.isArray(foreground)) throw new StateUnavailable("Missing foreground process identity");
    const agents = foreground.map(row).filter(process => Array.isArray(process.argv) &&
      process.argv.some((arg: unknown) => typeof arg === "string" && /(?:^|\/)senpi\/dist\/bundle\/cli\.js$/.test(arg)));
    if (!agents.length) return undefined;
    if (agents.length !== 1) throw new StateUnavailable("Ambiguous foreground session");
    const agent = agents[0];
    if (!agent || typeof agent.pid !== "number" || !Array.isArray(agent.argv)) throw new StateUnavailable("Invalid foreground identity");
    const argv = agent.argv;
    const index = argv.findIndex(arg => arg === "--session" || arg === "--session-id");
    const expected: unknown = index < 0 ? undefined : argv[index + 1];
    const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".omo/agent");
    const root = join(agentDirectory, "rpc-host-daemon");
    const states = await Promise.all((await readdir(root)).filter(name => /^[0-9a-f]{16}$/.test(name)).map(async name => {
      let owned = false;
      try {
        const directory = join(root, name);
        const endpoint = row(JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")));
        if (endpoint.endpoint_kind !== "tui" || typeof endpoint.socket !== "string") return undefined;
        const pointer = row(JSON.parse(await readFile(join(directory, "host.pid"), "utf8")));
        if (typeof pointer.instance_id !== "string" || !/^[0-9a-f-]{36}$/.test(pointer.instance_id)) return undefined;
        const owner = row(JSON.parse(await readFile(join(directory, "generations", pointer.instance_id, "host.pid"), "utf8")));
        if (owner.pid !== agent.pid) return undefined;
        owned = true;
        const state = row(await controlState(endpoint.socket));
        if (typeof state.sessionId !== "string" || typeof state.sessionFile !== "string" ||
            (expected !== undefined && expected !== state.sessionId && expected !== state.sessionFile)) return undefined;
        return state;
      } catch (error) {
        if (owned) throw error;
        if (error instanceof SyntaxError || error instanceof StateUnavailable ||
            (error instanceof Error && "code" in error)) return undefined;
        throw error;
      }
    }));
    const matches = states.filter(state => state !== undefined);
    const current = matches[0];
    if (matches.length !== 1 || !current) throw new StateUnavailable("No unique control endpoint matches this pane and session");
    const lifecycle = row(current.lifecycle);
    if (typeof current.isStreaming !== "boolean" || typeof current.isCompacting !== "boolean" ||
        typeof lifecycle.state !== "string" || !lifecycleStates.has(lifecycle.state) ||
        typeof lifecycle.since !== "string") throw new StateUnavailable("Incomplete execution observation");
    const waiting = row(lifecycle.waitingOn ?? {});
    const human = Array.isArray(waiting.human) ? waiting.human.map(row) : [];
    const background = Array.isArray(waiting.background) ? waiting.background.map(row) : [];
    const active = current.isStreaming || current.isCompacting || lifecycle.state === "running";
    const reasons: string[] = [];
    if (lifecycle.state === "paused" || lifecycle.state === "held" ||
        (Array.isArray(lifecycle.holds) && lifecycle.holds.length > 0)) reasons.push("Session has an execution hold");
    if (lifecycle.restoring === true) reasons.push("Session is restoring");
    if (lifecycle.persisted !== true) reasons.push("Lifecycle checkpoint is not durable");
    const queued = count(current.pendingMessageCount), children = count(waiting.children ?? 0);
    if (queued) reasons.push(`Queued inputs: ${queued}`);
    if (children) reasons.push(`Child jobs still pending: ${children}`);
    for (const wait of human) {
      if (wait.kind === "goal_paused") reasons.push("Goal is paused");
      else if (!["goal_blocked", "stalled", "interrupted_run"].includes(String(wait.kind))) reasons.push(`Human answer pending: ${String(wait.kind)}`);
    }
    for (const wait of background) {
      const pending = count(wait.activeCount);
      if (pending && wait.source !== "terminal-monitors" &&
          !(typeof wait.source === "string" && wait.source.startsWith("delivery:goal-continuation:"))) {
        reasons.push(`Background work still pending: ${String(wait.source)}`);
      }
    }
    return { status: active ? "working" : reasons.length ? "blocked" : "idle",
      session: String(current.sessionFile), id: String(current.sessionId), pid: agent.pid, since: lifecycle.since, state: lifecycle.state,
      version: `${agent.pid}:${count(lifecycle.seq)}`,
      stopReady: !active && reasons.every(reason => reason === "Goal is paused"),
      reason: active ? "Active engine turn" : reasons[0] ?? (human.length ? `Idle; ${String(human[0]?.kind)}` :
        background.length ? "Passive monitors only" : "No active engine turn") };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof StateUnavailable ||
        (error instanceof Error && "code" in error)) return { status: "unknown", reason: error.message };
    throw error;
  }
}
