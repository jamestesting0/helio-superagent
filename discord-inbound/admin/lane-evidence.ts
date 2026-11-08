import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AdminError, object, type AdminRecord } from "./protocol.ts";
import { stamp, stateName } from "./record-format.ts";
import { laneObservation } from "./lane-session.ts";
import type { Lane } from "./lane-records.ts";
import type { RuntimeState } from "./runtime-state.ts";

async function observe(argv: readonly string[]): Promise<{ readonly ok: boolean; readonly out: string }> {
  try {
    const child = Bun.spawn([...argv], {
      env: { ...process.env, GIT_MASTER: "1", GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000,
    });
    const [out, , code] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, out: out.trim() };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ok: false, out: "" };
    throw error;
  }
}

function clauses(done: string): string[] {
  const parts: string[] = [];
  let current = "", quoted = false, escaped = false;
  for (const character of done.replace(/^Done\s*=\s*/i, "")) {
    if (character === ";" && !quoted) { parts.push(current); current = ""; continue; }
    current += character;
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  return [...parts, current].map(part => part.trim()).filter(Boolean);
}

export async function laneEvidence(runtime: RuntimeState, lane: Lane, record: AdminRecord): Promise<AdminRecord> {
  const fields = (record.fields ?? []).filter(field => field.name !== "GitHub evidence");
  const conditions = [...(lane.objection?.reasons ?? [])];
  const criteria = clauses(lane.done);
  if (!criteria.length) conditions.push("No Done contract is recorded.");
  const independent = criteria.some(value => /^(merged|closed|command|url|published)\s/i.test(value));
  let closeProblem = independent ? undefined :
    "No independent completion checks are registered. Resume the work to establish acceptance checks, or the owner can abandon it without claiming completion.";
  if (!independent) conditions.push("Done has no independent command, URL, registry, or remote-state criterion.");
  const cwd = lane.cwd ?? runtime.published.values.HELIO_PROJECT;
  const roots = [...new Set(lane.worktrees?.length ? lane.worktrees : [cwd])];
  const [head, ...trees] = await Promise.all([
    observe(["git", "-C", cwd, "rev-parse", "HEAD"]),
    ...roots.slice(0, 4).map(async root => {
      const [dirty, ahead] = await Promise.all([observe(["git", "-C", root, "status", "--porcelain", "--untracked-files=all"]),
        observe(["git", "-C", root, "rev-list", "--count", "HEAD", "--not", "--remotes"])]);
      return { ok: dirty.ok && ahead.ok, out: !dirty.ok || !ahead.ok ? "unreadable" :
        dirty.out || Number(ahead.out) > 0 ? "uncommitted or unpushed work" : "clean and no locally recorded unpushed commits" };
    }),
  ]);
  trees.forEach((tree, index) => {
    fields.push({ name: `Worktree ${index + 1}`, value: tree.out });
    if (!tree.ok || tree.out === "uncommitted or unpushed work") conditions.push(`Worktree ${index + 1}: ${tree.out}.`);
  });
  if (roots.length > 4) conditions.push("Additional worktrees were not inspected; explicit close must check them.");
  if (!head?.ok) conditions.push("The current code revision is unavailable.");

  const files = criteria.filter(value => /^file\s/i.test(value));
  if (files.length) {
    if (!lane.job || !lane.source) closeProblem ??= "A bound job and original source are required before recording completion.";
    if (!head?.ok) closeProblem ??= "The current Git revision must be readable before recording completion.";
    const canonical = join(runtime.state, "completions", `${lane.key}.json`);
    for (const criterion of files) {
      const token = /^file\s+("(?:\\.|[^"\\])*"|\S+)/i.exec(criterion)?.[1];
      const path: unknown = token?.startsWith('"') ? JSON.parse(token) : token;
      if (typeof path !== "string") { conditions.push("A Done file path is unreadable."); continue; }
      const expanded = path.startsWith("~/") ? join(runtime.home, path.slice(2)) : path;
      if ((isAbsolute(expanded) ? expanded : resolve(cwd, expanded)) !== canonical) {
        conditions.push("A Done file does not refer to this lane's bound completion receipt.");
        closeProblem ??= `The Done contract uses a legacy file path. Its receipt must be ${canonical}; preserve the independent checks when correcting the contract.`;
      }
    }
    if (!existsSync(canonical)) conditions.push("The bound completion receipt is missing.");
    else if (!lstatSync(canonical).isFile() || lstatSync(canonical).isSymbolicLink()) {
      conditions.push("The completion receipt is not a regular file.");
    } else {
      try {
        const saved = object(JSON.parse(readFileSync(canonical, "utf8")));
        const expected = { version: 1, passed: true, job: lane.job, source: lane.source, lane: lane.key,
          opened_at: lane.openedAt, acceptance_sha256: stamp(lane.done), revision: head?.out };
        const mismatch = Object.entries(expected).filter(([key, value]) => value === undefined || saved[key] !== value).map(([key]) => key);
        if (typeof saved.checked_at !== "number" || saved.checked_at < Date.parse(lane.openedAt) || saved.checked_at > Date.now()) mismatch.push("checked_at");
        if (mismatch.length) conditions.push(`Completion receipt mismatches: ${mismatch.join(", ")}.`);
        else fields.push({ name: "Recorded completion", value: `Bound to this job, source, acceptance and code; checked <t:${Math.floor(Number(saved.checked_at) / 1000)}:f>.` });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof AdminError)) throw error;
        conditions.push("The completion receipt is malformed.");
      }
    }
  }

  const repository = runtime.published.values.HELIO_GITHUB_REPO;
  const references = new Map<string, { readonly kind: "issue" | "pr"; readonly number: string; readonly required?: string }>();
  const issue = /^issue-(\d+)$/.exec(lane.job ?? "")?.[1];
  if (issue) references.set(`issue:${issue}`, { kind: "issue", number: issue });
  for (const criterion of criteria) {
    const match = /^(merged|closed)\s+([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)(\d+)\s*$/i.exec(criterion);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    if (match[2] !== repository) { conditions.push("A GitHub criterion belongs to another repository and was not queried."); continue; }
    const kind = match[1].toLowerCase() === "merged" ? "pr" : "issue";
    references.set(`${kind}:${match[3]}`, { kind, number: match[3], required: match[1].toUpperCase() });
  }
  for (const match of `${lane.done}\n${lane.claim?.evidence ?? ""}`.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g)) {
    if (match[1] !== repository || !match[3]) continue;
    const kind = match[2] === "pull" ? "pr" : "issue", key = `${kind}:${match[3]}`;
    if (!references.has(key)) references.set(key, { kind, number: match[3] });
  }
  const observed = Math.floor(Date.now() / 1000);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) conditions.push("The GitHub repository is unavailable.");
  else {
    if (references.size > 20) conditions.push("Additional GitHub references were not checked in this bounded inspection.");
    const observations = await Promise.all([...references.values()].slice(0, 20).map(async reference => {
      const response = await observe(["gh", reference.kind, "view", reference.number, "--repo", repository,
        "--json", reference.kind === "pr" ? "state,url,updatedAt,mergedAt,closedAt,mergeCommit" : "state,url,updatedAt,closedAt"]);
      if (!response.ok) return { reference, value: "Unavailable; retained registry/receipt facts remain unverified." };
      try {
        const remote = object(JSON.parse(response.out));
        const state = typeof remote.state === "string" ? remote.state : "Unknown";
        const updated = typeof remote.updatedAt === "string" ? Date.parse(remote.updatedAt) : Number.NaN;
        const activity = Number.isFinite(updated) ? `<t:${Math.floor(updated / 1000)}:f>` : "unavailable";
        const valid = !reference.required || state === (reference.required === "MERGED" ? "MERGED" : "CLOSED") &&
          (reference.required !== "MERGED" || Boolean(remote.mergeCommit && object(remote.mergeCommit).oid));
        return { reference, valid, value: `${state} | Checked <t:${observed}:f>\n${remote.url ?? ""}\nUpdated ${activity}` };
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof AdminError)) throw error;
        return { reference, value: "Unavailable; GitHub returned an unreadable observation." };
      }
    }));
    for (const observation of observations) {
      fields.push({ name: `GitHub ${observation.reference.kind === "pr" ? "PR" : "issue"} #${observation.reference.number}`, value: observation.value });
      if (observation.reference.required && observation.valid !== true) {
        conditions.push(`${observation.reference.kind} #${observation.reference.number} does not currently verify ${observation.reference.required}.`);
      }
    }
  }
  let execution = "Not linked";
  let executionStatus = "missing";
  if (lane.pane) {
    try {
      const observation = await laneObservation(lane.pane);
      executionStatus = observation.status;
      execution = stateName(observation.status);
      if (observation.status !== "missing" && observation.reason && observation.reason !== "Herdr process observation") {
        execution += `: ${observation.reason}`;
      }
    }
    catch (error) { if (!(error instanceof AdminError)) throw error; execution = "Unavailable"; executionStatus = "unknown"; }
  }
  fields.push({ name: "Session", value: execution });
  if (record.state === "cleanup-pending" && executionStatus !== "missing" && lane.pane) {
    conditions.push(`Terminal cleanup is pending; the linked pane is ${execution}.`);
  }
  const latest = runtime.admin.query<{ result: string | null }, [string]>(
    "SELECT result FROM operations WHERE target=? AND action='lanes.close' ORDER BY created_at DESC LIMIT 1").get(lane.key);
  if (latest?.result) {
    const saved = object(JSON.parse(latest.result));
    if (typeof saved.error === "string") fields.push({ name: "Last close refusal", value: saved.error });
  }
  const deferred = criteria.filter(value => /^(command|url|published)\s/i.test(value)).length;
  if (deferred) fields.push({ name: "Verification", value: `${deferred} command, URL, or registry checks run when you choose Verify and close.` });
  if (conditions.length) fields.push({ name: "Needs attention", value: conditions.join("\n") });
  return { ...record, fields,
    ...(closeProblem ? { summary: `${record.summary}\nClose unavailable: ${closeProblem}`,
      blockedActions: { ...record.blockedActions, close: closeProblem } } : {}) };
}
