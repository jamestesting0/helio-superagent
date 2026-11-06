import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { capacityReasons, dequeue, enqueue, livePaneIds, readQueue, type Priority } from "./admission.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, statusLookup } from "./panes.ts";
import { lockRegistry } from "./registry-lock.ts";
import { jobOf, LANE_KEY, type Lane, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";
import { procTable, resolveSession, sessionDirFor } from "./session-id.ts";
import { doneSyntaxErrors } from "./signals.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly job: string;
  readonly source?: string;
  readonly priority?: Priority;
};

export type LaunchResult = { readonly lane?: Lane; readonly startup: string };

export class LaunchError extends Error {}
/** Another launch holds the lock right now: retry later; never a reason to drop queued work. */
export class LaunchBusyError extends LaunchError {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;

/** The lane model must match the configured --models allowlist (comma-separated globs); checked before anything is created. */
export const modelOutsideAllowlist = (model: string, allow: string | undefined): string | undefined => {
  const patterns = (allow ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!patterns.length || patterns.some((p) => new Bun.Glob(p).match(model))) return undefined;
  return `model ${model} is outside HELIO_MODEL_ALLOW (${patterns.join(", ")}); omit --model to use the configured worker model, or pass a model matching the allowlist`;
};

const validateShape = (input: Pick<LaunchInput, "key" | "done" | "job">): void => {
  if (!LANE_KEY.test(input.key) || input.key.includes("..")) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (!input.job) throw new LaunchError("--job is required; choose an explicit stable work identity");
  if (!LANE_KEY.test(input.job) || input.job.includes("..")) throw new LaunchError(`job must match ${LANE_KEY}`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  validateShape(input);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
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
  return withLaunchLock(deps, async () => {
  await validateLaunch(deps, input);
  const registered = await deps.registry.listAll();
  const sameJob = registered.find(lane => (lane.job === input.job || lane.pane === input.pane) &&
    !["closed", "hibernated"].includes(statusOf(lane)));
  const queued = (await readQueue(deps)).find(entry => entry.job === input.job);
  if (sameJob || queued) throw new LaunchError(`LANE_EXISTS key=${sameJob?.key ?? queued!.key}: use the registered job`);
  const lane: Lane = { key: input.key, job: input.job, source: input.source ?? input.thread ?? `brief:${input.brief}`,
    title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
  });
};

/** Admission and the reservation that follows it are one step, so two launches cannot both take the last slot. */
export const withLaunchLock = async <T>(deps: FlowDeps, fn: () => Promise<T>): Promise<T> => {
  mkdirSync(deps.registry.dir, { recursive: true });
  let unlock: () => void;
  try { unlock = lockRegistry(join(deps.registry.dir, ".launch.lock")); }
  catch (error) { throw new LaunchBusyError(`another launch is in progress; retry: ${error instanceof Error ? error.message : String(error)}`); }
  try { return await fn(); } finally { unlock(); }
};

const queuedLine = (key: string, position: number, reasons: readonly string[]): string =>
  `LAUNCH_QUEUED key=${key} position=${position} reasons=${JSON.stringify(reasons.join(" | "))}`;

const writeBrief = async (deps: FlowDeps, lane: Lane, text: string): Promise<void> => {
  mkdirSync(join(deps.config.stateDir, "briefs"), { recursive: true, mode: 0o700 });
  await writeFile(lane.brief, `${text.replace(/\s*$/, "")}\n${footer(lane, deps.config.leadPane)}`, { mode: 0o600 });
};

const addWorktree = async (deps: FlowDeps, sourceCwd: string, cwd: string, key: string): Promise<void> => {
  mkdirSync(join(deps.config.stateDir, "worktrees"), { recursive: true, mode: 0o700 });
  let wt = await deps.run(["git", "-C", sourceCwd, "worktree", "add", "-b", `helio/${key}`, cwd, "HEAD"]);
  if (wt.code !== 0 && /already exists/.test(wt.err)) wt = await deps.run(["git", "-C", sourceCwd, "worktree", "add", cwd, `helio/${key}`]);
  if (wt.code !== 0) throw new LaunchError(`worktree creation failed: ${wt.err || wt.out}`);
};

const openTab = async (deps: FlowDeps, cwd: string, key: string): Promise<{ readonly pane: string; readonly tab?: string }> => {
  const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", cwd, "--label", key, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
  const tab = made.tab_id ?? made.root_pane.tab_id;
  return { pane: made.root_pane.pane_id, ...(tab ? { tab } : {}) };
};

/** The agent's session id, read from its process; a lookup failure leaves the lane without one rather than failing the launch. */
export const recordSession = async (deps: FlowDeps, lane: Lane): Promise<Lane> => {
  if (!lane.pane) return lane;
  try {
    const hit = await resolveSession(lane.pane, lane.cwd ?? deps.config.defaultCwd, await procTable(deps.run), { run: deps.run, sessionsDir: deps.config.sessionsDir });
    if (!hit.id || hit.id === lane.session) return lane;
    const updated = { ...lane, session: hit.id, sessionVia: hit.via };
    await deps.registry.write(updated);
    return updated;
  } catch {
    return lane;
  }
};

export const launchLane = async (deps: FlowDeps, input: LaunchInput, queuedBrief?: string): Promise<LaunchResult> => {
  validateShape(input);
  const model = input.model ?? deps.config.defaultModel;
  const outside = modelOutsideAllowlist(model, process.env.HELIO_MODEL_ALLOW);
  if (outside) throw new LaunchError(outside);
  const briefFile = Bun.file(input.brief);
  if (queuedBrief === undefined && !(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const briefText = queuedBrief ?? await briefFile.text();
  const job = input.job;
  const sourceCwd = input.cwd ?? deps.config.defaultCwd;
  const isolated = process.env.HELIO_WORKTREES === "1";
  const cwd = isolated ? join(deps.config.stateDir, "worktrees", input.key) : sourceCwd;
  const generated = join(deps.config.stateDir, "briefs", `${input.key}.md`);
  const at = iso(deps.clock);
  const prompt = `${deps.config.launchKeywords}. Before work, start a persistent monitor for helio question watch --lane ${input.key} with filter ^QUESTION; do not use terminal question tools. Read and execute the lane brief at ${generated} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  const argv = fill(deps.config.agentCommand, { model, prompt });
  // Like the lead, an omo worker is started with a session id chosen and recorded first, so it can always be resumed.
  const omo = omoIndex(argv);
  const session = omo >= 0 ? randomUUID() : undefined;
  if (session) argv.splice(omo + 1, 0, "--session-id", session);
  const source = input.source ?? input.thread ?? `brief-sha256:${new Bun.CryptoHasher("sha256").update(briefText).digest("hex")}`;
  const fields = { title: input.title, thread: input.thread ?? "none", brief: generated, done: input.done, cwd, model,
    job, source, ...(isolated ? { worktrees: [cwd] } : {}), ...(session ? { session, sessionVia: "assigned" } : {}) };
  // Job identity is decided under the same lock as the reservation, so two launches cannot both find the job free.
  const admitted = await withLaunchLock(deps, async () => {
    const sameJob = (await deps.registry.listAll()).filter((lane) => lane.job === job);
    const busy = sameJob.find((lane) => !["closed", "hibernated"].includes(statusOf(lane)) && lane.launchState !== "failed");
    if (busy) throw new LaunchError(`LANE_EXISTS key=${busy.key} status=${statusOf(busy)}: send the new work to that lane`);
    const failedPanes = sameJob.filter(lane => lane.launchState === "failed" && lane.pane);
    if (failedPanes.length) {
      const live = await livePaneIds(deps);
      const surviving = failedPanes.find(lane => live.has(lane.pane!));
      if (surviving) throw new LaunchError(`LANE_EXISTS key=${surviving.key} status=failed: inspect its surviving pane before retrying`);
    }
    const resumable = sameJob.filter(lane => lane.launchState !== "failed" && !lane.retiredAt && lane.session &&
      ["closed", "hibernated"].includes(statusOf(lane))).sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
    if (resumable) return { kind: "wake" as const, wake: resumable };
    const failed = sameJob.find((lane) => lane.launchState === "failed" && !lane.retiredAt && !lane.supersededBy);
    // One record per job: a retry relaunches the failed attempt's record and keeps its history.
    if (failed && failed.key !== input.key) return { kind: "retry" as const, retryAs: failed.key };
    const queuedJob = (await readQueue(deps)).find((entry) => entry.key !== input.key && entry.job === job);
    if (queuedJob) throw new LaunchError(`LANE_EXISTS key=${queuedJob.key} status=queued: send the new work to that lane`);
    const existing = await deps.registry.read(input.key);
    if (existing && existing.job !== job) throw new LaunchError("Existing lane needs verified job binding; do not infer identity from its key");
    if (existing && (existing.worktrees ?? []).some(path => !existsSync(path)) &&
        !["reserved", "brief-written"].includes(existing.failedAfter ?? "")) {
      throw new LaunchError("A previously created or unverified worktree is missing; inspect before retrying");
    }
    if (existing && existing.launchState !== "failed") {
      throw new LaunchError(`lane ${input.key} is already registered (${statusOf(existing)}) without a session to resume; launch with a new key and --job ${job}`);
    }
    const reasons = await capacityReasons(deps);
    if (reasons.length) {
      const position = await enqueue(deps, { key: input.key, job, source, title: input.title, done: input.done, thread: input.thread, model: input.model, cwd: input.cwd, briefText, priority: input.priority ?? "normal", queuedAt: at });
      return { kind: "queued" as const, queued: true as const, position, reasons };
    }
    const draft: Lane = existing
      ? withStatus(existing, "working", "relaunched after a failed attempt", at, { ...fields, openedAt: at, closedAt: undefined,
        retiredAt: undefined, supersededBy: undefined, receipt: undefined, launchState: "reserved", failedAfter: undefined,
        launchError: undefined, pane: undefined, tab: undefined })
      : { key: input.key, ...fields, openedAt: at, launchState: "reserved" };
    await deps.registry.write(draft);
    await dequeue(deps, input.key);
    return { kind: "reserved" as const, queued: false as const, draft };
  });
  if (admitted.kind === "retry") return launchLane(deps, { ...input, key: admitted.retryAs }, briefText);
  if (admitted.kind === "wake") {
    const attempt = { title: input.title, done: input.done, ...(input.thread ? { thread: input.thread } : {}), ...(input.model ? { model: input.model } : {}) };
    return wakeLane(deps, admitted.wake, { briefText, priority: input.priority, note: `reopened for job ${job}`, attempt });
  }
  if (admitted.queued) return { startup: queuedLine(input.key, admitted.position, admitted.reasons) };
  let lane = admitted.draft;
  try {
    await writeBrief(deps, lane, briefText);
    lane = { ...lane, launchState: "brief-written" }; await deps.registry.write(lane);
    if (isolated) {
      if (!existsSync(cwd)) await addWorktree(deps, sourceCwd, cwd, input.key);
      for (const rel of [".omo/omo.jsonc", "docs"]) {
        const src = join(sourceCwd, rel), dest = join(cwd, rel);
        if (existsSync(src) && !existsSync(dest)) { mkdirSync(join(dest, ".."), { recursive: true }); cpSync(src, dest, { recursive: true, force: false, errorOnExist: true }); }
      }
      const betaEnv = process.env.HELIO_BETA_ENV;
      if (betaEnv && existsSync(betaEnv)) {
        const st = lstatSync(betaEnv);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new LaunchError("beta environment must be an owner-only regular file");
        const dest = join(cwd, ".env");
        let linked = false;
        try {
          const existingEnv = lstatSync(dest);
          if (!existingEnv.isSymbolicLink() || readlinkSync(dest) !== betaEnv) throw new LaunchError("worktree already contains .env; refusing to replace it");
          linked = true;
        } catch (e) { if (e instanceof LaunchError || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (!linked) symlinkSync(betaEnv, dest);
      }
      lane = { ...lane, launchState: "worktree-created" }; await deps.registry.write(lane);
    }
    const opened = await openTab(deps, cwd, input.key);
    lane = { ...lane, ...opened, launchState: "pane-created" }; await deps.registry.write(lane);
    const launched = await deps.run(["herdr", "pane", "run", opened.pane, argv.map(quoteForPane).join(" ")]);
    if (launched.code !== 0) throw new LaunchError(`herdr pane run failed: ${launched.err || launched.out}`);
    lane = { ...lane, launchState: "started" }; await deps.registry.write(lane);
  } catch (error) {
    lane = { ...lane, status: "not-done", failedAfter: lane.launchState, launchState: "failed",
      launchError: error instanceof Error ? error.message.slice(0, 300) : "launch failed" };
    await deps.registry.write(lane);
    throw new LaunchError(`launch failed for ${input.key}; record and any resources preserved for inspection: ${lane.launchError}`);
  }
  return confirmStartup(deps, lane, (ready) => `STARTUP_OK ${ready.key} ${ready.pane}${ready.session ? "" : " session=unknown"}`);
};

/** A started agent counts only once its pane shows a ready status; known startup failures and silence are reported. */
const confirmStartup = async (deps: FlowDeps, started: Lane, okLine: (lane: Lane) => string): Promise<LaunchResult> => {
  let lane = started;
  const pane = lane.pane!;
  await deps.clock.sleep(20_000);
  const screen = await readScreen(deps.run, pane, 40);
  const bad = STARTUP_FAILURE.exec(screen);
  if (bad) {
    lane = { ...lane, status: "not-done", failedAfter: lane.launchState, launchState: "failed", launchError: `startup failure: ${bad[0]}` };
    await deps.registry.write(lane);
    return { lane, startup: `STARTUP_ERROR ${lane.key} ${pane}: ${bad[0]}` };
  }
  const { status, error } = await statusLookup(deps.run, pane);
  if (status === "idle" || status === "working") {
    lane = await recordSession(deps, lane);
    return { lane, startup: okLine(lane) };
  }
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  lane = { ...lane, launchState: "unconfirmed" };
  await deps.registry.write(lane);
  return { lane, startup: `STARTUP_UNCONFIRMED ${lane.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

export const sessionFile = (deps: FlowDeps, lane: Lane): string | undefined => {
  if (!lane.session) return undefined;
  if (lane.session.includes("/")) return existsSync(lane.session) ? lane.session : restoreArchived(deps, lane.session);
  const dir = sessionDirFor(deps.config.sessionsDir, lane.cwd ?? deps.config.defaultCwd);
  let names: string[];
  try { names = readdirSync(dir); } catch { return undefined; }
  const name = names.find((entry) => entry.endsWith(`_${lane.session}.jsonl`));
  return name ? join(dir, name) : restoreArchived(deps, lane.session);
};

/** Housekeeping archives idle sessions to sessions-archive; resuming one puts it back where Omo expects it. `session` is an id or the recorded original path. */
const restoreArchived = (deps: FlowDeps, session: string): string | undefined => {
  const archive = join(dirname(deps.config.sessionsDir), "sessions-archive");
  let index: string;
  try { index = readFileSync(join(archive, "index.jsonl"), "utf8"); } catch { return undefined; }
  const entry = index.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { session?: string; path?: string; original?: string })
    .reverse().find((row) => (row.session === session || row.original === session) && row.path && row.original && existsSync(row.path));
  if (!entry?.path || !entry.original) return undefined;
  if (existsSync(entry.original)) return entry.original;
  mkdirSync(dirname(entry.original), { recursive: true });
  const partial = `${entry.original}.restoring`;
  writeFileSync(partial, Bun.gunzipSync(readFileSync(entry.path)), { mode: 0o600 });
  renameSync(partial, entry.original);
  const stem = entry.original.split("/").at(-1)!.replace(/\.jsonl$/, "");
  for (const name of readdirSync(dirname(entry.path))) {
    if (name.startsWith(`${stem}-artifacts`) || (name.startsWith(`${stem}.jsonl.`) && !name.endsWith(".gz"))) {
      renameSync(join(dirname(entry.path), name), join(dirname(entry.original), name));
    }
  }
  unlinkSync(entry.path);
  return entry.original;
};

/** Resumes a hibernated or closed lane's recorded session in a new tab; it counts against the worker cap like a launch. */
/** What a new launch for a resumed job changes: its own completion criterion and metadata, never the session or worktree. */
export type Attempt = { readonly title: string; readonly done: string; readonly thread?: string; readonly model?: string };

export const wakeLane = async (deps: FlowDeps, lane: Lane, options: { readonly briefText?: string; readonly priority?: Priority; readonly note: string; readonly attempt?: Attempt }): Promise<LaunchResult> => {
  if (!lane.job || lane.retiredAt || lane.supersededBy) throw new LaunchError("Lane needs a verified active job binding before resume");
  if ((lane.worktrees ?? []).some(path => !existsSync(path))) throw new LaunchError("A recorded worktree is missing; inspect before resume");
  const file = sessionFile(deps, lane);
  if (!file) throw new LaunchError(`lane ${lane.key} has no resumable session file (${lane.session ?? "none recorded"}); launch with a new key and --job ${jobOf(lane)}`);
  const at = iso(deps.clock);
  const before = statusOf(lane);
  const admitted = await withLaunchLock(deps, async () => {
    const current = (await deps.registry.read(lane.key)) ?? lane;
    const competing = (await deps.registry.listAll()).find(other => other.key !== current.key && other.job === current.job &&
      !["closed", "hibernated"].includes(statusOf(other)) && !other.retiredAt);
    if (competing) throw new LaunchError(`LANE_EXISTS key=${competing.key}: send the work to the active job`);
    if (!["closed", "hibernated"].includes(statusOf(current))) {
      throw new LaunchError(`LANE_EXISTS key=${current.key} status=${statusOf(current)}: send the new work to that lane`);
    }
    const reasons = await capacityReasons(deps);
    if (reasons.length) {
      const next = options.attempt;
      const position = await enqueue(deps, { key: lane.key, ...(lane.job ? { job: lane.job } : {}), title: next?.title ?? current.title, done: next?.done ?? current.done, thread: next?.thread ?? current.thread, ...((next?.model ?? current.model) ? { model: next?.model ?? current.model } : {}), briefText: options.briefText ?? "", priority: options.priority ?? "normal", queuedAt: at, wake: true });
      return { queued: true as const, position, reasons };
    }
    const next = options.attempt;
    const changedDone = next && next.done !== current.done ? `; previous Done: ${current.done}` : "";
    const adopted = next ? { title: next.title, done: next.done, thread: next.thread ?? current.thread, ...((next.model ?? current.model) ? { model: next.model ?? current.model } : {}) } : {};
    const reserved = withStatus(current, "working", options.note + changedDone, at, { ...adopted, closedAt: undefined, launchState: "reserved", launchError: undefined, pane: undefined, tab: undefined, idleSince: undefined, lastReplyAt: deps.clock.now() });
    await deps.registry.write(reserved);
    await dequeue(deps, lane.key);
    return { queued: false as const, reserved };
  });
  if (admitted.queued) return { startup: queuedLine(lane.key, admitted.position, admitted.reasons) };
  let woke = admitted.reserved;
  try {
    if (options.briefText) await writeBrief(deps, woke, options.briefText);
    const cwd = woke.cwd ?? deps.config.defaultCwd;
    if (!existsSync(cwd)) await addWorktree(deps, deps.config.defaultCwd, cwd, woke.key);
    const opened = await openTab(deps, cwd, woke.key);
    woke = { ...woke, ...opened, launchState: "pane-created" }; await deps.registry.write(woke);
    const prompt = options.briefText
      ? `You are the ${woke.key} lane again. Read and execute the new brief at ${woke.brief} in full; report as its footer says.`
      : `You are the ${woke.key} lane, resumed after a pause for inactivity. Continue where you left off; report as your brief's footer says.`;
    const argv = fill(deps.config.agentCommand, { model: woke.model ?? deps.config.defaultModel, prompt });
    const omo = omoIndex(argv);
    if (omo < 0) throw new LaunchError("the agent command has no omo invocation to resume");
    argv.splice(omo + 1, 0, "--session", file);
    const launched = await deps.run(["herdr", "pane", "run", opened.pane, argv.map(quoteForPane).join(" ")]);
    if (launched.code !== 0) throw new LaunchError(`herdr pane run failed: ${launched.err || launched.out}`);
    woke = { ...woke, launchState: "started" }; await deps.registry.write(woke);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "wake failed";
    await deps.registry.write(withStatus(woke, before === "closed" ? "hibernated" : before, `wake failed: ${message}`, iso(deps.clock),
      { failedAfter: woke.launchState, launchState: "failed", launchError: message }));
    throw new LaunchError(`wake failed for ${lane.key}: ${message}`);
  }
  return confirmStartup(deps, woke, (ready) => `LANE_WOKEN ${ready.key} pane=${ready.pane}`);
};

/** The installed command wraps omo in a shell; session flags belong to omo, wherever it sits in the command. */
const omoIndex = (argv: readonly string[]): number => argv.findIndex((part) => part === "omo" || part.endsWith("/omo"));

const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
