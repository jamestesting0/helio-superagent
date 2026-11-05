import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readQueue } from "../src/admission.ts";
import { abandonLane, closeLane } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { lifecycleTick } from "../src/lifecycle.ts";
import { reapWorktrees, staleLanes } from "../src/reap.ts";
import { type Lane, statusOf, withStatus } from "../src/registry.ts";
import type { Ran, RunOptions } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, HEALTHY, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const MIN = 60_000;
const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

function setup(patch: Record<string, unknown> = {}) {
  const state = withState();
  cleanups.push(state.done);
  const world = newWorld();
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, state.dir, { sessionsDir: join(state.dir, "sessions"), ...patch });
  const terminal = { closeFails: false, tabs: 0, noAgent: false };
  const run = async (argv: readonly string[], opts?: RunOptions): Promise<Ran> => {
    const [cmd, a1, a2] = argv;
    if (cmd === "herdr" && a1 === "tab" && a2 === "create") {
      const n = ++terminal.tabs;
      world.panes.push({ pane_id: `w:p${n}`, workspace_id: "w", ...(terminal.noAgent ? {} : { agent: "pi", agent_status: "working" }) });
      return ok(JSON.stringify({ result: { root_pane: { pane_id: `w:p${n}` }, tab_id: `w:t${n}` } }));
    }
    if (cmd === "herdr" && (a1 === "tab" || a1 === "pane") && a2 === "close") {
      if (terminal.closeFails) return { code: 1, out: "", err: "tab busy" };
      world.panes = world.panes.filter((p) => p.pane_id !== (argv[3] ?? "").replace(":t", ":p"));
      return ok();
    }
    return base.run(argv, opts);
  };
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  return { state, world, clock, terminal, brief, deps: { ...base, run } };
}

const launch = (s: ReturnType<typeof setup>, key: string, extra: Record<string, unknown> = {}) =>
  launchLane(s.deps, { key, title: key, brief: s.brief, done: "closed acme/app#3", ...extra });

const lane = (key: string, patch: Partial<Lane> = {}): Lane =>
  ({ key, title: key, thread: "none", brief: "/b", done: "closed acme/app#3", cwd: "/repo", openedAt: new Date(T0).toISOString(), ...patch });

test("an adopted pane-only lane closes its shell before abandonment, and refuses failed closure", async () => {
  const s = setup();
  const adopted = lane("adopted", { pane: "w:p9", status: "paused" });
  s.world.panes.push({ pane_id: "w:p9", workspace_id: "w" });
  await s.deps.registry.write(adopted);
  s.terminal.closeFails = true;
  expect((await abandonLane(s.deps, adopted, "owner cancelled", false)).closed).toBe(false);
  expect((await s.deps.registry.read("adopted"))?.closedAt).toBeUndefined();
  s.terminal.closeFails = false;
  expect((await abandonLane(s.deps, adopted, "owner cancelled", false)).closed).toBe(true);
  expect(s.world.panes).toHaveLength(0);
});

test("a failed wake's surviving pane keeps the last worker slot", async () => {
  const s = setup({ maxWorkers: 1 });
  const dir = sessionDirFor(s.deps.config.sessionsDir, s.state.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-05T10-00-00-000Z_sid.jsonl"), "{}\n");
  await s.deps.registry.write(lane("wake-failed", { session: "sid", status: "hibernated", cwd: s.state.dir, brief: s.brief }));
  const run = s.deps.run;
  s.deps.run = async (argv, opts) => argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run"
    ? { code: 1, out: "", err: "transport failed after starting" } : run(argv, opts);
  await expect(launch(s, "same-job", { job: "wake-failed" })).rejects.toThrow("transport failed after starting");
  expect(s.world.panes).toHaveLength(1);
  expect((await launch(s, "unrelated")).startup).toContain("workers 1 >= 1");
  expect(s.terminal.tabs).toBe(1);
});

test("a retired failed launch without a created transcript retries in its original record", async () => {
  const s = setup({ agentCommand: ["omo", "{prompt}"] });
  const run = s.deps.run;
  let refuse = true;
  s.deps.run = async (argv, opts) => refuse && argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
    ? { code: 1, out: "", err: "create refused" } : run(argv, opts);
  await expect(launch(s, "failed-job")).rejects.toThrow("create refused");
  const failed = (await s.deps.registry.read("failed-job"))!;
  expect(failed.sessionVia).toBe("assigned");
  expect((await closeLane(s.deps, failed, "retire failed launch")).closed).toBe(true);
  refuse = false;
  expect((await launch(s, "new-key", { job: "failed-job" })).startup).toStartWith("STARTUP_OK failed-job");
  const retried = (await s.deps.registry.read("failed-job"))!;
  expect(retried.session).not.toBe(failed.session);
  expect(retried.closedAt).toBeUndefined();
  expect(retried.history?.length).toBeGreaterThan(1);
  expect(await s.deps.registry.read("new-key")).toBeNull();
});

test("launches over the worker cap queue durably, owner work first, and start when a slot frees", async () => {
  const s = setup({ maxWorkers: 1 });
  expect((await launch(s, "first")).startup).toStartWith("STARTUP_OK first");
  expect((await launch(s, "second")).startup).toBe('LAUNCH_QUEUED key=second position=1 reasons="workers 1 >= 1"');
  expect((await launch(s, "urgent", { priority: "owner" })).startup).toStartWith("LAUNCH_QUEUED key=urgent position=1");
  expect((await readQueue(s.deps)).map((entry) => entry.key)).toEqual(["urgent", "second"]);
  expect(s.terminal.tabs).toBe(1);
  const first = (await s.deps.registry.read("first"))!;
  await s.deps.registry.write(withStatus(first, "closed", "done", new Date(T0).toISOString(), { closedAt: new Date(T0).toISOString() }));
  const lines = await lifecycleTick(s.deps);
  expect(lines.some((line) => line.includes("LANE_DEQUEUED urgent STARTUP_OK urgent"))).toBe(true);
  expect((await readQueue(s.deps)).map((entry) => entry.key)).toEqual(["second"]);
});

test("admission fails closed when the pane count or the host sample is unavailable", async () => {
  const unknownPanes = setup();
  unknownPanes.deps.sample = async () => ({ ...HEALTHY, panes: -1 });
  expect((await launch(unknownPanes, "blind")).startup).toContain("pane count unknown");
  const broken = setup();
  broken.deps.sample = async () => { throw new Error("meminfo unreadable"); };
  expect((await launch(broken, "blind")).startup).toContain("host sample failed: meminfo unreadable");
  expect(unknownPanes.terminal.tabs + broken.terminal.tabs).toBe(0);
});

test("one open lane per job: a second launch for the same job is refused", async () => {
  const s = setup();
  await launch(s, "issue-8-facts", { job: "issue-8" });
  await expect(launch(s, "issue-8-retry", { job: "issue-8" })).rejects.toThrow("LANE_EXISTS key=issue-8-facts");
  expect(s.terminal.tabs).toBe(1);
});

test("a job's hibernated lane is resumed in its recorded session instead of a fresh launch", async () => {
  const s = setup();
  const cwd = join(s.state.dir, "work");
  mkdirSync(cwd);
  const dir = sessionDirFor(s.deps.config.sessionsDir, cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-05T10-00-00-000Z_sid-1.jsonl"), "{}\n");
  await s.deps.registry.write(lane("issue-9", { job: "issue-9", cwd, session: "sid-1", status: "hibernated", brief: join(s.state.dir, "briefs", "issue-9.md") }));
  const r = await launch(s, "issue-9-again", { job: "issue-9" });
  expect(r.startup).toBe("LANE_WOKEN issue-9 pane=w:p1");
  const runCall = s.world.calls.find((call) => call[0] === "herdr" && call[2] === "run");
  expect(runCall?.[4]).toContain(`--session ${join(dir, "2026-11-05T10-00-00-000Z_sid-1.jsonl")}`);
  expect(statusOf((await s.deps.registry.read("issue-9"))!)).toBe("working");
  expect(await s.deps.registry.read("issue-9-again")).toBeNull();
});

test("an idle worker hibernates after the idle window, never without a session or while a question waits", async () => {
  const s = setup();
  for (const [key, pane] of [["quiet", "w:p1"], ["asking", "w:p2"], ["unknown", "w:p3"]] as const) {
    s.world.panes.push({ pane_id: pane, workspace_id: "w", agent: "pi", agent_status: "idle" });
    await s.deps.registry.write(lane(key, { pane, tab: pane.replace(":p", ":t"), ...(key === "unknown" ? {} : { session: `sid-${key}` }) }));
  }
  const db = new Database(join(s.state.dir, "discord-questions.sqlite"), { create: true });
  db.exec("CREATE TABLE questions (id TEXT, lane TEXT, status TEXT)");
  db.query("INSERT INTO questions VALUES ('q1', 'asking', 'awaiting_answer')").run();
  db.close();
  expect(await lifecycleTick(s.deps)).toEqual([]);
  s.clock.at = T0 + 31 * MIN;
  const lines = await lifecycleTick(s.deps);
  expect(lines.filter((line) => line.includes("LANE_HIBERNATED"))).toEqual(['LANE_HIBERNATED quiet session kept; wake="dori resume quiet"']);
  const quiet = (await s.deps.registry.read("quiet"))!;
  expect([statusOf(quiet), quiet.session, quiet.pane]).toEqual(["hibernated", "sid-quiet", undefined]);
  expect(statusOf((await s.deps.registry.read("asking"))!)).toBe("working");
  expect(statusOf((await s.deps.registry.read("unknown"))!)).toBe("working");
});

test("a close whose tab survives stays cleanup-pending until the watcher sees the pane gone", async () => {
  const s = setup();
  s.world.panes.push({ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" });
  await s.deps.registry.write(lane("finishing", { pane: "w:p1", tab: "w:t1", status: "verified-done" }));
  s.terminal.closeFails = true;
  const result = await closeLane(s.deps, (await s.deps.registry.read("finishing"))!, "Done");
  expect(result.lines.at(-1)).toStartWith("CLEANUP_PENDING finishing");
  const pending = (await s.deps.registry.read("finishing"))!;
  expect([statusOf(pending), pending.closedAt]).toEqual(["cleanup-pending", undefined]);
  s.terminal.closeFails = false;
  expect(await lifecycleTick(s.deps)).toContain('LANE_CLOSED finishing terminal cleanup finished read="dori show finishing"');
  expect(existsSync(s.deps.registry.archivePath("finishing"))).toBe(true);
  expect((await s.deps.registry.list()).map((l) => l.key)).toEqual([]);
});

test("closed lanes move out of the active index but stay readable, including legacy records", async () => {
  const s = setup();
  mkdirSync(s.deps.registry.dir, { recursive: true });
  writeFileSync(s.deps.registry.path("legacy"), JSON.stringify(lane("legacy", { closedAt: new Date(T0).toISOString() })));
  await s.deps.registry.write(lane("active"));
  expect((await s.deps.registry.list()).map((l) => l.key)).toEqual(["active"]);
  expect(existsSync(s.deps.registry.path("legacy"))).toBe(false);
  expect((await s.deps.registry.read("legacy"))?.key).toBe("legacy");
  expect((await s.deps.registry.listAll()).map((l) => l.key).sort()).toEqual(["active", "legacy"]);
});

test("stale review lists only lanes stuck for the requested hours", async () => {
  const s = setup();
  const at = (hours: number) => new Date(T0 - hours * 3_600_000).toISOString();
  await s.deps.registry.write(lane("paused-long", { status: "paused", history: [{ at: at(25), status: "paused", note: "wait" }] }));
  await s.deps.registry.write(lane("paused-short", { status: "paused", history: [{ at: at(2), status: "paused", note: "wait" }] }));
  await s.deps.registry.write(lane("busy", { status: "working", openedAt: at(48) }));
  expect((await staleLanes(s.deps, 24)).map((row) => [row.key, row.status, row.age_hours])).toEqual([["paused-long", "paused", 25]]);
});

test("worktrees are removed only for closed lanes whose PR settled 3+ days ago with nothing unpushed", async () => {
  const s = setup();
  const prs: Record<string, { state: string; mergedAt: string | null }> = {
    "11": { state: "MERGED", mergedAt: new Date(T0 - 4 * 24 * 3_600_000).toISOString() },
    "12": { state: "MERGED", mergedAt: new Date(T0 - 1 * 24 * 3_600_000).toISOString() },
    "13": { state: "OPEN", mergedAt: null },
    "14": { state: "MERGED", mergedAt: new Date(T0 - 5 * 24 * 3_600_000).toISOString() },
  };
  const root = join(s.state.dir, "worktrees");
  const removed: string[] = [];
  const inner = s.deps.run;
  s.deps.run = async (argv, opts) => {
    if (argv[0] === "gh" && argv[2] === "view") return ok(JSON.stringify(prs[argv[3] ?? ""] ?? {}));
    if (argv[0] === "git" && argv.includes("status")) return ok(argv[2]?.endsWith("dirty") ? " M file" : "");
    if (argv[0] === "git" && argv.includes("worktree") && argv.includes("list")) return ok("");
    if (argv[0] === "git" && argv.includes("remove")) { removed.push(argv.at(-1) ?? ""); return ok(); }
    if (argv[0] === "git" && argv.includes("--git-common-dir")) return ok("/repo/.git");
    if (argv[0] === "git" && argv.includes("HEAD") && argv.includes("rev-parse")) return ok("abc123");
    return inner(argv, opts);
  };
  const closedAt = new Date(T0).toISOString();
  for (const [key, pr] of [["old", "11"], ["recent", "12"], ["open", "13"], ["dirty", "14"]] as const) {
    mkdirSync(join(root, key), { recursive: true });
    await s.deps.registry.write(lane(key, { done: `merged acme/app#${pr}`, closedAt, cwd: join(root, key) }));
  }
  mkdirSync(join(root, "orphan"), { recursive: true });
  await s.deps.registry.write(lane("busy", { done: "merged acme/app#11", cwd: join(root, "busy") }));
  mkdirSync(join(root, "busy"), { recursive: true });
  const plan = Object.fromEntries((await reapWorktrees(s.deps, false)).map((row) => [row.key, row.action]));
  expect(plan).toEqual({ old: "would_remove", recent: "kept", open: "kept", dirty: "kept", orphan: "kept", busy: "kept" });
  expect(removed).toEqual([]);
  const applied = await reapWorktrees(s.deps, true);
  expect(applied.filter((row) => row.action === "removed").map((row) => row.key)).toEqual(["old"]);
  expect(removed).toEqual([join(root, "old")]);
  expect((await s.deps.registry.read("old"))?.worktreeRemoved).toMatchObject({ branch: "helio/old", head: "abc123", evidence: "https://github.com/acme/app/pull/11" });
});

const hibernated = (s: ReturnType<typeof setup>, key: string, session: string) => {
  const cwd = join(s.state.dir, "work");
  mkdirSync(cwd, { recursive: true });
  const dir = sessionDirFor(s.deps.config.sessionsDir, cwd);
  mkdirSync(dir, { recursive: true });
  return { cwd, dir, write: () => s.deps.registry.write(lane(key, { job: key, cwd, session, status: "hibernated", brief: join(s.state.dir, "briefs", `${key}.md`) })) };
};
const paneCommand = (s: ReturnType<typeof setup>) => s.world.calls.find((call) => call[0] === "herdr" && call[2] === "run")?.[4] ?? "";

test("the installed worker command resumes with --session at the omo invocation, and only a ready agent counts as woken", async () => {
  const template = JSON.parse(readFileSync(join(import.meta.dir, "../../../../agent/config.template.json"), "utf8").replace(/\{\{[A-Z_]+\}\}/g, "1"));
  const s = setup({ agentCommand: template.agentCommand });
  const h = hibernated(s, "issue-9", "sid-1");
  writeFileSync(join(h.dir, "2026-11-05T10-00-00-000Z_sid-1.jsonl"), "{}\n");
  await h.write();
  expect((await launch(s, "issue-9-again", { job: "issue-9" })).startup).toBe("LANE_WOKEN issue-9 pane=w:p1");
  const command = paneCommand(s);
  expect(command).toStartWith("/bin/bash -c ");
  expect(command).toContain(`omo --session ${join(h.dir, "2026-11-05T10-00-00-000Z_sid-1.jsonl")} --no-ask-user`);
  const quiet = setup({ agentCommand: template.agentCommand });
  const q = hibernated(quiet, "issue-7", "sid-7");
  writeFileSync(join(q.dir, "2026-11-05T10-00-00-000Z_sid-7.jsonl"), "{}\n");
  await q.write();
  quiet.terminal.noAgent = true;
  expect((await launch(quiet, "issue-7-again", { job: "issue-7" })).startup).toStartWith("STARTUP_UNCONFIRMED issue-7");
});

test("an omo worker gets its session id before it starts, so a ready launch always has a resumable session", async () => {
  const template = JSON.parse(readFileSync(join(import.meta.dir, "../../../../agent/config.template.json"), "utf8").replace(/\{\{[A-Z_]+\}\}/g, "1"));
  const s = setup({ agentCommand: template.agentCommand });
  expect((await launch(s, "issue-10")).startup).toBe("STARTUP_OK issue-10 w:p1");
  const stored = (await s.deps.registry.read("issue-10"))!;
  expect([stored.session ?? "", stored.sessionVia]).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), "assigned"]);
  expect(paneCommand(s)).toContain(`omo --session-id ${stored.session} --no-ask-user`);
});

test("simultaneous launches for one job create at most one live lane", async () => {
  const s = setup();
  const results = await Promise.allSettled([
    launch(s, "issue-8-facts", { job: "issue-8" }), launch(s, "issue-8-retry", { job: "issue-8" }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await s.deps.registry.listAll()).filter((row) => row.job === "issue-8")).toHaveLength(1);
  expect(s.terminal.tabs).toBe(1);
});

test("queued work survives a launch lock held by another process and starts once it is free", async () => {
  const s = setup({ maxWorkers: 1 });
  await launch(s, "first");
  await launch(s, "second");
  const first = (await s.deps.registry.read("first"))!;
  await s.deps.registry.write(withStatus(first, "closed", "done", new Date(T0).toISOString(), { closedAt: new Date(T0).toISOString() }));
  const lock = join(s.deps.registry.dir, ".launch.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), String(process.pid));
  const held = await lifecycleTick(s.deps);
  expect(held.some((line) => line.includes("LANE_DEQUEUE_FAILED"))).toBe(false);
  expect((await readQueue(s.deps)).map((entry) => entry.key)).toEqual(["second"]);
  rmSync(lock, { recursive: true });
  expect((await lifecycleTick(s.deps)).some((line) => line.includes("LANE_DEQUEUED second STARTUP_OK second"))).toBe(true);
  expect(await readQueue(s.deps)).toEqual([]);
});

test.each(["session id", "recorded path"])("a lane whose session housekeeping archived is restored from the archive and resumed (%s)", async (form) => {
  const s = setup();
  const dir = hibernated(s, "issue-6", "sid-6").dir;
  const original = join(dir, "2026-11-05T10-00-00-000Z_sid-6.jsonl");
  const h = hibernated(s, "issue-6", form === "session id" ? "sid-6" : original);
  const archive = join(dirname(s.deps.config.sessionsDir), "sessions-archive");
  const packed = join(archive, "project", "2026-11-05T10-00-00-000Z_sid-6.jsonl.gz");
  mkdirSync(join(archive, "project"), { recursive: true });
  writeFileSync(packed, Bun.gzipSync(Buffer.from('{"type":"session","id":"sid-6"}\n')));
  writeFileSync(join(archive, "index.jsonl"), JSON.stringify({ session: "sid-6", path: packed, original }) + "\n");
  await h.write();
  expect((await launch(s, "issue-6-again", { job: "issue-6" })).startup).toBe("LANE_WOKEN issue-6 pane=w:p1");
  expect(readFileSync(original, "utf8")).toBe('{"type":"session","id":"sid-6"}\n');
  expect(existsSync(packed)).toBe(false);
  expect(paneCommand(s)).toContain(`--session ${original}`);
});

test("an owner can abandon a lane that will never finish: never with a live agent, never silently with unpushed work", async () => {
  const s = setup({ hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
  const wt = join(s.state.dir, "worktrees", "stale-qa");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "unpublished.txt"), "keep this work");
  s.world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "pi", agent_status: "idle" });
  await s.deps.registry.write(lane("stale-qa", { status: "paused", pane: "w:p7", tab: "w:t7", thread: "thread-1", worktrees: [wt],
    done: "file .omo/evidence/stale/report.json json:.passed=true" }));
  const read = async () => (await s.deps.registry.read("stale-qa"))!;
  expect((await abandonLane(s.deps, await read(), "QA plan dropped", false)).lines[0]).toStartWith("REFUSED stale-qa: an agent is still idle");
  s.world.panes = [];
  s.world.aheadCount = "2";
  expect((await abandonLane(s.deps, await read(), "QA plan dropped", false)).lines[0]).toStartWith("REFUSED stale-qa: unpushed work");
  expect(statusOf(await read())).toBe("paused");
  const done = await abandonLane(s.deps, await read(), "QA plan dropped", true);
  expect(done.closed).toBe(true);
  const closed = await read();
  expect([statusOf(closed), (closed.receipt as { abandoned?: string }).abandoned]).toEqual(["closed", "abandoned by the owner: QA plan dropped"]);
  expect(readFileSync(join(wt, "unpublished.txt"), "utf8")).toBe("keep this work");
  expect(s.world.calls.some((call) => call[0] === "notify")).toBe(false);
  await expect(abandonLane(s.deps, lane("x"), " ", false)).rejects.toThrow("reason");
});

test("abandoning refuses any live agent state and never closes a lane whose tab is still open", async () => {
  for (const status of ["blocked", "done"]) {
    const s = setup();
    s.world.panes.push({ pane_id: "w:p8", workspace_id: "w", agent: "pi", agent_status: status });
    await s.deps.registry.write(lane("live-qa", { status: "paused", pane: "w:p8", tab: "w:t8" }));
    expect((await abandonLane(s.deps, (await s.deps.registry.read("live-qa"))!, "dropped", false)).lines[0]).toStartWith(`REFUSED live-qa: an agent is still ${status}`);
  }
  const s = setup();
  s.world.panes.push({ pane_id: "w:p9", workspace_id: "w" });
  s.terminal.closeFails = true;
  await s.deps.registry.write(lane("shell-qa", { status: "paused", pane: "w:p9", tab: "w:t9" }));
  const r = await abandonLane(s.deps, (await s.deps.registry.read("shell-qa"))!, "dropped", false);
  expect([r.closed, r.lines[0]]).toEqual([false, "REFUSED shell-qa: tab w:t9 did not close; retry the abandon"]);
  expect(statusOf((await s.deps.registry.read("shell-qa"))!)).toBe("paused");
});

test("a failed lane whose pane survives keeps its slot and its job; once gone, a retry reuses its record", async () => {
  const s = setup({ maxWorkers: 1 });
  s.world.panes.push({ pane_id: "w:p5", workspace_id: "w", agent: "pi", agent_status: "working" });
  await s.deps.registry.write(lane("job-a", { job: "issue-5", pane: "w:p5", tab: "w:t5", status: "not-done", launchState: "failed" }));
  expect((await launch(s, "other")).startup).toStartWith("LAUNCH_QUEUED key=other");
  await expect(launch(s, "job-a-retry", { job: "issue-5" })).rejects.toThrow("LANE_EXISTS key=job-a");
  s.world.panes = [];
  const retried = await launch(s, "job-a-retry", { job: "issue-5" });
  expect(retried.startup).toStartWith("STARTUP_OK job-a ");
  expect(await s.deps.registry.read("job-a-retry")).toBeNull();
  expect((await s.deps.registry.read("job-a"))?.history?.some((h) => h.note.includes("relaunched"))).toBe(true);
});

test("a job resumed by a new launch takes that attempt's Done line, title, thread and model, directly or from the queue", async () => {
  for (const queued of [false, true]) {
    const s = setup({ maxWorkers: 1 });
    const h = hibernated(s, "issue-11", "sid-11");
    writeFileSync(join(h.dir, "2026-11-05T10-00-00-000Z_sid-11.jsonl"), "{}\n");
    await h.write();
    await s.deps.registry.write({ ...(await s.deps.registry.read("issue-11"))!, done: "merged acme/app#11", thread: "thread-11" });
    if (queued) await s.deps.registry.write(lane("busy", { pane: "w:p3", status: "working" }));
    const attempt = { job: "issue-11", title: "follow-up", done: "merged acme/app#22", thread: "thread-22", model: "m-2" };
    const first = (await launch(s, "issue-11-followup", attempt)).startup;
    if (queued) {
      expect(first).toStartWith("LAUNCH_QUEUED key=issue-11");
      await s.deps.registry.write({ ...(await s.deps.registry.read("busy"))!, status: "closed" });
      expect((await lifecycleTick(s.deps)).some((line) => line.includes("LANE_DEQUEUED issue-11 LANE_WOKEN issue-11"))).toBe(true);
    } else expect(first).toBe("LANE_WOKEN issue-11 pane=w:p1");
    const woke = (await s.deps.registry.read("issue-11"))!;
    expect([woke.done, woke.title, woke.thread, woke.model]).toEqual(["merged acme/app#22", "follow-up", "thread-22", "m-2"]);
    expect(woke.history?.some((entry) => entry.note.includes("previous Done: merged acme/app#11"))).toBe(true);
    const brief = readFileSync(woke.brief, "utf8");
    expect([brief.includes("acme/app#22"), brief.includes("acme/app#11")]).toEqual([true, false]);
  }
});
