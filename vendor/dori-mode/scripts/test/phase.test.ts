import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { acknowledgeClaim, claimDone, closeLane, objectDone, watchTick, type FlowDeps } from "../src/done-flow.ts";
import { completionPath, recordCompletion } from "../src/completion.ts";
import { launchLane, wakeLane } from "../src/launch.ts";
import { drainQueue } from "../src/lifecycle.ts";
import { readQueue } from "../src/admission.ts";
import { parsePhase, PhaseError } from "../src/phase.ts";
import { recoverStart } from "../src/startup-recovery.ts";
import { Registry, type Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { fakeClock, HEALTHY, withState } from "./fakes.ts";

const G1 = { owner: "helio-pr", version: 1, generation: 1 } as const;
const G2 = { owner: "helio-pr", version: 1, generation: 2 } as const;
const T0 = Date.parse("2026-11-11T12:00:00Z");
let state: ReturnType<typeof withState>;
let deps: FlowDeps;
let hold: boolean;
let busy: boolean;
let activeAgents: Set<string>;
let authorizeMutation: (() => Promise<void>) | undefined;

beforeEach(() => {
  state = withState();
  hold = false;
  busy = false;
  activeAgents = new Set();
  authorizeMutation = undefined;
  const registry = new Registry(state.dir);
  const run: Runner = async argv => {
    const ok = (out = "") => ({ code: 0, out, err: "" });
    if (argv[0] === "authority") {
      if (authorizeMutation) await authorizeMutation();
      return hold ? { code: 2, out: "requester hold", err: "" } : ok();
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") return ok(JSON.stringify({ result: { panes: [] } }));
    if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return ok(
      JSON.stringify({ result: { root_pane: { pane_id: "w:p2" }, tab_id: "w:t2" } }));
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
      activeAgents.add(argv[3] ?? "");
      return ok();
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "agent-status") return ok(JSON.stringify({ result: { status: "idle" } }));
    if (argv[0] === "gh" && argv[1] === "pr") return ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "a".repeat(40) } }));
    if (argv[0] === "git" && argv.includes("worktree")) return ok("");
    if (argv[0] === "git" && argv.includes("rev-list")) return ok("0");
    if (argv[0] === "git" && argv.includes("rev-parse")) return ok(argv.includes("--is-inside-work-tree") ? "true" : "a".repeat(40));
    return ok();
  };
  deps = {
    registry, run, clock: fakeClock(T0), exists: () => true,
    sample: async () => ({ ...HEALTHY, memFreePct: busy ? 1 : 60 }),
    config: { ...defaultConfig(state.dir), stateDir: state.dir, defaultCwd: state.dir,
      hooks: { beforeWake: ["authority", "wake", "{revision}"], beforeComplete: ["authority", "complete", "{revision}"] } },
  };
});
afterEach(() => state.done());

const registered = async (phase = G1): Promise<Lane> => {
  const session = join(state.dir, "owned.jsonl");
  writeFileSync(session, "{}\n");
  const lane: Lane = { key: "phase-worker", job: "issue-7", source: "source:7", title: "Phase work", thread: "none",
    cwd: state.dir, brief: join(state.dir, "brief.md"), done: "merged o/r#8", openedAt: new Date(T0).toISOString(),
    status: "hibernated", session, phase };
  await deps.registry.write(lane);
  return lane;
};

test.each([
  { owner: "helio-pr", version: 1, generation: 0 },
  { owner: "../other", version: 1, generation: 1 },
  { owner: "helio-pr", version: 0, generation: 1 },
  { owner: "helio-pr", version: 1, generation: 1, authority: "invented" },
])("invalid phase envelope cannot enter the protocol: %j", value => {
  expect(() => parsePhase(value)).toThrow(PhaseError);
});

test("a queued repair keeps its generation and rechecks authority before launching", async () => {
  const lane = await registered();
  busy = true;
  const queued = await wakeLane(deps, lane, { phase: G2, briefText: "repair", note: "new observation" });
  expect(queued.startup).toStartWith("LAUNCH_QUEUED");
  expect((await readQueue(deps))[0]?.phase).toEqual(G2);
  busy = false;
  hold = true;
  const result = await drainQueue(deps);
  expect(result[0]).toStartWith("LANE_DEQUEUE_FAILED");
  expect(activeAgents.size).toBe(0);
  expect((await deps.registry.read(lane.key))?.phase).toEqual(G2);
});

test("a phase wake preserves the recorded session and uses the new generation", async () => {
  const lane = await registered();
  const before = lane.session;
  await wakeLane(deps, lane, { phase: G2, briefText: "repair", note: "new observation" });
  const result = await deps.registry.read(lane.key);
  expect(result?.session).toBe(before);
  expect(result?.phase).toEqual(G2);
  expect(activeAgents).toEqual(new Set(["w:p2"]));
});

test("a dead pre-process wake reservation recovers the same phase before one process starts", async () => {
  const lane = await registered();
  const child = Bun.spawn([process.execPath, "-e", ""], { env: process.env, stdin: "ignore" });
  await child.exited;
  const reserved = { ...lane, status: "working" as const, phase: G2,
    launchState: "reserved" as const, launchOwner: child.pid };
  await deps.registry.write(reserved);
  expect(await recoverStart(deps, lane.key, reserved.revision!)).toStartWith("STARTUP_RECOVERED");
  const recovered = (await deps.registry.read(lane.key))!;
  expect(recovered.status).toBe("hibernated");
  expect(recovered.phase).toEqual(G2);
  expect(recovered.session).toBe(lane.session);
  await wakeLane(deps, recovered, { phase: G2, briefText: "repair", note: "reconciled startup" });
  expect(activeAgents).toEqual(new Set(["w:p2"]));
});

test("a live reservation owner or possible surviving pane prevents automatic restart", async () => {
  const lane = await registered();
  const reserved = { ...lane, status: "working" as const, phase: G2,
    launchState: "reserved" as const, launchOwner: process.pid };
  await deps.registry.write(reserved);
  expect(await recoverStart(deps, lane.key, reserved.revision!)).toStartWith("STARTUP_PENDING");
  const child = Bun.spawn([process.execPath, "-e", ""], { env: process.env, stdin: "ignore" });
  await child.exited;
  const dead = { ...reserved, launchOwner: child.pid };
  await deps.registry.write(dead);
  const original = deps.run;
  const surviving: FlowDeps = { ...deps, run: async argv => argv.slice(0, 3).join(" ") === "herdr pane list"
    ? { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "retained", cwd: lane.cwd }] } }), err: "" }
    : original(argv) };
  await expect(recoverStart(surviving, lane.key, dead.revision!)).rejects.toThrow("possible surviving resources");
  expect((await deps.registry.read(lane.key))?.revision).toBe(dead.revision);
  expect(activeAgents.size).toBe(0);
});

test("a phase with no authority hook cannot start an agent", async () => {
  const lane = await registered();
  const unsafe = { ...deps, config: { ...deps.config, hooks: {} } };
  await expect(wakeLane(unsafe, lane, { phase: G2, note: "repair" })).rejects.toThrow("no beforeWake");
  expect(activeAgents.size).toBe(0);
});

test("an initial phase with refused authority never starts a worker", async () => {
  const brief = join(state.dir, "initial.md");
  writeFileSync(brief, "phase work");
  hold = true;
  await expect(launchLane(deps, { key: "initial-worker", job: "issue-7", source: "source:7",
    title: "Phase work", brief, done: "merged o/r#8", phase: G1 })).rejects.toThrow("beforeWake refused");
  expect(activeAgents.size).toBe(0);
  expect((await deps.registry.read("initial-worker"))?.phase).toEqual(G1);
});

test("a stale ready observation cannot reserve completion after a newer wake", async () => {
  const lane = await registered();
  const newer = { ...lane, phase: G2, status: "working" as const };
  await deps.registry.write(newer);
  await expect(claimDone(deps, lane, "ready", lane.revision)).rejects.toThrow("newer lane revision");
  expect(existsSync(completionPath(deps, lane))).toBe(false);
  expect((await deps.registry.read(lane.key))?.phase).toEqual(G2);
});

test("a completion reservation excludes wake before completion artifacts exist", async () => {
  const lane = await registered();
  await claimDone(deps, lane, "ready", lane.revision);
  await expect(wakeLane(deps, lane, { phase: G2, note: "late repair" })).rejects.toThrow("LANE_EXISTS");
  expect(activeAgents.size).toBe(0);
  expect(existsSync(completionPath(deps, lane))).toBe(false);
});

test("merged work can reserve a queued newer phase and discard its wake without starting an agent", async () => {
  const lane = await registered();
  busy = true;
  await wakeLane(deps, lane, { phase: G2, briefText: "repair", note: "repair" });
  expect((await readQueue(deps)).length).toBe(1);
  await claimDone(deps, lane, "canonical work merged during queue", lane.revision, G2);
  const claimed = (await deps.registry.read(lane.key))!;
  expect(claimed.phase).toEqual(G2);
  expect(await readQueue(deps)).toEqual([]);
  expect(activeAgents.size).toBe(0);
  await acknowledgeClaim(deps, claimed);
  expect((await watchTick({ ...deps, clock: fakeClock(T0 + 6 * 60_000) }))[0]).toStartWith("LANE_CLOSED");
});

test("a hold at completion produces neither a receipt nor a successful close", async () => {
  const lane = await registered();
  hold = true;
  await deps.registry.write({ ...lane, status: "verified-done" });
  const current = await deps.registry.read(lane.key);
  if (!current) throw new Error("fixture lane missing");
  const result = await closeLane(deps, current, "ready");
  expect(result.closed).toBe(false);
  expect(existsSync(completionPath(deps, lane))).toBe(false);
});

test("a newer lane during authorization prevents the completion artifact", async () => {
  const lane = await registered();
  await deps.registry.write({ ...lane, status: "verified-done" });
  const current = await deps.registry.read(lane.key);
  if (!current) throw new Error("fixture lane missing");
  authorizeMutation = async () => {
    const latest = await deps.registry.read(lane.key);
    if (!latest) throw new Error("fixture lane missing");
    await deps.registry.write({ ...latest, status: "not-done" });
  };
  await expect(recordCompletion(deps, current)).rejects.toThrow("lane changed during authorization");
  expect(existsSync(completionPath(deps, lane))).toBe(false);
});

test("a phase completion objection retains its safely hibernated resource state", async () => {
  const lane = await registered();
  await objectDone(deps, lane, ["requester hold"]);
  expect((await deps.registry.read(lane.key))?.status).toBe("hibernated");
});

test("the reserved pane-less phase closes after acknowledgment and live proof", async () => {
  const lane = await registered();
  await claimDone(deps, lane, "canonical readiness", lane.revision);
  const claimed = await deps.registry.read(lane.key);
  if (!claimed) throw new Error("fixture lane missing");
  await acknowledgeClaim(deps, claimed);
  await watchTick({ ...deps, clock: fakeClock(T0 + 6 * 60_000) });
  expect((await deps.registry.read(lane.key))?.status).toBe("closed");
  expect(existsSync(completionPath(deps, lane))).toBe(true);
  expect(activeAgents.size).toBe(0);
});
