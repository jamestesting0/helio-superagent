import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPanes } from "../src/panes.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Runner } from "../src/run.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, newWorld } from "./fakes.ts";

test.each([
  { label: "passive monitors", state: "waiting_background", streaming: false, expected: "idle" },
  { label: "paused goal", state: "waiting_human", streaming: false, expected: "blocked" },
  { label: "active turn", state: "running", streaming: true, expected: "working" },
  { label: "queued input", state: "waiting_background", streaming: false, queued: 1, expected: "blocked" },
  { label: "pending child", state: "waiting_children", streaming: false, children: 1, expected: "blocked" },
  { label: "unfinished background tool", state: "waiting_background", streaming: false, background: "eval", expected: "blocked" },
  { label: "unanswered question", state: "waiting_human", streaming: false, human: "question", expected: "blocked" },
  { label: "a reused pane session", state: "waiting_background", streaming: false,
    responseSession: "22222222-2222-4222-8222-222222222222", expected: "unknown" },
  { label: "a different endpoint owner", state: "waiting_background", streaming: false, owner: 124, expected: "unknown" },
  { label: "an unknown lifecycle state", state: "unrecognized", streaming: false, expected: "unknown" },
])("a Senpi pane uses current engine activity for $label", async ({ state, streaming, expected, queued, children, background, human, responseSession, owner }) => {
  const home = mkdtempSync(join(tmpdir(), "dori-state-"));
  const previous = process.env.HOME;
  const socket = join(home, "control.sock");
  const secret = Buffer.alloc(32, 7);
  const session = "11111111-1111-4111-8111-111111111111";
  const sessionFile = join(home, `session_${session}.jsonl`);
  const directory = join(home, ".omo/agent/rpc-host-daemon",
    createHash("sha256").update(socket).digest("hex").slice(0, 16));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "endpoint.json"), JSON.stringify({ socket, endpoint_kind: "tui" }));
  writeFileSync(join(directory, "host.pid"), JSON.stringify({ instance_id: session }));
  mkdirSync(join(directory, "generations", session), { recursive: true });
  writeFileSync(join(directory, "generations", session, "host.pid"), JSON.stringify({ pid: owner ?? 123 }));
  writeFileSync(`${socket}.secret`, secret, { mode: 0o600 });
  const connections = new Set<Socket>();
  const server = createServer(connection => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    let input = Buffer.alloc(0);
    connection.on("data", chunk => {
      input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (input.length < 32 || !input.subarray(32).includes(10)) return;
      if (!input.subarray(0, 32).equals(secret)) { connection.destroy(); return; }
      const request = JSON.parse(input.subarray(32).toString());
      connection.write(JSON.stringify({ id: request.id, type: "response", command: "get_state", success: true,
        data: { sessionId: responseSession ?? session,
          sessionFile: responseSession ? join(home, `session_${responseSession}.jsonl`) : sessionFile,
          isStreaming: streaming, isCompacting: false, pendingMessageCount: queued ?? 0,
          lifecycle: { state, seq: 1, since: "2026-11-01T00:00:00Z", restoring: false, persisted: true,
            waitingOn: { children: children ?? 0, background: [{ source: background ?? "terminal-monitors", activeCount: 1 }],
              human: state === "waiting_human" ? [{ kind: human ?? "goal_paused" }] : [] } } } }) + "\n");
    });
  });
  const run: Runner = async argv => ({ code: 0, err: "", out: argv[0] === "ps" ?
    `123 122 bun /senpi/dist/bundle/cli.js --session ${sessionFile}` : JSON.stringify({ result:
    argv[2] === "list" ? { panes: [{ pane_id: "worker", workspace_id: "w", agent: "pi", agent_status: "working" }] } :
      { process_info: { shell_pid: 122, foreground_processes: [{ pid: 123, argv: ["bun", "/senpi/dist/bundle/cli.js", "--session", sessionFile] }] } } }) });
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    process.env.HOME = home;
    expect(await listPanes(run)).toMatchObject([{ agent_status: expected }]);
    if (state === "waiting_background" && expected === "idle") {
      const deps = { ...depsFor(newWorld(), fakeClock(0), home), run };
      await deps.registry.write({ key: "owned", title: "owned", pane: "worker", thread: "none",
        brief: "/b", done: "file /b", openedAt: new Date(0).toISOString(), session });
      const observed = await syncRegistry(deps, false);
      expect(observed.drift).toEqual([]);
      expect(observed.rows[0]).toMatchObject({ status: "working",
        execution: { status: "idle", id: session, session: sessionFile } });
      expect((await deps.registry.read("owned"))?.session).toBe(session);
    }
    if (state === "waiting_human" && human === undefined) {
      const deps = { ...depsFor(newWorld(), fakeClock(0), home), run };
      await deps.registry.write({ key: "paused", title: "paused", pane: "worker", thread: "none",
        brief: "/b", done: "file /b", openedAt: new Date(0).toISOString(), session,
        status: "paused", pausedSeenWorking: true, lastFreshnessNote: "working-while-paused" });
      expect(await freshnessTick(deps, home)).toEqual([]);
      expect(await freshnessTick(deps, home)).toEqual([]);
      expect(await deps.registry.read("paused")).toMatchObject({ status: "paused" });
      expect((await deps.registry.read("paused"))?.lastFreshnessNote).toBeUndefined();
    }
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
