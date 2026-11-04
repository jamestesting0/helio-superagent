import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { alertReasons, sampleHost } from "../src/host-guard.ts";
import { canLaunch } from "../src/routing.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const lane: Lane = { key: "receipt-lane", title: "receipt", thread: "none", brief: "/b", done: "closed acme/app#1", openedAt: new Date(T0).toISOString() };
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("unseen claims remain compact and repeat beyond the close window even after emitted was saved", async () => {
  const clock = fakeClock(T0);
  const deps = depsFor(newWorld(), clock, state.dir);
  await claimDone(deps, lane, "x".repeat(100_000));
  const stored = await deps.registry.read(lane.key);
  if (!stored?.claim) throw new Error("claim missing");
  await deps.registry.write({ ...stored, claim: { ...stored.claim, emitted: true } });
  clock.at += 60 * 60_000;
  for (let tick = 0; tick < 2; tick++) {
    const lines = await watchTick(deps);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThanOrEqual(1000);
    expect(lines[0]).toContain(`dori show ${lane.key}`);
    expect(lines[0]).toContain(`dori claim-ack ${lane.key}`);
  }
  expect((await deps.registry.read(lane.key))?.status).toBe("done-claimed");
});

test("one lane failure does not hide another pending claim", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0 + 60 * 60_000), state.dir);
  await deps.registry.write({ ...lane, key: "aa-broken", status: "done-claimed", claim: { at: new Date(T0).toISOString(), acknowledgedAt: new Date(T0).toISOString(), evidence: "bad `text`" } });
  await deps.registry.write({ ...lane, status: "done-claimed", claim: { at: new Date(T0).toISOString(), evidence: "ready" } });
  const run = deps.run;
  const lines = await watchTick({ ...deps, run: async (argv) => {
    if (argv[0] === "gh") throw new Error("lane lookup failed");
    return run(argv);
  } });
  expect(lines.some((line) => line.startsWith("LANE_WATCH_ERROR aa-broken"))).toBe(true);
  expect(lines.some((line) => line.includes(`dori show ${lane.key}`))).toBe(true);
});

test("failed thread hook leaves report eligible for a later successful tick", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * 60_000), state.dir, { hooks: { threadReply: ["notify", "{text}"] } });
  const report = "[REPORT] receipt-lane | milestone | tests pass";
  await deps.registry.write({ ...lane, thread: "thread:1", pane: "w:p1", lastNudgeAt: T0 + 1, lastSeenReport: report });
  world.screen = report;
  const run = deps.run;
  const failed = await freshnessTick({ ...deps, run: async (argv) => argv[0] === "notify" ? { code: 1, out: "", err: "hook rejected" } : run(argv) }, "/home/test");
  expect(failed.map((a) => a.kind)).toEqual(["freshness_error"]);
  expect((await deps.registry.read(lane.key))?.lastPostedReport).toBeUndefined();
  expect((await deps.registry.read(lane.key))?.lastAutoReplyAt).toBeUndefined();
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["posted"]);
});

test("registry takes a dead PID lock but respects a live PID lock", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  mkdirSync(deps.registry.dir, { recursive: true });
  const lock = `${deps.registry.path(lane.key)}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "2147483647");
  await deps.registry.write(lane);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), String(process.pid));
  await expect(deps.registry.write(lane)).rejects.toThrow("locked");
  expect(await Bun.file(join(lock, "owner")).text()).toBe(String(process.pid));
});

test("registry publishes the owner before a writer awaits and excludes a concurrent writer", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const first = deps.registry.write(lane);
  expect(readFileSync(`${deps.registry.path(lane.key)}.lock/owner`, "utf8")).toBe(String(process.pid));
  await expect(deps.registry.write({ ...lane, title: "competing write" })).rejects.toThrow("locked");
  await first;
  expect((await deps.registry.read(lane.key))?.title).toBe("receipt");
});

test("Linux guard reads available memory and swap from meminfo and holds on unreadable memory", async () => {
  const base = depsFor(newWorld(), fakeClock(T0), state.dir);
  const run = async (argv: readonly string[]) => {
    if (argv.join(" ") === "cat /proc/meminfo") return { code: 0, out: "MemTotal: 8388608 kB\nMemAvailable: 1048576 kB\nSwapTotal: 4194304 kB\nSwapFree: 2097152 kB", err: "" };
    return base.run(argv);
  };
  const sample = await sampleHost(run);
  expect(sample.memFreePct).toBe(12.5);
  expect(sample.swapFreeGb).toBe(2);
  const unknown = await sampleHost(base.run);
  expect(unknown.memFreePct).toBeNull();
  expect(unknown.swapFreeGb).toBeNull();
  expect(alertReasons(unknown, base.config.guard)).toContain("memory free unknown");
  expect(canLaunch(unknown, base.config.guard).reasons).toContain("memory free unknown");
});
