import { expect, test } from "bun:test";

import { closeLane } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const lane: Lane = { key: "direct-lane", title: "direct", thread: "none", pane: "w:p1", cwd: "/repo",
  brief: "/brief.md", done: "closed acme/app#2", openedAt: new Date(0).toISOString() };

test.each([
  [" M tracked.ts", "0"],
  ["?? untracked.ts", "0"],
  ["", "2"],
])("direct-checkout work blocks closing when status=%j ahead=%s", async (dirty, ahead) => {
  const state = withState();
  try {
    const world = newWorld();
    world.dirty = dirty;
    world.aheadCount = ahead;
    const deps = depsFor(world, fakeClock(0), state.dir);
    const external = deps.run;
    const run: Runner = async (argv, opts) => {
      if (argv.includes("worktree") && argv.includes("list")) return { code: 0, out: "worktree /repo\nbranch refs/heads/main", err: "" };
      if (argv.includes("rev-parse")) return { code: 0, out: "true", err: "" };
      return external(argv, opts);
    };
    await deps.registry.write(lane);
    const result = await closeLane({ ...deps, run }, lane, "done");
    expect(result).toEqual({ closed: false, lines: ["REFUSED direct-lane: unpushed work in /repo"] });
    expect(world.calls.some((argv) => argv[0] === "herdr" && argv[2] === "close")).toBe(false);
    expect((await deps.registry.read(lane.key))?.closedAt).toBeUndefined();
  } finally { state.done(); }
});

test.each([
  [{ code: 0, out: "true", err: "" }, true],
  [{ code: 128, out: "", err: "fatal: not a git repository (or any of the parent directories): .git" }, true],
  [{ code: 1, out: "", err: "permission denied" }, false],
  [{ code: 127, out: "", err: "git not found" }, false],
  [{ code: 128, out: "", err: "fatal: detected dubious ownership in repository at '/tmp/not a git repository'" }, false],
] as const)("direct-checkout repository probe %j permits closure=%s", async (probe, allowed) => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(0), state.dir);
    const external = deps.run;
    const run: Runner = async (argv, opts) => {
      if (argv.includes("worktree") && argv.includes("list")) return { code: 0, out: "", err: "" };
      if (argv.includes("rev-parse")) return probe;
      return external(argv, opts);
    };
    await deps.registry.write(lane);
    expect((await closeLane({ ...deps, run }, lane, "done")).closed).toBe(allowed);
    expect((await deps.registry.read(lane.key))?.closedAt !== undefined).toBe(allowed);
  } finally { state.done(); }
});
