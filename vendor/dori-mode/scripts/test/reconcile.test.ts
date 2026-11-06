import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyLanes, previewLanes } from "../src/reconcile.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const at = "2026-11-06T12:00:00Z";
const issue = "https://github.com/acme/app/issues/8";

async function setup() {
  const state = withState(), world = newWorld();
  const base = depsFor(world, fakeClock(Date.parse(at)), state.dir);
  const run = async (...args: Parameters<typeof base.run>) => {
    if (args[0][0] === "gh") return { code: 0, err: "", out: JSON.stringify({ number: 8, url: issue, state: "CLOSED", updatedAt: at }) };
    if (args[0].includes("show-ref")) return { code: 1, out: "", err: "" };
    return base.run(...args);
  };
  const deps = { ...base, run, exists: (path: string) => !path.includes("/worktrees/absent") };
  mkdirSync(join(state.dir, "briefs"));
  const failed: Lane = { key: "early-failure", title: "attempt", thread: "none", brief: join(state.dir, "briefs", "early-failure.md"),
    done: "closed acme/app#8", openedAt: at, launchState: "failed", status: "not-done",
    worktrees: [join(state.dir, "worktrees", "absent")],
    launchError: `EEXIST: file already exists, open '${join(state.dir, "briefs", "early-failure.md")}'` };
  const replacement: Lane = { key: "valid-replacement", title: "work", thread: "none", brief: join(state.dir, "briefs", "valid-replacement.md"),
    done: "closed acme/app#8", openedAt: at, pane: "w:p2", status: "working" };
  writeFileSync(replacement.brief, `Original task: ${issue}\n`);
  world.panes.push({ pane_id: "w:p2", workspace_id: "w", agent: "pi", agent_status: "working" });
  await deps.registry.write(failed);
  await deps.registry.write(replacement);
  return { state, deps, world, failed, replacement };
}

test("lane preview is read-only; apply retires the proven empty failure, binds verified identity and repeats as a no-op", async () => {
  const s = await setup(), manifest = join(s.state.dir, "manifest.json");
  try {
    const before = await Promise.all([s.deps.registry.read(s.failed.key), s.deps.registry.read(s.replacement.key)]);
    await previewLanes(s.deps, manifest, { failed: s.failed.key, replacement: s.replacement.key, job: "issue-8", repository: "acme/app" });
    expect(await Promise.all([s.deps.registry.read(s.failed.key), s.deps.registry.read(s.replacement.key)])).toEqual(before);
    expect((await applyLanes(s.deps, manifest)).map(row => row.outcome)).toEqual(["retired", "bound"]);
    expect((await s.deps.registry.read(s.failed.key))?.retiredAt).toBeDefined();
    expect((await s.deps.registry.read(s.failed.key))?.job).toBeUndefined();
    expect(await s.deps.registry.read(s.replacement.key)).toMatchObject({ job: "issue-8", source: issue, status: "working", pane: "w:p2" });
    expect((await applyLanes(s.deps, manifest)).map(row => row.outcome)).toEqual(["already-applied", "already-applied"]);
    expect(s.world.calls.filter(call => call[0] === "herdr" && ["send-text", "close"].includes(call[2] ?? ""))).toEqual([]);
  } finally { s.state.done(); }
});

test("new holds and changed briefs preserve current work", async () => {
  const s = await setup(), manifest = join(s.state.dir, "manifest.json");
  try {
    await previewLanes(s.deps, manifest, { failed: s.failed.key, replacement: s.replacement.key, job: "issue-8", repository: "acme/app" });
    const current = (await s.deps.registry.read(s.replacement.key))!;
    await s.deps.registry.write({ ...current, status: "paused" });
    const result = await applyLanes(s.deps, manifest);
    expect(result.find(row => row.key === s.replacement.key)?.outcome).toBe("changed");
    const held = await s.deps.registry.read(s.replacement.key);
    expect(held?.status).toBe("paused");
    expect(held?.job).toBeUndefined();
    const next = join(s.state.dir, "next.json");
    const failed = (await s.deps.registry.read(s.failed.key))!;
    expect(failed.retiredAt).toBeDefined();
    await s.deps.registry.write({ ...current, revision: (await s.deps.registry.read(current.key))!.revision, status: "working" });
    await previewLanes(s.deps, next, { replacement: current.key, job: "issue-8", repository: "acme/app" });
    writeFileSync(current.brief, `Changed task: ${issue}\n`);
    expect((await applyLanes(s.deps, next))[0]?.outcome).toBe("changed");
    expect((await s.deps.registry.read(current.key))?.job).toBeUndefined();
  } finally { s.state.done(); }
});

test("unreadable resource evidence retains the failed attempt", async () => {
  const s = await setup(), manifest = join(s.state.dir, "manifest.json");
  const run = s.deps.run;
  s.deps.run = async (...args) => args[0][0] === "git" ? { code: 128, out: "", err: "repository unavailable" } : run(...args);
  try {
    await previewLanes(s.deps, manifest, { failed: s.failed.key, job: "issue-8", repository: "acme/app" });
    expect((await applyLanes(s.deps, manifest))[0]?.outcome).toBe("preserved");
    expect((await s.deps.registry.read(s.failed.key))?.retiredAt).toBeUndefined();
    expect((await s.deps.registry.read(s.failed.key))?.closedAt).toBeUndefined();
  } finally { s.state.done(); }
});

test("a deployment source inspector binds a recorded original request and changed proof refuses apply", async () => {
  const s = await setup(), manifest = join(s.state.dir, "manifest.json");
  let fingerprint = "a".repeat(64);
  const run = s.deps.run;
  const deps = { ...s.deps, config: { ...s.deps.config, hooks: {
    ...s.deps.config.hooks, inspectJobSource: ["inspect-source", "{source}", "{job}"],
  } }, run: async (...args: Parameters<typeof run>) => args[0][0] === "inspect-source" ?
    { code: 0, err: "", out: JSON.stringify({ version: 1, purpose: "historical-job-identity",
      source_ref: args[0][1], job: args[0][2], source_digest: fingerprint }) } : run(...args) };
  try {
    writeFileSync(s.replacement.brief, "Owner James authorized implementation and PR preparation for issue 8 in channel 100, message 500.\n");
    await previewLanes(deps, manifest, { replacement: s.replacement.key, job: "issue-8", repository: "acme/app" });
    fingerprint = "b".repeat(64);
    expect((await applyLanes(deps, manifest))[0]?.outcome).toBe("changed");
    expect((await deps.registry.read(s.replacement.key))?.job).toBeUndefined();
    const fresh = join(s.state.dir, "fresh.json");
    await previewLanes(deps, fresh, { replacement: s.replacement.key, job: "issue-8", repository: "acme/app" });
    expect((await applyLanes(deps, fresh))[0]?.outcome).toBe("bound");
    expect(await deps.registry.read(s.replacement.key)).toMatchObject({ job: "issue-8", source: "discord:100:500", status: "working" });
  } finally { s.state.done(); }
});
