import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeProof } from "./backend.ts";
import { fixture, guildFixture, laneFixture } from "./fixtures/runtime.ts";
import { object, type AdminRecord, type Section } from "./protocol.ts";
import type { Panel } from "./panels.ts";
import { render } from "./render.ts";

function listFields(records: readonly AdminRecord[], section: Section = "lanes") {
  const panel: Panel = { id: "a".repeat(24), actor: "22222", guild: "99999", channel: "44444",
    application: "88888", message: "77777", token: "offline", expires: 600000, revision: 1, section,
    positions: { [section]: { ids: records.map(record => record.id), filters: {}, page: 0 } },
    screen: "list", contentPage: 0, snapshot: 0 };
  return render(panel, records, { version: 1, revision: "a".repeat(64),
    values: { DORI_DISCORD_OWNER_ID: "22222" }, timing: [] }).embeds[0]?.fields;
}

test.each([
  { state: "hibernated", linked: false, execution: "missing", title: "Issue 8 Elo facts rotation", job: "issue-8", summary: "Hibernated" },
  { state: "hibernated", linked: true, execution: "missing", title: "Issue #8 Elo facts rotation", job: "issue-8", summary: "Hibernated" },
  { state: "closed", linked: true, execution: "missing", title: "PR 1 live beta QA", summary: "Closed" },
  { state: "hibernated", linked: false, execution: "missing", title: "Handle scheduled match confirmation errors", job: "issue-10", summary: "Hibernated | Issue #10" },
  { state: "working", linked: true, execution: "working", title: "Issue 8 Elo facts rotation", job: "issue-8", summary: "Working" },
  { state: "working", linked: false, execution: "missing", title: "Issue 8 Elo facts rotation", job: "issue-8", summary: "Working | Session not linked" },
  { state: "working", linked: true, execution: "missing", title: "Issue 8 Elo facts rotation", job: "issue-8", summary: "Working | Session missing" },
  { state: "hibernated", linked: true, execution: "working", title: "Issue 8 Elo facts rotation", job: "issue-8", summary: "Hibernated | Session working" },
  { state: "working", linked: true, execution: "unavailable", title: "Issue 8 Elo facts rotation", job: "issue-8", summary: "Working | Session unavailable" },
])("lane lists show one work status and retain meaningful session differences: $state/$execution/$linked", async row => {
  const f = laneFixture();
  const saved = object(await Bun.file(f.path).json());
  writeFileSync(f.path, JSON.stringify({ ...saved, title: row.title, status: row.state,
    ...(row.job ? { job: row.job } : {}), ...(row.linked ? { pane: "fixture-pane" } : {}),
    ...(row.state === "closed" ? { closedAt: "2026-11-06T12:00:00Z" } : {}) }));
  writeFileSync(join(f.home, "bin/herdr"), `#!${process.execPath}
const args=process.argv.slice(2), status=${JSON.stringify(row.execution)};
if(status==="unavailable") process.exit(1);
console.log(JSON.stringify({result:args[1]==="process-info" ? {process_info:{foreground_processes:[]}} :
{panes:status==="missing" ? [] : [{pane_id:"fixture-pane",agent_status:status}]}}));
`, { mode: 0o700 });

  const records = (await executeProof(f.proof({ kind: "read", section: "lanes", filters: {} }))).records;

  expect(listFields(records)).toEqual([{ name: row.title, value: row.summary }]);
  expect(records[0]?.state).toBe(row.state);
});

test("same-titled historical lanes remain separate selectable records", async () => {
  const f = laneFixture();
  const saved = object(await Bun.file(f.path).json());
  for (const key of ["lane-one", "lane-two"]) writeFileSync(join(f.state, "lanes", `${key}.json`),
    JSON.stringify({ ...saved, key, title: "PR 1 live beta QA", closedAt: "2026-11-06T12:00:00Z" }));

  const records = (await executeProof(f.proof({ kind: "read", section: "lanes", filters: {} }))).records;

  expect(records.map(record => record.id).sort()).toEqual(["lane-one", "lane-two"]);
  expect(listFields(records)).toEqual([
    { name: "PR 1 live beta QA", value: "Closed" }, { name: "PR 1 live beta QA", value: "Closed" },
  ]);
});

test("trusted-user list rows avoid repeating the name but retain the user link in details", async () => {
  const f = fixture();
  f.publish("33333");
  guildFixture(true);

  const records = (await executeProof(f.proof({ kind: "read", section: "trusted", filters: {} }, "read-trusted", "22222"))).records;

  expect(listFields(records, "trusted")).toEqual([{ name: "Offline fixture user", value: "Contributor access" }]);
  expect(records[0]?.fields?.find(field => field.name === "User")?.value).toBe("<@33333>");
});

test("channel list rows show the policy once and retain the channel link in details", async () => {
  const f = fixture();
  guildFixture(true);

  const records = (await executeProof(f.proof({ kind: "read", section: "channels", filters: {} }))).records;

  expect(listFields(records, "channels")?.map(field => field.value)).toEqual(["Normal", "Normal"]);
  expect(records[0]?.fields?.find(field => field.name === "Channel")?.value).toBe("<#44444>");
});

test("blocked-user list rows keep the reason and source without repeating the user", async () => {
  const f = fixture();
  guildFixture(true);
  await executeProof(f.proof({ kind: "mutate", action: "blocks.add", target: "33333", expected: "",
    input: { reason: "Repeated unrelated pings" } }, "block-user", "22222"));

  const records = (await executeProof(f.proof({ kind: "read", section: "blocks", filters: {} }, "read-blocks"))).records;

  expect(listFields(records, "blocks")).toEqual([{ name: "Offline fixture user", value: "Manual | Repeated unrelated pings" }]);
  expect(records[0]?.fields?.find(field => field.name === "User")?.value).toBe("<@33333>");
});

test("compact lane lists retain work, session and completion evidence in the opened item", async () => {
  const f = laneFixture();
  const saved = object(await Bun.file(f.path).json());
  writeFileSync(f.path, JSON.stringify({ ...saved, status: "hibernated", pane: "fixture-pane", job: "issue-8",
    claim: { evidence: "Checks passed at the saved revision" },
    receipt: { cleanup: ["Worktree retained"], checks: [{ signal: "command verify", ok: true, detail: "Recorded verification passed" }] } }));
  writeFileSync(join(f.home, "bin/herdr"), `#!${process.execPath}\nconsole.log(JSON.stringify({result:{panes:[]}}));\n`, { mode: 0o700 });

  const record = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }))).records[0];

  expect(record?.fields?.find(field => field.name === "Work status")?.value).toBe("Hibernated");
  expect(record?.fields?.find(field => field.name === "Session")?.value).toBe("Missing");
  const details = record?.fields?.map(field => field.value).join("\n");
  for (const value of [saved.done, "issue-8", "Checks passed at the saved revision", "Worktree retained", "Recorded verification passed"]) {
    expect(details).toContain(String(value));
  }
});

test.each([
  { pending: false, version: "4fca092", summary: "Up to date" },
  { pending: true, version: "4fca092", summary: "Lead restart pending" },
  { pending: false, version: undefined, summary: "Version not recorded" },
])("deployment rows retain restart and missing-version notices: $pending/$version", async ({ pending, version, summary }) => {
  const f = fixture();
  writeFileSync(join(f.home, ".dori/elobot/deploy-state.json"), JSON.stringify({
    version, lead_version: version, lead_restart_pending: pending,
  }));

  const records = (await executeProof(f.proof({ kind: "read", section: "settings", filters: {} }))).records;
  const deployment = records.find(record => record.id === "deployment");

  expect(deployment?.summary).toBe(summary);
  expect(deployment?.fields?.filter(field => field.value === (version ?? "Unrecorded"))).toHaveLength(2);
});
