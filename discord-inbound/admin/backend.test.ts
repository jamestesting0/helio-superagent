import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations } from "../conversations/conversations.ts";
import { executeProof } from "./backend.ts";
import { AdminError, type RuntimeQuery } from "./protocol.ts";

const initial = { HOME: process.env.HOME, DORI_POLICY_DIR: process.env.DORI_POLICY_DIR,
  DORI_STATE_DIR: process.env.DORI_STATE_DIR, DORI_DISCORD_TOKEN: process.env.DORI_DISCORD_TOKEN, PATH: process.env.PATH };
const realFetch = globalThis.fetch;
const directories: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(initial)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "helio-admin-runtime-"));
  directories.push(home);
  const state = join(home, "state"), directory = join(home, "policy");
  const scripts = join(home, ".dori/elobot/vendor/dori-mode/scripts");
  mkdirSync(scripts, { recursive: true });
  symlinkSync(new URL("../../vendor/dori-mode/scripts/src", import.meta.url), join(scripts, "src"), "dir");
  mkdirSync(join(directory, "requests"), { recursive: true });
  process.env.HOME = home;
  process.env.DORI_POLICY_DIR = directory;
  process.env.DORI_STATE_DIR = state;
  process.env.DORI_DISCORD_TOKEN = "offline-fixture";
  const publish = (trusted = "11111", revision = "a".repeat(64), values: Readonly<Record<string, string>> = {}) => writeFileSync(join(directory, "policy.json"), JSON.stringify({
    version: 1, revision, values: {
      DORI_DISCORD_OWNER_ID: "22222", HELIO_ADMIN_GUILD: "99999", HELIO_TRUSTED_USERS: trusted,
      DORI_DISCORD_ALLOWED: "44444,55555", DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "44444,55555",
      DORI_DISCORD_IGNORED_CHANNELS: "", HELIO_REPORT_CHANNELS: "",
      HELIO_CONVERSATION_NUDGE_HOURS: "24", HELIO_CONVERSATION_TIMEOUT_HOURS: "72",
      ...values,
    }, timing: [{ key: "HELIO_CONVERSATION_TIMEOUT_HOURS", label: "Conversation timeout", unit: "hours", minimum: 1, maximum: 99999 }],
  }));
  publish();
  const proof = (query: RuntimeQuery, operation = "operation-one", actor = "11111") => {
    const nonce = "a".repeat(32);
    writeFileSync(join(directory, "requests", `${nonce}.json`), JSON.stringify({
      id: nonce, actor, guild: "99999", operation, policy_revision: "a".repeat(64),
      expires_at: Date.now() + 30_000, query,
    }));
    return nonce;
  };
  return { home, state, directory, publish, proof };
}

function guildFixture(visible: boolean, privateThreadMember?: boolean): void {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    switch (path) {
      case "/channels/44444":
        return Response.json({ id: "44444", guild_id: "99999", type: privateThreadMember === undefined ? 0 : 12,
          parent_id: privateThreadMember === undefined ? "88888" : "55555", name: "Incident room",
          permission_overwrites: visible ? [] : [{ id: "99999", type: 0, allow: "0", deny: "66560" }] });
      case "/channels/55555":
        return Response.json({ id: "55555", guild_id: "99999", type: 0, parent_id: "88888" });
      case "/channels/44444/thread-members/11111":
        return privateThreadMember ? Response.json({ user_id: "11111" }) : Response.json({ message: "Unknown member" }, { status: 404 });
      case "/channels/88888":
        return Response.json({ id: "88888", guild_id: "99999", type: 4, name: "Category" });
      case "/guilds/99999/members/11111":
      case "/guilds/99999/members/22222": return Response.json({ roles: [] });
      case "/guilds/99999/roles": return Response.json([{ id: "99999", permissions: "66560" }]);
      case "/guilds/99999": return Response.json({ owner_id: "22222" });
      default: throw new Error(`Unexpected offline request: ${path}`);
    }
  }, { preconnect: realFetch.preconnect }));
}

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
