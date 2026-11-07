import type { Clock, Runner } from "./run.ts";
import { paneExecution, type SessionExecution } from "./session-state.ts";

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly execution?: SessionExecution;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  const panes = (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
  return Promise.all(panes.map(async pane => {
    if (!pane.agent) return pane;
    const execution = await paneExecution(run, pane.pane_id);
    return execution ? { ...pane, agent_status: execution.status, execution } : pane;
  }));
};

export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

/** States herdr reports for a pane whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> =>
  (await listPanes(run)).find((p) => p.pane_id === pane)?.agent_status;

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (run: Runner, pane: string): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    const current = (await listPanes(run)).find(item => item.pane_id === pane);
    return current?.execution?.status === "unknown" ? { error: current.execution.reason ?? "Session execution is unknown" } :
      { status: current?.agent_status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "busybox",
]);
const baseName = (value: string): string => (value.replace(/^-/, "").split("/").at(-1) ?? "").toLowerCase();

/** Herdr can call a suspended agent idle while its foreground process is an interactive shell. */
const shellInFront = async (run: Runner, pane: string): Promise<boolean> => {
  const reply = await run(["herdr", "pane", "process-info", "--pane", pane]);
  if (reply.code !== 0) return true;
  let data: unknown;
  try {
    data = JSON.parse(reply.out);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return true;
  }
  if (typeof data !== "object" || data === null || !("result" in data)) return true;
  const result = data.result;
  if (typeof result !== "object" || result === null || !("process_info" in result)) return true;
  const info = result.process_info;
  if (typeof info !== "object" || info === null || !("foreground_processes" in info)) return true;
  const processes = info.foreground_processes;
  if (!Array.isArray(processes) || processes.length === 0) return true;
  for (const process of processes) {
    if (typeof process !== "object" || process === null || !("name" in process) || typeof process.name !== "string" ||
        !("argv" in process) || !Array.isArray(process.argv) || !process.argv.every((arg: unknown) => typeof arg === "string")) return true;
    let name = baseName(process.name);
    let args: string[] = process.argv.slice(1);
    if (name === "busybox") {
      if (!args[0]) return true;
      name = baseName(args[0]);
      args = args.slice(1);
    }
    if (!SHELLS.has(name)) continue;
    const powershell = name === "pwsh" || name === "powershell";
    const command = args.some((arg) => powershell ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg) : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const keepsPrompt = powershell && args.some((arg) => /^--?noe(x(i(t)?)?)?$/i.test(arg));
    if (!command || keepsPrompt) return true;
  }
  return false;
};

/**
 * Types the text and presses Enter exactly once. Delivery is confirmed only by a state change: the pane's agent_status
 * moving to "working" from something else. A pane that was already working cannot show that change, so its send comes
 * back "unconfirmed" and the caller decides. The screen is never read here, and Enter is never pressed again.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const before = await statusLookup(run, pane);
  if (before.error) console.error(`sendVerified ${pane}: status lookup failed before send: ${before.error}`);
  if (before.status === undefined || !ALIVE_STATUSES.has(before.status)) return "failed";
  if (await shellInFront(run, pane)) return "failed";
  if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return "failed";
  await run(["herdr", "pane", "send-keys", pane, "enter"]);
  if (before.status === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    const after = await statusLookup(run, pane);
    if (after.error) console.error(`sendVerified ${pane}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};
