import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { watchTick } from "../src/done-flow.ts";
import { monitorLine } from "../src/monitor.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let env: NodeJS.ProcessEnv;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const setup = await Bun.file(new URL("../../references/setup.md", import.meta.url)).text();
const filters = setup.split("\n").filter((line) => line.startsWith("|")).flatMap((line) => {
  const match = /\| `(\^[^`]+)` \|$/.exec(line);
  return match?.[1] ? [new RegExp(match[1].replaceAll("\\|", "|"))] : [];
});
const call = async (args: readonly string[]) => {
  const child = Bun.spawn([join(state.dir, "bin/dori"), ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  return out.trim();
};

beforeEach(async () => {
  state = withState();
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ ...defaultConfig(state.dir), stateDir: state.dir }));
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  symlinkSync(cli, join(bin, "dori"));
  writeFileSync(join(bin, "herdr"), "#!/bin/sh\nprintf 'invalid-json\\n'\n", { mode: 0o700 });
  env = { ...process.env, DORI_CONFIG: config, DORI_STATE_DIR: state.dir, PATH: `${bin}:${process.env.PATH}` };
});
afterEach(() => state.done());

test("show fetches full evidence without changing the record and repeated claim acknowledgement preserves its deadline", async () => {
  const deps = depsFor(newWorld(), fakeClock(0), state.dir);
  const evidence = "x".repeat(100_000);
  await deps.registry.write({ key: "cli-lane", title: "cli", thread: "none", brief: "/b", done: "file /b", openedAt: new Date(0).toISOString(), status: "done-claimed", claim: { at: new Date(0).toISOString(), evidence } });
  const before = await deps.registry.read("cli-lane");
  expect(JSON.parse(await call(["show", "cli-lane"]))).toEqual(before);
  expect(await deps.registry.read("cli-lane")).toEqual(before);
  expect(await call(["claim-ack", "cli-lane"])).toStartWith("LANE_CLAIM_ACK cli-lane ");
  const first = (await deps.registry.read("cli-lane"))?.claim?.acknowledgedAt;
  expect(typeof first).toBe("string");
  await call(["claim-ack", "cli-lane"]);
  expect((await deps.registry.read("cli-lane"))?.claim?.acknowledgedAt).toBe(first);
});

test("each upkeep command exposes failures through its documented monitor filter", async () => {
  const deps = depsFor(newWorld(), fakeClock(0), state.dir);
  mkdirSync(deps.registry.dir, { recursive: true });
  writeFileSync(join(deps.registry.dir, "broken.json"), "{");
  for (const [command, prefix] of [["dead-panes", "DEAD_PANES_ERROR"], ["guard", "GUARD_ERROR"], ["freshness", "FRESHNESS_ERROR"]]) {
    if (!command || !prefix) throw new Error("missing test case");
    const lines = (await call([command])).split("\n");
    const error = lines.find((line) => line.startsWith(prefix));
    expect(error).toBeDefined();
    expect(filters.some((filter) => filter.test(error ?? ""))).toBe(true);
  }
  const lines = await watchTick(deps);
  expect(lines[0]).toStartWith("LANE_WATCH_ERROR broken");
  expect(filters.some((filter) => filter.test(lines[0] ?? ""))).toBe(true);
  expect(filters.some((filter) => filter.test("WORKING-WHILE-PAUSED cli-lane working"))).toBe(true);
});

test("monitor rendering bounds large multiline records to a single 1000-character line", () => {
  const line = monitorLine(`POSTED cli-lane ${"x\n".repeat(100_000)}`);
  expect(line.length).toBe(1000);
  expect(line.includes("\n")).toBe(false);
});

test("sync shows recorded work separately from execution and accepts a hibernated lane without a pane", async () => {
  const deps = depsFor(newWorld(), fakeClock(0), state.dir);
  await deps.registry.write({ key: "sleeping", title: "sleeping", thread: "none", brief: "/b",
    done: "file /b", openedAt: new Date(0).toISOString(), status: "hibernated", session: "saved" });
  writeFileSync(join(state.dir, "bin/herdr"), "#!/bin/sh\nprintf '{\"result\":{\"panes\":[]}}\\n'\n", { mode: 0o700 });
  const output = await call(["sync"]);
  expect(output).toContain("hibernated | missing: No linked pane");
  expect(output).toContain("DRIFT none");
  expect((await deps.registry.read("sleeping"))?.session).toBe("saved");
});
