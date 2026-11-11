import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";
import { checkDone, parseSignal, splitDone, type Check } from "./signals.ts";
import { statusOf } from "./registry.ts";
import { authorizePhase, PhaseError } from "./phase.ts";

const acceptanceHash = (lane: Lane) => new Bun.CryptoHasher("sha256").update(lane.done).digest("hex");
export const completionPath = (deps: FlowDeps, lane: Lane): string => join(deps.config.stateDir, "completions", `${lane.key}.json`);

export class CompletionError extends Error {}

export const independentDoneSignals = (done: string): string[] =>
  splitDone(done).filter(signal => parseSignal(signal).kind !== "file");

export function completionContractProblem(deps: Pick<FlowDeps, "config" | "signalIo">,
  lane: Pick<Lane, "key" | "done" | "cwd">): string | undefined {
  const signals = splitDone(lane.done).map(parseSignal);
  if (!independentDoneSignals(lane.done).length) {
    return "Done needs an independent command, URL or remote-state check; a file marker alone cannot verify completion. Resume the work to establish acceptance checks, or explicitly abandon it without claiming completion.";
  }
  for (const signal of signals) {
    if (signal.kind !== "file") continue;
    const expected = join(deps.config.stateDir, "completions", `${lane.key}.json`);
    const expanded = signal.path.startsWith("~/") ? join(deps.signalIo?.home ?? homedir(), signal.path.slice(2)) : signal.path;
    const path = isAbsolute(expanded) ? expanded : resolve(lane.cwd ?? deps.config.defaultCwd, expanded);
    if (path !== expected) return `Done file must use its bound completion receipt: ${expected}. Correct the legacy acceptance path while preserving the independent checks.`;
  }
  return undefined;
}

async function revision(deps: FlowDeps, lane: Lane): Promise<string | null> {
  const head = await deps.run(["git", "-C", lane.cwd ?? deps.config.defaultCwd, "rev-parse", "HEAD"]);
  return head.code === 0 && /^[a-f0-9]{40,64}$/i.test(head.out.trim()) ? head.out.trim() : null;
}

/** Records already-live checks, or runs the independent criteria when explicitly requested by the worker. */
export async function recordCompletion(deps: FlowDeps, lane: Lane, verified?: readonly Check[]): Promise<string> {
  if (lane.phase && statusOf(lane) !== "verified-done") {
    throw new PhaseError("A managed completion artifact requires the verified reservation");
  }
  const problem = completionContractProblem(deps, lane);
  if (problem) throw new CompletionError(problem);
  const independent = independentDoneSignals(lane.done);
  const checks = verified ?? await checkDone(independent.join("; "), deps.run,
    { cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });
  if (checks.some(check => !check.ok)) throw new CompletionError(`Completion checks are not passing: ${
    checks.filter(check => !check.ok).map(check => `${check.signal} -> ${check.detail}`).join("; ")}`);
  const head = await revision(deps, lane);
  if (!verified && (!lane.job || !lane.source || !head)) {
    throw new CompletionError("A completion file requires a bound job, source and readable Git revision");
  }
  await authorizePhase(deps, lane, "beforeComplete");
  const path = completionPath(deps, lane);
  const directory = join(deps.config.stateDir, "completions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new RangeError("Completion directory is a symlink");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({
    version: 1, passed: true, job: lane.job ?? null, source: lane.source ?? null, lane: lane.key,
    opened_at: lane.openedAt, lane_revision: lane.revision ?? 0, acceptance: lane.done,
    acceptance_sha256: acceptanceHash(lane), revision: head, checked_at: deps.clock.now(), checks,
  }), { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

/** File checks must refer to this attempt's durable receipt at the still-current code revision. */
export async function completionFileChecks(deps: FlowDeps, lane: Lane): Promise<Check[]> {
  const files = splitDone(lane.done).flatMap(signal => {
    const parsed = parseSignal(signal);
    return parsed.kind === "file" ? [{ signal, path: parsed.path }] : [];
  });
  if (!files.length) return [];
  const problem = completionContractProblem(deps, lane);
  if (problem) return files.map(file => ({ signal: file.signal, ok: false, detail: problem }));
  const head = await revision(deps, lane);
  const independent = splitDone(lane.done).some(signal => parseSignal(signal).kind !== "file");
  const expected = completionPath(deps, lane);
  return Promise.all(files.map(async file => {
    const home = deps.signalIo?.home ?? homedir();
    const expanded = file.path.startsWith("~/") ? join(home, file.path.slice(2)) : file.path;
    const path = isAbsolute(expanded) ? expanded : resolve(lane.cwd ?? deps.config.defaultCwd, expanded);
    let ok = false;
    if (independent && lane.job && lane.source && head && path === expected && await Bun.file(path).exists()) {
      try {
        const info = await lstat(path);
        const receipt: unknown = await Bun.file(path).json();
        ok = info.isFile() && !info.isSymbolicLink() && typeof receipt === "object" && receipt !== null &&
          "version" in receipt && receipt.version === 1 && "passed" in receipt && receipt.passed === true &&
          "job" in receipt && receipt.job === lane.job && "source" in receipt && receipt.source === lane.source &&
          "lane" in receipt && receipt.lane === lane.key && "opened_at" in receipt && receipt.opened_at === lane.openedAt &&
          "acceptance_sha256" in receipt && receipt.acceptance_sha256 === acceptanceHash(lane) &&
          "revision" in receipt && receipt.revision === head &&
          "checked_at" in receipt && typeof receipt.checked_at === "number" &&
          receipt.checked_at >= Date.parse(lane.openedAt) && receipt.checked_at <= deps.clock.now();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return { signal: file.signal, ok, detail: ok ? "durable completion matches job, source, acceptance and revision" :
      "missing, stale or unbound completion receipt; run dori completion after independent checks pass" };
  }));
}
