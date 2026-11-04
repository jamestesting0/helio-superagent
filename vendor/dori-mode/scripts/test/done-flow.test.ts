import { afterEach, beforeEach, expect, test } from "bun:test";

import { acknowledgeClaim, claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after acknowledgement the lane is closed, its thread marked done and its worktree retained", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await acknowledgeClaim(at(T0), (await at(T0).registry.read(lane.key)) ?? lane);
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual([]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
  expect(world.calls).toContainEqual(["notify", "chat:team/123", "Done: merged acme/app#1 abc123"]);
  expect(world.calls).not.toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await acknowledgeClaim(at(T0), (await at(T0).registry.read(lane.key)) ?? lane);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await acknowledgeClaim(at(T0), (await at(T0).registry.read(lane.key)) ?? lane);
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await acknowledgeClaim(at(T0), (await at(T0).registry.read(lane.key)) ?? lane);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restart repeats unseen claims and acknowledgement starts a full close window", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  await acknowledgeClaim(at(T0 + 6 * MIN), (await at(T0).registry.read(lane.key)) ?? lane);
  expect(await watchTick(at(T0 + 10 * MIN))).toEqual([]);
  const settled = await watchTick(at(T0 + 11 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual(first);
  expect(settled[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

const failed: Lane = { ...lane, tab: "w:t1", launchState: "failed", launchError: "startup failure: No API key" };
const notified = () => world.calls.filter((c) => c[0] === "notify");
const storedFailed = async () => {
  const current = (await at(T0).registry.read("demo-lane"))!;
  await at(T0).registry.write({ ...current, tab: failed.tab, launchState: failed.launchState, launchError: failed.launchError });
  return (await at(T0).registry.read("demo-lane"))!;
};
const statusNow = async () => { const l = await at(T0).registry.read("demo-lane"); return l && statusOf(l); };

test("a failed launch whose pane is gone is retired without Done signals, keeping quiet in the work thread", async () => {
  world.prState = "OPEN";
  world.panes = [];
  const r = await closeLane(at(T0), await storedFailed(), "launch failed");
  expect(r.closed).toBe(true);
  expect(r.lines.at(-1)).toContain("no Done signals checked");
  expect(await statusNow()).toBe("closed");
  expect(closedVia()).toHaveLength(0);
  expect(notified()).toHaveLength(0);
});

test("a failed launch is not retired while an agent is still working or idle in its pane", async () => {
  world.prState = "OPEN";
  for (const agent_status of ["working", "idle"]) {
    world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status }];
    const r = await closeLane(at(T0), await storedFailed(), "launch failed");
    expect(r.closed).toBe(false);
    expect(r.lines.at(-1)).toContain(`an agent is still ${agent_status}`);
  }
  expect(closedVia()).toHaveLength(0);
  expect(await statusNow()).toBe("working");
});

test("a failed launch whose pane only holds a shell is retired and its tab closed", async () => {
  world.prState = "OPEN";
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "", agent_status: "unknown" }];
  const r = await closeLane(at(T0), await storedFailed(), "launch failed");
  expect(r.closed).toBe(true);
  expect(await statusNow()).toBe("closed");
  expect(closedVia()).toEqual([["herdr", "tab", "close", "w:t1"]]);
  expect(notified()).toHaveLength(0);
});

test("delivery is confirmed by the pane's agent status moving to working, with exactly one Enter", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("delivered");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a screen that still shows the text never causes another Enter; no status change is unconfirmed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.stuckReads = 10;
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] stuck text still here")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("a pane that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] queued while busy")).toBe("unconfirmed");
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});
