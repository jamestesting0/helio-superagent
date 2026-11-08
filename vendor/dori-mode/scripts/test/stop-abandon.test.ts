import { expect, onTestFinished, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abandonLane } from "../src/done-flow.ts";
import * as sessionState from "../src/session-state.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test.each(["safe", "busy", "unowned", "missing-checkpoint", "dirty", "dirty-after-stop", "close-failure", "changed-version", "retry"])(
  "confirmed stop and abandonment preserves checkpoint and worktree for %s", async scenario => {
    const state = withState();
    onTestFinished(state.done);
    const world = newWorld();
    const base = depsFor(world, fakeClock(0), state.dir, { defaultCwd: state.dir });
    const checkpoint = join(state.dir, "session.jsonl");
    const work = join(state.dir, "work.txt");
    writeFileSync(work, "retained work");
    if (scenario !== "missing-checkpoint") writeFileSync(checkpoint, "{}\n");
    if (scenario === "dirty") world.dirty = " M work.txt";
    world.panes.push({ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" });
    let observations = 0, closeFails = scenario === "close-failure" || scenario === "retry";
    const observed = spyOn(sessionState, "paneExecution").mockImplementation(async () => ({
      status: scenario === "busy" ? "working" : "blocked", stopReady: scenario !== "busy",
      session: scenario === "unowned" ? join(state.dir, "another-session.jsonl") : checkpoint,
      id: "worker-session", pid: 123, since: new Date(0).toISOString(), state: "waiting_human",
      version: scenario === "changed-version" && ++observations >= 3 ? "123:2" : "123:1", reason: "Goal is paused",
    }));
    onTestFinished(() => observed.mockRestore());
    const deps = { ...base, run: async (...args: Parameters<typeof base.run>) => {
      const [argv] = args;
      if (argv[0] === "herdr" && argv[2] === "close") {
        if (closeFails) return { code: 1, out: "", err: "terminal busy" };
        if (scenario === "dirty-after-stop") world.dirty = " M work.txt";
        world.panes = [];
        return { code: 0, out: "", err: "" };
      }
      return base.run(...args);
    } };
    await deps.registry.write({ key: "qa", job: "qa", source: "discord:44444:66666", title: "Paused QA",
      thread: "none", brief: "/brief", cwd: state.dir, openedAt: new Date(0).toISOString(),
      status: "paused", pane: "w:p1", tab: "w:t1", session: checkpoint, done: "file /legacy-marker.json" });
    const current = await deps.registry.read("qa");
    if (!current) throw new Error("Missing disposable lane");
    if (scenario === "retry") {
      expect((await abandonLane(deps, current, "owner dropped QA", false, true)).closed).toBe(false);
      closeFails = false;
    }
    const target = await deps.registry.read("qa");
    if (!target) throw new Error("Missing retry target");

    const result = await abandonLane(deps, target, "owner dropped QA", false, true);

    const saved = await deps.registry.read("qa");
    const closed = scenario === "safe" || scenario === "retry";
    const stopped = closed || scenario === "dirty-after-stop";
    expect(result.closed).toBe(closed);
    expect(saved?.status).toBe(closed ? "closed" : scenario === "dirty-after-stop" ? "hibernated" : scenario === "close-failure" ? "cleanup-pending" : "paused");
    expect(world.panes.length).toBe(stopped ? 0 : 1);
    expect(await Bun.file(work).text()).toBe("retained work");
    expect(existsSync(checkpoint)).toBe(scenario !== "missing-checkpoint");
    expect(existsSync(join(state.dir, "completions/qa.json"))).toBe(false);
    if (closed) expect(saved?.receipt).toMatchObject({ abandoned: "abandoned by the owner: owner dropped QA", checks: [] });
  });
