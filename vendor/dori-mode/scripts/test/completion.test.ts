import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLane, watchTick } from "../src/done-flow.ts";
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

test("recording completion refuses a contract whose file can never match its receipt", async () => {
  const state = withState();
  const base = depsFor(newWorld(), fakeClock(1793966400000), state.dir);
  const deps = { ...base, run: async (...args: Parameters<typeof base.run>) =>
    args[0].includes("rev-parse") && args[0].includes("HEAD") ?
      { code: 0, out: "a".repeat(40), err: "" } : base.run(...args) };
  const lane: Lane = { key: "legacy-file", job: "issue-8", source: "discord:100:500",
    title: "request", thread: "none", brief: "/brief", openedAt: "2026-11-06T12:00:00Z",
    done: `closed acme/app#3; file ${join(state.dir, "legacy-verified.json")}` };
  try {
    await expect(recordCompletion(deps, lane)).rejects.toThrow("completion");
    expect(await Bun.file(completionPath(deps, lane)).exists()).toBe(false);
  } finally { state.done(); }
});

test("automatic settlement never records verified completion from a bare file marker", async () => {
  const state = withState();
  const now = 1793966400000;
  const deps = depsFor(newWorld(), fakeClock(now), state.dir);
  const marker = join(state.dir, "legacy-passed.json");
  const lane: Lane = { key: "legacy-claim", job: "issue-8", source: "discord:100:500",
    title: "request", thread: "none", brief: "/brief", openedAt: "2026-11-06T11:00:00Z",
    done: `file ${marker}`, status: "done-claimed", claim: {
      at: new Date(now - 360000).toISOString(), acknowledgedAt: new Date(now - 360000).toISOString(), evidence: "Done",
    } };
  try {
    writeFileSync(marker, '{"passed":true}');
    await deps.registry.write(lane);
    await watchTick(deps);
    const saved = await deps.registry.read(lane.key);
    expect(saved?.status).toBe("not-done");
    expect(saved?.history?.some(entry => entry.status === "verified-done")).toBe(false);
  } finally { state.done(); }
});
