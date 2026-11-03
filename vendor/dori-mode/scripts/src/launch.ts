import { cpSync, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, statusLookup } from "./panes.ts";
import { LANE_KEY, type Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { doneSyntaxErrors } from "./signals.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
};

export class LaunchError extends Error {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key) || input.key.includes("..")) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

export const footer = (lane: Lane, leadPane: string): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  "- Human questions go through Discord, never the terminal question tool. Follow the question workflow in work-policy.md; persist and send the question, start an answer monitor, and continue independent work.",
  `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>, sent to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
  `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
  "",
].join("\n");

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

export const launchLane = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  if (process.env.HELIO_OPENAI_ONLY === "1" && !/^(chatgpt-subscription|openai)\/[A-Za-z0-9._:-]+$/.test(model)) {
    throw new LaunchError("Helio only permits OpenAI provider models");
  }
  const sourceCwd = input.cwd ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const isolated = process.env.HELIO_WORKTREES === "1";
  const cwd = isolated ? join(deps.config.stateDir, "worktrees", input.key) : sourceCwd;
  const generated = join(deps.config.stateDir, "briefs", `${input.key}.md`);
  const draft: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", brief: generated, done: input.done, cwd, model, openedAt: iso(deps.clock), launchState: "reserved", ...(isolated ? { worktrees: [cwd] } : {}) };
  await deps.registry.write(draft);
  let lane = draft;
  try {
    mkdirSync(join(deps.config.stateDir, "briefs"), { recursive: true, mode: 0o700 });
    await writeFile(generated, `${(await briefFile.text()).replace(/\s*$/, "")}\n${footer(draft, deps.config.leadPane)}`, { flag: "wx", mode: 0o600 });
    if (isolated) {
      mkdirSync(join(deps.config.stateDir, "worktrees"), { recursive: true, mode: 0o700 });
      const wt = await deps.run(["git", "-C", sourceCwd, "worktree", "add", "-b", `helio/${input.key}`, cwd, "HEAD"]);
      if (wt.code !== 0) throw new LaunchError(`worktree creation failed: ${wt.err || wt.out}`);
      for (const rel of [".omo/omo.jsonc", "docs"]) {
        const src = join(sourceCwd, rel), dest = join(cwd, rel);
        if (existsSync(src) && !existsSync(dest)) { mkdirSync(join(dest, ".."), { recursive: true }); cpSync(src, dest, { recursive: true, force: false, errorOnExist: true }); }
      }
      const betaEnv = process.env.HELIO_BETA_ENV;
      if (betaEnv && existsSync(betaEnv)) {
        const st = lstatSync(betaEnv);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new LaunchError("beta environment must be an owner-only regular file");
        const dest = join(cwd, ".env");
        try { lstatSync(dest); throw new LaunchError("worktree already contains .env; refusing to replace it"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        symlinkSync(betaEnv, dest);
      }
      lane = { ...lane, launchState: "worktree-created" }; await deps.registry.write(lane);
    }
    const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", cwd, "--label", input.key, "--no-focus"]);
    if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
    const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
    const pane = made.root_pane.pane_id;
    const tab = made.tab_id ?? made.root_pane.tab_id;
    lane = { ...lane, pane, ...(tab ? { tab } : {}), launchState: "pane-created" }; await deps.registry.write(lane);
    const prompt = `${deps.config.launchKeywords}. Before work, start a persistent monitor for helio question watch --lane ${input.key} with filter ^QUESTION; do not use terminal question tools. Read and execute the lane brief at ${generated} in full. You are the ${input.key} lane; report as the brief's footer says.`;
    const launched = await deps.run(["herdr", "pane", "run", pane, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" ")]);
    if (launched.code !== 0) throw new LaunchError(`herdr pane run failed: ${launched.err || launched.out}`);
    lane = { ...lane, launchState: "started" }; await deps.registry.write(lane);
  } catch (error) {
    lane = { ...lane, status: "not-done", launchState: "failed", launchError: error instanceof Error ? error.message.slice(0, 300) : "launch failed" };
    await deps.registry.write(lane);
    throw new LaunchError(`launch failed for ${input.key}; record and any resources preserved for inspection: ${lane.launchError}`);
  }
  const pane = lane.pane!;
  await deps.clock.sleep(20_000);
  const screen = await readScreen(deps.run, pane, 40);
  const bad = STARTUP_FAILURE.exec(screen);
  if (bad) {
    lane = { ...lane, status: "not-done", launchState: "failed", launchError: `startup failure: ${bad[0]}` };
    await deps.registry.write(lane);
    return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${bad[0]}` };
  }
  const { status, error } = await statusLookup(deps.run, pane);
  if (status === "idle" || status === "working") return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  lane = { ...lane, launchState: "unconfirmed" };
  await deps.registry.write(lane);
  return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
