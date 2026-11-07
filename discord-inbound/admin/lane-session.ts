import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AdminError, object, text } from "./protocol.ts";

export async function laneObservation(pane: string): Promise<{ readonly status: string; readonly reason?: string }> {
  const run = async (argv: readonly string[]) => {
    const child = Bun.spawn([...argv], { env: { ...process.env, HERDR_SESSION: "elobot" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000 });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  const reply = await run(["herdr", "pane", "list"]);
  if (reply.code !== 0) throw new AdminError("unavailable", "The lane session state is unavailable");
  const panes = object(object(JSON.parse(reply.out)).result).panes;
  if (!Array.isArray(panes)) throw new AdminError("unavailable", "The lane session registry is unreadable");
  const current = panes.map(object).find(value => value.pane_id === pane);
  if (!current) return { status: "missing", reason: "No linked process" };
  const path = join(process.env.HOME ?? homedir(), ".dori/elobot/vendor/dori-mode/scripts/src/session-state.ts");
  const module = object(await import(pathToFileURL(path).href));
  if (typeof module.paneExecution !== "function") throw new AdminError("unavailable", "The session observer is unavailable");
  const observed: unknown = await module.paneExecution(run, pane);
  if (observed !== undefined) {
    const execution = object(observed);
    if (execution.status === "unknown") throw new AdminError("unavailable", "Current session execution could not be verified");
    return { status: text(execution.status, 100),
      ...(typeof execution.reason === "string" ? { reason: text(execution.reason, 2000) } : {}) };
  }
  return { status: text(current.agent_status, 100), reason: "Herdr process observation" };
}

export async function laneSession(pane: string): Promise<string> {
  return (await laneObservation(pane)).status;
}
