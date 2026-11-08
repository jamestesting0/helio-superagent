import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Conversations } from "../conversations/conversations.ts";
import { executeProof } from "./backend.ts";
import { AdminError, object, result, type RuntimeQuery } from "./protocol.ts";
import { actions } from "./render.ts";
import { fixture, guildFixture, laneFixture } from "./fixtures/runtime.ts";

const realFetch = globalThis.fetch;

test.each([
  { action: "close" },
  { action: "abandon", done: `command ${JSON.stringify([process.execPath, "--eval", "process.exit(1)"])}` },
  { action: "abandon", done: "file /legacy/unverifiable-marker.json" },
])("lane transition executes the real CLI and preserves explicit abandonment: %s", async ({ action, done }) => {
  const f = laneFixture(done);
  const current = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }))).records[0];
  if (!current) throw new Error("Missing lane");

  await executeProof(f.proof({ kind: "mutate", action: `lanes.${action}`, target: current.id,
    expected: current.revision, input: { reason: "Owner ended this disposable work" } }, "end-lane", "22222"));

  const saved = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }, "inspect-closed"))).records[0];
  expect(saved?.state).toBe("closed");
  expect(saved?.activity?.[0]?.text).toContain("[admin:end-lane]");
});

test("a failed Done check is a settled refusal rather than an endlessly uncertain action", async () => {
  const f = laneFixture("file /does-not-exist/disposable-completion.json");
  const current = result(await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }))).records[0];
  if (!current) throw new Error("Missing lane");
  expect(actions("lanes", current, true).map(action => action.value)).toEqual(["resume", "abandon"]);
  const change = { action: "lanes.close", target: current.id, expected: current.revision, input: {} };

  await expect(executeProof(f.proof({ kind: "mutate", ...change }, "failed-done", "22222"))).rejects.toBeInstanceOf(AdminError);

  const receipt = await executeProof(f.proof({ kind: "receipt", ...change }, "failed-done", "22222"));
  expect(receipt.receipt?.status).toBe("refused");
  expect(object(await Bun.file(f.path).json()).status).toBe("paused");
});

test.each([true, false])("verified close records only independently passing completion checks: %s", async passed => {
  const f = laneFixture();
  const completion = join(f.state, "completions/lane-one.json");
  writeFileSync(join(f.home, "bin/git"), `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("HEAD")&&args.includes("rev-parse")) console.log("a".repeat(40));
else if(args.includes("--is-inside-work-tree")) console.log("true");
else if(args.includes("status")) console.log("");
else if(args.includes("rev-list")) console.log("0");
else process.exit(90);
`, { mode: 0o700 });
  writeFileSync(f.path, JSON.stringify({ ...object(await Bun.file(f.path).json()), job: "issue-8",
    done: `command ${JSON.stringify([process.execPath, "--eval", `process.exit(${passed ? 0 : 1})`])}; file ${completion} json:.passed=true` }));
  const current = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }))).records[0];
  if (!current) throw new Error("Missing lane");
  const change = executeProof(f.proof({ kind: "mutate", action: "lanes.close", target: current.id,
    expected: current.revision, input: {} }, "verify-close", "22222"));
  if (passed) {
    await change;
    const saved = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }, "closed"))).records[0];
    expect(saved?.state).toBe("closed");
    expect(object(await Bun.file(completion).json()).acceptance).toContain("command ");
  } else {
    await expect(change).rejects.toBeInstanceOf(AdminError);
    expect(await Bun.file(completion).exists()).toBe(false);
    expect(object(await Bun.file(f.path).json()).status).toBe("paused");
  }
});

test.each(["pause", "resume"])("lane %s changes the goal and registry through the real CLI", async action => {
  const f = laneFixture();
  const enginePath = join(f.home, "engine.json");
  writeFileSync(enginePath, JSON.stringify({ goal: action === "pause" ? "active" : "paused",
    running: action === "pause", input: "", screen: "" }));
  writeFileSync(f.path, JSON.stringify({ ...object(await Bun.file(f.path).json()),
    pane: "fixture-pane", status: action === "pause" ? "working" : "paused", pausedFrom: "not-done" }));
  writeFileSync(join(f.home, "bin/herdr"), `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const path=${JSON.stringify(enginePath)}, args=process.argv.slice(2);
const engine=JSON.parse(readFileSync(path,"utf8"));
switch(args[1]){
case "list": console.log(JSON.stringify({result:{panes:[{pane_id:"fixture-pane",agent:"fixture",
agent_status:engine.running?"working":"blocked"}]}})); break;
case "process-info": console.log(JSON.stringify({result:{process_info:{foreground_processes:[
{name:"bun",pid:123,argv:["bun","fixture-agent.js"]}]}}})); break;
case "read": console.log(engine.screen); break;
case "send-text": engine.input=args[3]; writeFileSync(path,JSON.stringify(engine)); break;
case "send-keys":
 if(args[3]==="enter"){
  if(engine.input==="/goal pause"){engine.goal="paused";engine.screen+="\\nGoal paused\\n";}
  if(engine.input==="/goal resume"){engine.goal="active";engine.running=true;engine.screen+="\\nGoal active\\n";}
 } else if(args[3]==="escape") engine.running=false;
 writeFileSync(path,JSON.stringify(engine)); break;
default: process.exit(90);
}
`, { mode: 0o700 });
  const current = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }))).records[0];
  if (!current) throw new Error("Missing lane");

  await executeProof(f.proof({ kind: "mutate", action: `lanes.${action}`, target: current.id,
    expected: current.revision, input: { reason: "Owner requested this transition" } }, "goal-change", "22222"));

  const engine = object(await Bun.file(enginePath).json());
  const saved = (await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }, "inspect-goal"))).records[0];
  expect(engine.goal).toBe(action === "pause" ? "paused" : "active");
  expect(engine.running).toBe(action === "resume");
  expect(saved?.state).toBe(action === "pause" ? "paused" : "not-done");
});

test.each(["normal", "trusted", "ignored", "hard_excluded", "outside_scope"])(
  "channel policy %s never reveals a channel hidden from the actor", async rule => {
    const f = fixture();
    f.publish("11111", "a".repeat(64), {
      DORI_DISCORD_ALLOWED: "44444", DORI_DISCORD_SCOPE_CATEGORY: rule === "outside_scope" ? "77777" : "88888",
      DORI_DISCORD_TRUSTED_CHANNELS: rule === "trusted" ? "44444" : "",
      DORI_DISCORD_NORMAL_CHANNELS: rule === "trusted" ? "" : "44444",
      DORI_DISCORD_IGNORED_CHANNELS: rule === "ignored" ? "44444" : "",
      DORI_DISCORD_CONTEXT_EXCLUDED: rule === "hard_excluded" ? "44444" : "",
    });
    guildFixture(false);
    const response = await executeProof(f.proof({ kind: "read", section: "channels", filters: {} }));
    expect(response.records).toEqual([]);
  },
);

test("an ignored channel remains editable when its real ancestry is inside the configured scope", async () => {
  const f = fixture();
  f.publish("11111", "a".repeat(64), {
    DORI_DISCORD_ALLOWED: "", DORI_DISCORD_SCOPE_CATEGORY: "88888", DORI_DISCORD_IGNORED_CHANNELS: "44444",
  });
  guildFixture(true);
  const response = await executeProof(f.proof({ kind: "read", section: "channels", target: "44444", filters: {} }, "inspect", "22222"));
  expect(response.records.map(record => [record.id, record.state, record.title])).toEqual([["44444", "ignored", "Incident room"]]);
});

test.each([false, true].flatMap(ignored => [false, true].map(member => ({ ignored, member }))))(
  "private-thread policy visibility follows membership independently of ignore state: %s", async ({ ignored, member }) => {
    const f = fixture();
    f.publish("11111", "a".repeat(64), {
      DORI_DISCORD_ALLOWED: ignored ? "" : "44444", DORI_DISCORD_SCOPE_CATEGORY: "88888",
      DORI_DISCORD_NORMAL_CHANNELS: ignored ? "" : "44444", DORI_DISCORD_IGNORED_CHANNELS: ignored ? "44444" : "",
    });
    guildFixture(true, member);
    const response = await executeProof(f.proof({ kind: "read", section: "channels", target: "44444", filters: {} }));
    expect(response.records.map(record => [record.id, record.state])).toEqual(member ? [["44444", ignored ? "ignored" : "normal"]] : []);
  },
);

test("lane details retain completion receipts and read current GitHub evidence without executing Done commands", async () => {
  const f = fixture();
  const bin = join(f.home, "bin"), marker = join(f.home, "must-not-run");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const executable = `#!${process.execPath}
const [path,...args]=process.argv.slice(1);const command=path?.split("/").at(-1);
if(command==="herdr") console.log(JSON.stringify({result:args[1]==="process-info"?
{process_info:{foreground_processes:[]}}:{panes:[{pane_id:"w1:p1",agent_status:"idle"}]}}));
else if(command==="git"&&args.includes("rev-parse")) console.log("a".repeat(40));
else if(command==="git"&&args.includes("status")) console.log(" M unfinished.ts");
else if(command==="git"&&args.includes("rev-list")) console.log("0");
else if(command==="gh"&&args[0]==="pr"&&args[1]==="view") console.log(JSON.stringify({state:"OPEN",url:"https://github.com/o/r/pull/7",updatedAt:"2026-11-06T12:00:00Z",mergeCommit:null}));
else if(command==="gh"&&args[0]==="issue"&&args[1]==="view") console.log(JSON.stringify({state:"OPEN",url:"https://github.com/o/r/issues/4",updatedAt:"2026-11-06T12:00:00Z"}));
else process.exit(90);
`;
  for (const name of ["gh", "git", "herdr"]) writeFileSync(join(bin, name), executable, { mode: 0o700 });
  const directory = join(f.state, "lanes");
  mkdirSync(directory, { recursive: true });
  const done = `merged o/r#7; file ${join(f.state, "completions/lane-one.json")}; command ${JSON.stringify([
    process.execPath, "--eval", `await Bun.write(${JSON.stringify(marker)},"ran")`,
  ])}`;
  writeFileSync(join(directory, "lane-one.json"), JSON.stringify({
    key: "lane-one", title: "A retained lane", thread: "44444", source: "discord:44444:66666", job: "issue-4",
    pane: "w1:p1", cwd: f.home, done, openedAt: "2026-11-06T10:00:00Z", status: "cleanup-pending",
    claim: { evidence: "Completion claimed", acknowledgedAt: "2026-11-06T11:00:00Z" },
    receipt: { note: "Close was checked", checks: [{ signal: "merged o/r#7", ok: true, detail: "Previously merged" }],
      cleanup: ["tab did not close"], completion: join(f.state, "completions/lane-one.json") },
  }));
  f.publish("11111", "a".repeat(64), { HELIO_GITHUB_REPO: "o/r", HELIO_PROJECT: f.home });
  guildFixture(true);
  const response = await executeProof(f.proof({ kind: "read", section: "lanes", target: "lane-one", filters: {} }));
  expect(response.records[0]?.state).toBe("cleanup-pending");
  expect(response.records[0]?.fields?.some(field => field.value === done)).toBe(true);
  const detail = JSON.stringify(response.records[0]?.fields);
  expect(detail).toContain("OPEN");
  expect(detail).toContain("https://github.com/o/r/pull/7");
  expect(detail).toContain(`<t:${Math.floor(Date.parse("2026-11-06T12:00:00Z") / 1000)}:f>`);
  expect(detail).toContain("tab did not close");
  expect(detail).toContain("uncommitted");
  expect(existsSync(marker)).toBe(false);
});

test("private conversation inspection returns only the acting user's DM topics", async () => {
  const f = fixture();
  const conversations = new Conversations(join(f.state, "discord-conversations.sqlite"));
  conversations.open("44444", "11111", "66666", "Own request", Date.now());
  conversations.open("55555", "33333", "77777", "Other private request", Date.now());
  conversations.dispose();
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (!/^https:\/\/discord.com\/api\/v10\/channels\/(44444|55555)$/.test(url)) throw new Error(`Unexpected offline request: ${url}`);
    return Response.json({ id: url.split("/").at(-1), type: 1 });
  }, { preconnect: realFetch.preconnect }));
  const response = await executeProof(f.proof({ kind: "read", section: "conversations", filters: {} }));
  expect(response.records.map(row => row.title)).toEqual(["Own request"]);
  expect(JSON.stringify(response)).not.toContain("Other private request");
});

test("a trusted moderator's block is durable and replay cannot repeat the operation", async () => {
  const f = fixture();
  const query: RuntimeQuery = { kind: "mutate", action: "blocks.add", target: "33333", expected: "",
    input: { reason: "Repeated irrelevant requests" } };
  const nonce = f.proof(query);
  const first = await executeProof(nonce);
  const replay = await executeProof(nonce);
  expect(replay).toEqual(first);
  const db = new Database(join(f.state, "discord-delivery.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT user_id,created_by FROM blocked_users").all()).toEqual([{ user_id: "33333", created_by: "11111" }]);
    expect(db.query("SELECT count(*) AS total FROM moderation_proofs").get()).toEqual({ total: 1 });
  } finally { db.close(); }
});

test("a conversation commit survives a lost outer receipt and reconciles after reopening the runtime", async () => {
  const f = fixture();
  const conversations = new Conversations(join(f.state, "discord-conversations.sqlite"));
  conversations.open("44444", "11111", "66666", "Own request", Date.now());
  conversations.dispose();
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ id: "44444", type: 1 }),
    { preconnect: realFetch.preconnect }));
  const topic = (await executeProof(f.proof({ kind: "read", section: "conversations", filters: {} }, "inspect"))).records[0];
  if (!topic) throw new Error("Missing fixture conversation");
  const input = { action: "conversations.hold", target: topic.id, expected: topic.revision, input: { reason: "Awaiting evidence" } };
  const administer = Conversations.prototype.administer;
  const lost = spyOn(Conversations.prototype, "administer").mockImplementation(function (this: Conversations, ...args) {
    administer.apply(this, args);
    throw new Error("Response lost after the topic committed");
  });
  try {
    await expect(executeProof(f.proof({ kind: "mutate", ...input }, "lost-response"))).rejects.toThrow("uncertain");
  } finally { lost.mockRestore(); }
  const recovered = await executeProof(f.proof({ kind: "receipt", ...input }, "lost-response"));
  expect(recovered.receipt?.status).toBe("done");
  expect(recovered.receipt?.outcome?.notice).toContain("Conversation");
  using db = new Database(join(f.state, "discord-conversations.sqlite"), { readonly: true });
  expect(db.query("SELECT count(*) AS total FROM conversation_admin_operations").get()).toEqual({ total: 1 });
  expect(db.query("SELECT status FROM conversations").get()).toEqual({ status: "on_hold" });
  await expect(executeProof(f.proof({ kind: "receipt", ...input, expected: "different" }, "lost-response"))).rejects.toThrow("already used");
});

test.each(["resume", "close", "reopen"])("conversation %s changes the retained topic through administration", async action => {
  const f = fixture();
  const conversations = new Conversations(join(f.state, "discord-conversations.sqlite"));
  conversations.open("44444", "11111", "66666", "Own request", Date.now());
  if (action === "resume") conversations.hold("44444", "11111", "Waiting", "66666");
  if (action === "reopen") conversations.close("44444", "11111", "answered", Date.now(), undefined, "66666");
  conversations.dispose();
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ id: "44444", type: 1 }),
    { preconnect: realFetch.preconnect }));
  const current = (await executeProof(f.proof({ kind: "read", section: "conversations", filters: {} }))).records[0];
  if (!current) throw new Error("Missing conversation");

  await executeProof(f.proof({ kind: "mutate", action: `conversations.${action}`, target: current.id,
    expected: current.revision, input: action === "close" ? { outcome: "answered" } : {} }, "topic-change"));

  using db = new Database(join(f.state, "discord-conversations.sqlite"), { readonly: true });
  const saved = db.query<{ status: string; revision: number }, []>("SELECT status,revision FROM conversations").get();
  expect(saved?.status).toBe(action === "close" ? "resolved" : "open");
  expect(saved?.revision).toBe(Number(current.revision) + 1);
});

test("unblocking removes the stored restriction through administration", async () => {
  const f = fixture();
  guildFixture(true);
  await executeProof(f.proof({ kind: "mutate", action: "blocks.add", target: "33333", expected: "",
    input: { reason: "Disposable moderation setup" } }, "setup-block"));
  const current = (await executeProof(f.proof({ kind: "read", section: "blocks", target: "33333", filters: {} }))).records[0];
  if (!current) throw new Error("Missing block");

  await executeProof(f.proof({ kind: "mutate", action: "blocks.remove", target: current.id,
    expected: current.revision, input: {} }, "remove-block"));

  using db = new Database(join(f.state, "discord-delivery.sqlite"), { readonly: true });
  expect(db.query("SELECT user_id FROM blocked_users").all()).toEqual([]);
});

test("a trusted moderator cannot block another currently trusted user", async () => {
  const f = fixture();
  await expect(executeProof(f.proof({ kind: "mutate", action: "blocks.add", target: "11111", expected: "",
    input: { reason: "This must not override protection" } }))).rejects.toThrow("owner or trusted");
  const db = new Database(join(f.state, "discord-delivery.sqlite"), { readonly: true });
  try { expect(db.query("SELECT user_id FROM blocked_users").all()).toEqual([]); }
  finally { db.close(); }
});

test("revocation invalidates an already issued administration proof before it can write", async () => {
  const f = fixture();
  const nonce = f.proof({ kind: "mutate", action: "blocks.add", target: "33333", expected: "", input: { reason: "Old proof" } });
  f.publish("", "b".repeat(64));
  await expect(executeProof(nonce)).rejects.toBeInstanceOf(AdminError);
  expect(existsSync(join(f.state, "discord-delivery.sqlite"))).toBe(false);
});

test("receipt inspection checks private-target visibility even when the runtime journal has no row", async () => {
  const f = fixture();
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ id: "55555", type: 1 }),
    { preconnect: realFetch.preconnect }));
  await expect(executeProof(f.proof({ kind: "receipt", action: "conversations.hold",
    target: "55555:33333:77777:1000", expected: "0", input: { reason: "Unavailable private target" } }))).rejects.toThrow("visible");
});
