import { lstat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { closeLane, failedLaunchWork, unpushedWork, type FlowDeps } from "./done-flow.ts";
import { withLaunchLock } from "./launch.ts";
import { ALIVE_STATUSES, statusLookup } from "./panes.ts";
import { LANE_KEY, statusOf, type Lane } from "./registry.ts";
import type { Ran, Runner } from "./run.ts";
import { fill } from "./config.ts";

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const keyOK = (value: unknown): value is string => typeof value === "string" && LANE_KEY.test(value) && !value.includes("..");
const digestOK = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected reconciliation object");
  return Object.fromEntries(Object.entries(value));
};
interface Candidate {
  key: string; role: "failed" | "replacement"; record_digest: string; brief_digest: string | null; resource_digest: string;
  action: "retire" | "bind" | "preserve"; reason: string; source: string | null; failed_after: Lane["failedAfter"] | null;
}
interface Manifest {
  version: 1; kind: "dori-lifecycle"; id: string; state: string; repository: string; job: string;
  issue_digest: string; candidates: Candidate[];
}
export interface LaneSelection { readonly failed?: string; readonly replacement?: string; readonly job: string; readonly repository: string }

async function issueSnapshot(deps: FlowDeps, repository: string, job: string): Promise<{ digest: string; url: string }> {
  const number = /^issue-([1-9]\d*)$/.exec(job)?.[1];
  if (!number || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      (process.env.HELIO_GITHUB_REPO && repository !== process.env.HELIO_GITHUB_REPO)) {
    throw new TypeError("Legacy issue binding requires issue-N in the configured repository");
  }
  const result = await deps.run(["gh", "issue", "view", number, "--repo", repository, "--json", "number,url,state,updatedAt"]);
  if (result.code !== 0) throw new Error(`Issue evidence unavailable: ${result.err.slice(0, 200)}`);
  const data = object(JSON.parse(result.out)), url = `https://github.com/${repository}/issues/${number}`;
  if (data.number !== Number(number) || data.url !== url || typeof data.state !== "string" || typeof data.updatedAt !== "string") {
    throw new TypeError("Issue evidence does not match the selected job");
  }
  return { digest: hash(data), url };
}

async function inspect(deps: FlowDeps, lane: Lane, role: Candidate["role"], job: string, issue: string): Promise<Candidate> {
  let brief: string | undefined, briefDigest: string | null = null;
  try {
    const info = await lstat(lane.brief);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1_048_576) {
      brief = await Bun.file(lane.brief).text();
      briefDigest = hash(brief);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let failedAfter = lane.failedAfter;
  // The historical owned-brief failure happened before worktree creation; absence is still checked live.
  if (!failedAfter && lane.launchState === "failed" && lane.brief.startsWith(join(deps.config.stateDir, "briefs") + "/") &&
      lane.launchError?.includes("EEXIST") && lane.launchError.includes("open") && lane.launchError.includes(lane.brief)) {
    failedAfter = "reserved";
  }
  const observations = new Map<string, { argv: readonly string[]; result: Ran }>();
  const run: Runner = async (argv, options) => {
    const key = JSON.stringify(argv), prior = observations.get(key);
    if (prior) return prior.result;
    const result = await deps.run(argv, options);
    observations.set(key, { argv, result });
    return result;
  };
  const candidate = { ...lane, ...(failedAfter ? { failedAfter } : {}) };
  const unsafe = role === "failed" ? await failedLaunchWork({ ...deps, run }, candidate) : await unpushedWork({ ...deps, run }, lane);
  const owned = [...observations.values()].filter(row => row.argv[0] === "git" && row.argv.includes("status")).map(row => row.argv[2]!);
  for (const path of new Set(owned)) await run(["git", "-C", path, "rev-parse", "HEAD"]);
  const pane = lane.pane ? await statusLookup(run, lane.pane) : {};
  const git = [...observations.values()].filter(row => row.argv[0] === "git");
  let sourceProof: unknown, verifiedSource: string | undefined;
  const original = brief ? /^Owner [^\n]+authorized implementation and PR preparation for issue ([1-9]\d*) in channel (\d+), message (\d+)/m.exec(brief) : null;
  if (role === "replacement" && original?.[1] && original[2] && original[3] && `issue-${original[1]}` === job && deps.config.hooks.inspectJobSource) {
    const source = `discord:${original[2]}:${original[3]}`;
    const result = await deps.run(fill(deps.config.hooks.inspectJobSource, { source, job }));
    sourceProof = { code: result.code, out: result.out, err: result.err };
    if (result.code === 0) {
      const proof = object(JSON.parse(result.out));
      if (proof.version === 1 && proof.purpose === "historical-job-identity" && proof.job === job &&
          proof.source_ref === source && digestOK(proof.source_digest)) verifiedSource = source;
    }
  }
  const resourceDigest = hash({ git, pane, unsafe, sourceProof });
  let action: Candidate["action"] = "preserve", reason = "Historical or protected lane retained";
  const boundSource = lane.source ?? verifiedSource ?? (brief?.includes(issue) ? issue : null);
  if (role === "failed" && lane.launchState === "failed" && statusOf(lane) !== "closed") {
    if (unsafe.length || pane.error || (pane.status && ALIVE_STATUSES.has(pane.status))) reason = "Live, missing, dirty, unpushed or unreadable resources retained";
    else if (!failedAfter && !lane.pane) reason = "Failure stage and agent ownership remain unverified";
    else { action = "retire"; reason = "Failed attempt has no live agent or unprotected work; retain history without completion"; }
  } else if (role === "replacement" && !lane.retiredAt && !lane.supersededBy && statusOf(lane) !== "paused" && statusOf(lane) !== "closed") {
    const unreadable = git.some(row => row.result.code !== 0);
    if (unreadable || pane.error) reason = "Current resource evidence is unavailable";
    else if (lane.job && lane.job !== job) reason = "Existing different job binding retained";
    else if (!brief?.includes(issue) && !verifiedSource) reason = "Task source does not prove the selected issue; do not infer from the lane name";
    else if (lane.job === job && lane.source) reason = "Identity is already bound";
    else { action = "bind"; reason = "Verified recorded task source matches current issue evidence"; }
  }
  return { key: lane.key, role, record_digest: hash(lane), brief_digest: briefDigest, resource_digest: resourceDigest,
    action, reason, source: boundSource, failed_after: failedAfter ?? null };
}

export async function previewLanes(deps: FlowDeps, path: string, selected: LaneSelection): Promise<void> {
  const keys = [selected.failed, selected.replacement].filter((value): value is string => value !== undefined);
  if (!keys.length || keys.some(key => !keyOK(key)) || new Set(keys).size !== keys.length) throw new TypeError("Select one failed and/or replacement lane by exact key");
  const issue = await issueSnapshot(deps, selected.repository, selected.job);
  const manifest: Manifest = { version: 1, kind: "dori-lifecycle", id: crypto.randomUUID(), state: hash(realpathSync(deps.config.stateDir)),
    repository: selected.repository, job: selected.job, issue_digest: issue.digest, candidates: [] };
  for (const key of keys) {
    const lane = await deps.registry.read(key);
    if (!lane) throw new RangeError(`Missing selected lane ${key}`);
    manifest.candidates.push(await inspect(deps, lane, key === selected.failed ? "failed" : "replacement", selected.job, issue.url));
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function parseManifest(value: unknown): Manifest {
  const data = object(value);
  if (data.version !== 1 || data.kind !== "dori-lifecycle" || typeof data.id !== "string" ||
      !digestOK(data.state) || !digestOK(data.issue_digest) || typeof data.repository !== "string" || typeof data.job !== "string" ||
      !Array.isArray(data.candidates) || !data.candidates.length || data.candidates.length > 2) throw new TypeError("Invalid lane repair manifest");
  const candidates = data.candidates.map((value): Candidate => {
    const row = object(value);
    if (!keyOK(row.key) || !digestOK(row.record_digest) || !digestOK(row.resource_digest) ||
        (row.brief_digest !== null && !digestOK(row.brief_digest)) ||
        (row.role !== "failed" && row.role !== "replacement") ||
        (row.action !== "retire" && row.action !== "bind" && row.action !== "preserve") || typeof row.reason !== "string" ||
        (row.source !== null && typeof row.source !== "string") ||
        (row.failed_after !== null && !["reserved", "brief-written", "worktree-created", "pane-created", "started", "unconfirmed", "failed"].includes(String(row.failed_after)))) {
      throw new TypeError("Invalid lane repair precondition");
    }
    const failed_after = ["reserved", "brief-written", "worktree-created", "pane-created", "started", "unconfirmed", "failed"] as const;
    return { key: row.key, role: row.role, action: row.action, record_digest: row.record_digest, brief_digest: row.brief_digest,
      resource_digest: row.resource_digest, reason: row.reason, source: row.source,
      failed_after: failed_after.find(stage => stage === row.failed_after) ?? null };
  });
  return { version: 1, kind: "dori-lifecycle", id: data.id, state: data.state, repository: data.repository,
    job: data.job, issue_digest: data.issue_digest, candidates };
}

export async function applyLanes(deps: FlowDeps, path: string): Promise<readonly { key: string; outcome: string }[]> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new TypeError("Manifest must be a regular file below 1 MiB");
  const manifest = parseManifest(await Bun.file(path).json());
  if (manifest.state !== hash(realpathSync(deps.config.stateDir))) throw new RangeError("State location changed; preview again");
  const issue = await issueSnapshot(deps, manifest.repository, manifest.job);
  if (issue.digest !== manifest.issue_digest) throw new RangeError("Issue evidence changed; preview again");
  const results = [];
  for (const expected of manifest.candidates) {
    const outcome = await withLaunchLock(deps, async () => {
      const lane = await deps.registry.read(expected.key);
      if (!lane) return "changed";
      if (lane.reconciliations?.some(receipt => receipt.manifest === manifest.id)) return "already-applied";
      const current = await inspect(deps, lane, expected.role, manifest.job, issue.url);
      if (current.record_digest !== expected.record_digest || current.brief_digest !== expected.brief_digest ||
          current.resource_digest !== expected.resource_digest || current.action !== expected.action) return "changed";
      if (current.action === "preserve") return "preserved";
      const at = new Date(deps.clock.now()).toISOString();
      const receipt = { manifest: manifest.id, before: current.record_digest, at,
        outcome: current.action === "retire" ? "retired" : "bound" };
      const patch = { reconciliations: [...(lane.reconciliations ?? []), receipt] };
      if (current.action === "retire") {
        const retired = await closeLane(deps, { ...lane, ...patch,
          ...(current.failed_after ? { failedAfter: current.failed_after } : {}) }, "Bounded reconciliation of verified failed launch");
        return retired.closed ? "retired" : "preserved";
      }
      const competing = (await deps.registry.snapshot()).find(other => other.key !== lane.key && other.job === manifest.job && statusOf(other) !== "closed");
      if (competing) return "changed";
      await deps.registry.write({ ...lane, ...patch, job: manifest.job, ...(lane.source ? {} : { source: current.source ?? issue.url }) });
      return "bound";
    });
    results.push({ key: expected.key, outcome });
  }
  return results;
}
