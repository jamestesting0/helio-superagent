import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLane } from "../src/done-flow.ts";
import { completionPath, recordCompletion } from "../src/completion.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test("a file's existence or an unbound passed field cannot establish lane completion", async () => {
  const state = withState();
  const deps = depsFor(newWorld(), fakeClock(1793966400000), state.dir);
  try {
    const file = join(state.dir, "completions", "report.json");
    mkdirSync(join(state.dir, "completions"));
    writeFileSync(file, '{"passed":true}');
    for (const [key, done] of [["bare-file", `file ${file}`],
      ["unbound-file", `file ${file} json:.passed=true; closed acme/app#3`]] as const) {
      const lane: Lane = { key, job: "issue-8", source: "discord:100:500", title: "request", thread: "none",
        brief: "/brief", done, openedAt: "2026-11-06T12:00:00Z" };
      await deps.registry.write(lane);
      expect((await closeLane(deps, lane, "Done")).closed).toBe(false);
      expect((await deps.registry.read(key))?.closedAt).toBeUndefined();
    }
  } finally { state.done(); }
});

test("a completion receipt binds the job, source, acceptance and current revision", async () => {
  const state = withState();
  const base = depsFor(newWorld(), fakeClock(1793966400000), state.dir);
  let head = "a".repeat(40);
  const deps = { ...base, run: async (...args: Parameters<typeof base.run>) =>
    args[0].includes("rev-parse") && args[0].includes("HEAD") ? { code: 0, out: head, err: "" } : base.run(...args) };
  const lane: Lane = { key: "bound-work", job: "issue-8", source: "discord:100:500",
    title: "request", thread: "none", brief: "/brief", done: "", openedAt: "2026-11-06T12:00:00Z" };
  const current = { ...lane, done: `file ${completionPath(deps, lane)} json:.passed=true; closed acme/app#3` };
  try {
    await deps.registry.write(current);
    const path = await recordCompletion(deps, current);
    expect(await Bun.file(path).json()).toMatchObject({ job: "issue-8", source: "discord:100:500",
      acceptance: current.done, revision: head, passed: true });
    head = "b".repeat(40);
    expect((await closeLane(deps, current, "Done")).closed).toBe(false);
    expect((await deps.registry.read(current.key))?.closedAt).toBeUndefined();
    await recordCompletion(deps, current);
    expect((await closeLane(deps, current, "Done")).closed).toBe(true);
    expect((await deps.registry.read(current.key))?.receipt).toMatchObject({ completion: path });
  } finally { state.done(); }
});
