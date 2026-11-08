import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AdminError, object, text, type AdminRecord } from "./protocol.ts";
import { escapeMarkdown, sourceUrl, stamp, stateName } from "./record-format.ts";

export interface Lane {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly source?: string;
  readonly pane?: string;
  readonly job?: string;
  readonly status?: string;
  readonly closedAt?: string;
  readonly openedAt: string;
  readonly done: string;
  readonly cwd?: string;
  readonly worktrees?: readonly string[];
  readonly objection?: { readonly reasons: readonly string[] };
  readonly receipt?: {
    readonly note?: string;
    readonly cleanup: readonly string[];
    readonly checks: readonly { readonly signal: string; readonly ok: boolean; readonly detail: string }[];
  };
  readonly claim?: { readonly evidence: string; readonly acknowledgedAt?: string };
  readonly history?: readonly { readonly at: string; readonly status: string; readonly note: string }[];
}

export function readLanes(stateDirectory: string, guild: string): { readonly lane: Lane; readonly record: AdminRecord }[] {
  const directory = join(stateDirectory, "lanes");
  const records: { readonly lane: Lane; readonly record: AdminRecord }[] = [];
  for (const folder of [directory, join(directory, "archive")]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(name => /^[a-z0-9][a-z0-9._-]{1,60}\.json$/.test(name) && !name.includes(".."))) {
      const raw = readFileSync(join(folder, name), "utf8");
      const value = object(JSON.parse(raw));
      const receipt = value.receipt === undefined ? undefined : object(value.receipt);
      const objection = value.objection === undefined ? undefined : object(value.objection);
      const lane: Lane = {
        key: text(value.key, 61), title: text(value.title, 600), thread: text(value.thread, 100),
        openedAt: text(value.openedAt, 100),
        done: typeof value.done === "string" ? text(value.done, 12000) : "",
        ...(typeof value.cwd === "string" ? { cwd: text(value.cwd, 4096) } : {}),
        ...(Array.isArray(value.worktrees) ? { worktrees: value.worktrees.map(path => text(path, 4096)) } : {}),
        ...(objection && Array.isArray(objection.reasons) ? { objection: { reasons: objection.reasons.map(reason => text(reason, 12000)) } } : {}),
        ...(receipt ? { receipt: {
          ...(typeof receipt.note === "string" ? { note: text(receipt.note, 12000) } : {}),
          cleanup: Array.isArray(receipt.cleanup) ? receipt.cleanup.map(item => text(item, 12000)) : [],
          checks: Array.isArray(receipt.checks) ? receipt.checks.map(value => {
            const item = object(value);
            if (typeof item.ok !== "boolean") throw new AdminError("invalid", "Invalid recorded completion check");
            return { signal: text(item.signal, 12000), ok: item.ok, detail: text(item.detail, 12000) };
          }) : [],
        } } : {}),
        ...(typeof value.source === "string" ? { source: value.source } : {}),
        ...(typeof value.pane === "string" ? { pane: value.pane } : {}),
        ...(typeof value.job === "string" ? { job: value.job } : {}),
        ...(typeof value.status === "string" ? { status: value.status } : {}),
        ...(typeof value.closedAt === "string" ? { closedAt: value.closedAt } : {}),
        ...(Array.isArray(value.history) ? { history: value.history.map(entry => {
          const item = object(entry); return { at: text(item.at, 100), status: text(item.status, 100), note: text(item.note, 12000) };
        }) } : {}),
        ...(value.claim && typeof value.claim === "object" ? { claim: {
          evidence: text(object(value.claim).evidence, 12000),
          ...(typeof object(value.claim).acknowledgedAt === "string" ? { acknowledgedAt: text(object(value.claim).acknowledgedAt, 100) } : {}),
        } } : {}),
      };
      if (name !== `${lane.key}.json`) throw new AdminError("unavailable", "Lane registry identity is inconsistent");
      const state = lane.closedAt ? "closed" : lane.status ?? "working";
      const source = /^discord:(\d+):(\d+)$/.exec(lane.source ?? "");
      const channel = source?.[1] ?? lane.thread.replace(/^discord:/, "");
      const issue = /^issue-(\d+)$/.exec(lane.job ?? "")?.[1];
      const issueLabel = issue && !new RegExp(`\\bissue\\s*#?\\s*${issue}\\b`, "i").test(lane.title) ? `Issue #${issue}` : undefined;
      const review = state === "done-claimed" && !lane.claim?.acknowledgedAt ? "Awaiting acknowledgment" : undefined;
      records.push({ lane, record: {
        id: lane.key, title: lane.title, revision: stamp(raw), state,
        summary: [escapeMarkdown(stateName(state)), issueLabel, review].filter(Boolean).join(" | "),
        ...(/^\d+$/.test(channel) ? { channel, url: sourceUrl(guild, channel, source?.[2]) } : {}),
        fields: [{ name: "Work status", value: stateName(state) },
          ...(review ? [{ name: "Claim review", value: review }] : []),
          ...(lane.job ? [{ name: "Job ID", value: lane.job }] : []),
          ...(lane.claim ? [{ name: "Completion claim", value: lane.claim.evidence }] :
            state === "working" ? [{ name: "Completion claim", value: "Not submitted" }] : []),
          ...(lane.done ? [{ name: "Completion criteria", value: lane.done }] : []),
          ...(lane.receipt?.cleanup.length ? [{ name: "Cleanup notes", value: lane.receipt.cleanup.join("\n") }] : []),
          ...(lane.receipt?.checks.length ? [{ name: "Last close checks", value: lane.receipt.checks
            .map(check => `${check.ok ? "Passed" : "Failed"}: ${check.signal}\n${check.detail}`).join("\n") }] : []),
          { name: "GitHub evidence", value: "Not checked." }],
        activity: (lane.history ?? []).slice().reverse().map(item => ({ title: `${stateName(item.status)} | ${item.at}`, text: item.note })),
      } });
    }
  }
  return records;
}
