import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallError, discordCall, expireNow, handleInteraction, parseInteraction, sweep, type Deps } from "./handler.ts";
import { LAPSE_MS, PromptStore, QuestionStore, CONFIRM_TTL_MS } from "./store.ts";
import * as interactions from "./handler.ts";
import { carriedOut, mergedOnGitHub } from "./satisfaction.ts";
import { lapseNotice, planButtons, subjects } from "./text.ts";

const OWNER = "99", TRUSTED = "77", STRANGER = "66", PROMPT_MESSAGE = "500", QUESTION_MESSAGE = "600";
const SHA = "9f45e57" + "a".repeat(33);
let dir: string, prompts: PromptStore, now: number, lines: string[], warnings: string[], calls: { method: string; path: string; body: any }[];
let replies: Array<[RegExp, (body: any) => unknown]>;
let sequence = 1000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "helio-interactive-"));
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  now = Date.parse("2026-11-04T12:00:00Z");
  lines = []; warnings = []; calls = []; replies = [];
});
afterEach(async () => { prompts.close(); await rm(dir, { recursive: true, force: true }); });

const deps = (): Deps => ({
  prompts, questions: () => QuestionStore.open(join(dir, "discord-questions.sqlite"), 50), ownerId: OWNER,
  trusted: () => new Set([TRUSTED]), now: () => now, emit: (line) => lines.push(line), warn: (text) => warnings.push(text),
  call: async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [pattern, reply] of replies) if (pattern.test(`${method} ${path}`)) return reply(body);
    if (/^\/users\/\d+$/.test(path)) return { username: `User ${path.slice(7)}` };
    if (path.includes("/callback")) return { resource: { message: { id: "700" } } };
    return undefined;
  },
});

function prompt(kind: "confirm" | "plan" = "confirm", action = "merge"): string {
  const id = (sequence++).toString(16).padStart(20, "0");
  const target = action === "restart" ? "elobot" : "o/r#6";
  const content = kind === "plan" ? "📋 Plan for #6 (r2): shorter window" : "Merge #6 · `9f45e57`?";
  prompts.create({ id, kind, action: kind === "plan" ? "plan" : action, target, revision: kind === "plan" ? "2" : SHA, content, channel_id: "100", now });
  prompts.sent(id, PROMPT_MESSAGE, now);
  return id;
}

function event(customId: string, user: string, extra: Record<string, unknown> = {}) {
  return {
    type: 3, id: String(sequence++), application_id: "88", token: "tok", channel_id: "100", guild_id: "300",
    member: { user: { id: user, username: `User ${user}` } }, message: { id: PROMPT_MESSAGE }, data: { custom_id: customId }, ...extra,
  };
}
const callbacks = () => calls.filter((call) => call.path.includes("/callback")).map((call) => call.body);

const CLAIM = { app: "88", token: "tok", accept: true, expected: "✅ shown" };
const PLAN_LATE = 60 * 60_000;

test("existing prompt databases upgrade before a click needs the durable recovery columns", () => {
  const id = prompt();
  prompts.close();
  const old = new Database(join(dir, "discord-prompts.sqlite"));
  try {
    for (const name of ["pending_app", "pending_token", "pending_accept", "pending_expected"]) old.exec(`ALTER TABLE prompts DROP COLUMN ${name}`);
    old.exec("PRAGMA user_version=1");
  } finally { old.close(); }
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  expect(prompts.begin(id, OWNER, now, CLAIM)).toBeUndefined();
  expect(prompts.finish(id, OWNER, "confirmed", now, "700", false)).toBe(true);
});


test("parsing accepts guild and DM clickers and rejects foreign, mismatched or malformed IDs", () => {
  const id = "0".repeat(20);
  expect(parseInteraction(event(`h1:c:${id}:confirm`, OWNER))?.userId).toBe(OWNER);
  expect(parseInteraction({ ...event(`h1:c:${id}:confirm`, OWNER), member: undefined, user: { id: TRUSTED } })?.userId).toBe(TRUSTED);
  for (const bad of [`h1:c:${id}:pick`, `h1:x:${id}:confirm`, `h1:c:short:confirm`, "other-bot-button"]) {
    expect(parseInteraction(event(bad, OWNER))).toBeUndefined();
  }
  expect(parseInteraction(event(`h1:qm:${id}:other`, OWNER))).toBeUndefined();
  expect(parseInteraction({ ...event(`h1:c:${id}:confirm`, OWNER), type: 5 })).toBeUndefined();
});


test("clicks in the shape agent-messenger emits are understood", () => {
  const id = "0".repeat(20);
  const named = { type: "INTERACTION_CREATE" };
  expect(parseInteraction({ ...event(`h1:c:${id}:confirm`, OWNER), ...named, data: { custom_id: `h1:c:${id}:confirm`, component_type: 2 } }))
    .toMatchObject({ type: 3, verb: "confirm" });
  expect(parseInteraction({ ...event(`h1:qm:${id}:other`, OWNER), ...named, data: { custom_id: `h1:qm:${id}:other`,
    components: [{ type: 18, component: { type: 4, custom_id: "text", value: "typed" } }] } })).toMatchObject({ type: 5, kind: "qm" });
  expect(parseInteraction({ ...event(`h1:c:${id}:confirm`, OWNER), ...named, data: { custom_id: `h1:c:${id}:confirm` } })).toBeUndefined();
});


test("only the owner or trusted users can decide; others get a private notice and nothing changes", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, STRANGER), deps());
  expect(callbacks()).toEqual([{ type: 4, data: { content: `This one's for **[Owner](<https://discord.com/users/${OWNER}>)**.`, flags: 64, allowed_mentions: { parse: [] } } }]);
  expect(prompts.get(id)?.status).toBe("open");
});


test("a confirm posts the public proof, records its message and removes the buttons", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, TRUSTED), deps());
  expect(callbacks()[0]).toEqual({ type: 4, data: { content: `✅ **[User ${TRUSTED}](<https://discord.com/users/${TRUSTED}>)** confirmed merge [PR #6](<https://github.com/o/r/pull/6>) · \`9f45e57\``, allowed_mentions: { parse: [] } } });
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", decided_by: TRUSTED, result_message_id: "700", cleared_at: now });
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: `/channels/100/messages/${PROMPT_MESSAGE}`, body: { components: [] } });
  expect(JSON.parse(lines[0]!.slice("INBOUND_CONFIRM ".length))).toMatchObject({ id, outcome: "confirmed", by: TRUSTED, result_message_id: "700" });
});


test("a second click while one is in flight, or after a decision, cannot change it", async () => {
  const id = prompt();
  expect(prompts.begin(id, OWNER, now, CLAIM)).toBeUndefined();
  await handleInteraction(event(`h1:c:${id}:cancel`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe("Someone is answering this.");
  prompts.finish(id, OWNER, "confirmed", now, "700", true);
  await handleInteraction(event(`h1:c:${id}:cancel`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe(`Already answered by **[Previous responder](<https://discord.com/users/${OWNER}>)**.`);
  expect(prompts.get(id)?.status).toBe("confirmed");
});


test("cancel edits the prompt in place and creates no proof message", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:cancel`, OWNER), deps());
  expect(callbacks()).toEqual([{ type: 7, data: {
    content: `Merge #6 · \`9f45e57\`?\n❌ Cancelled by **[User ${OWNER}](<https://discord.com/users/${OWNER}>)**`, components: [], allowed_mentions: { parse: [] } } }]);
  expect(prompts.get(id)).toMatchObject({ status: "cancelled", result_message_id: null, cleared_at: now });
});


test("expiry refuses late clicks, removes buttons once and survives a store reopen", async () => {
  const id = prompt();
  now += CONFIRM_TTL_MS;
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(callbacks().at(-1)?.data.content).toBe("This has expired.");
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  await sweep(deps());
  expect(prompts.get(id)).toMatchObject({ status: "expired", cleared_at: now });
  expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { content: "Merge #6 · `9f45e57`?\n⌛ Expired", components: [] } });
  expect(JSON.parse(lines[0]!.slice("INBOUND_CONFIRM ".length)).outcome).toBe("expired");
  calls = [];
  await sweep(deps());
  expect(calls).toEqual([]);
});


test("an unused confirmation lapses with one notice and can no longer be used", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  now += LAPSE_MS;
  expect(prompts.use(id, now)).toBe(false);
  await sweep(deps());
  await sweep(deps());
  const notices = calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages");
  expect(notices).toHaveLength(1);
  expect(notices[0]?.body).toMatchObject({ content: lapseNotice("merge", "o/r#6", SHA), nonce: `l${id}`, enforce_nonce: true,
    message_reference: { message_id: "700" } });
  expect(notices[0]?.body.content).toStartWith("⌛ Merge [PR #6]");
  expect(prompts.get(id)?.status).toBe("lapsed");
});


test("re-asking the same PR at a new head retires the older confirmation, so it never lapses into a notice", async () => {
  // 2026-11-13: PRs #20, #22 and #26 were re-asked per head; the earlier confirmations lapsed overnight into five
  // "Not done in time" notices for PRs that had merged.
  const older = prompt();
  await handleInteraction(event(`h1:c:${older}:confirm`, OWNER), deps());
  const newer = prompt();
  expect(prompts.supersede(prompts.get(newer)!)).toBe(1);
  await handleInteraction(event(`h1:c:${newer}:confirm`, OWNER), deps());
  expect(prompts.use(newer, now)).toBe(true);
  now += LAPSE_MS;
  await sweep(deps());
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toEqual([]);
  expect(prompts.get(older)?.status).toBe("superseded");
});


test("using an approval retires an older confirmed sibling, and a use that bypassed the store still prevents the lapse", async () => {
  const first = prompt(), second = prompt(), third = prompt();
  for (const id of [first, second, third]) await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  now += 60_000;
  expect(prompts.use(second, now)).toBe(true);
  expect(prompts.get(first)?.status).toBe("superseded");
  const raw = new Database(join(dir, "discord-prompts.sqlite"));  // helio-plan.py marks prompts used with plain SQL
  try { raw.query("UPDATE prompts SET status='confirmed', used_at=NULL WHERE id=?").run(first); } finally { raw.close(); }
  now += LAPSE_MS;
  await sweep(deps());
  expect([prompts.get(first)?.status, prompts.get(third)?.status]).toEqual(["superseded", "superseded"]);
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toEqual([]);
});


test("a lapsed approval whose PR already merged on GitHub is closed without a notice", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  now += LAPSE_MS;
  const merged = { ...deps(), carriedOut: (row: { target: string }) => mergedOnGitHub(row as never, async (pr) =>
    pr === "o/r#6" ? "MERGED" : "OPEN") };
  await sweep(merged);
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toEqual([]);
  expect(prompts.get(id)?.notice_at).toBe(now);
  const restart = prompt("confirm", "restart");
  await handleInteraction(event(`h1:c:${restart}:confirm`, OWNER), deps());
  now += LAPSE_MS;
  await sweep({ ...deps(), carriedOut: async () => false });  // GitHub alone cannot prove a restart
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(1);
});


test("every prompt names its subjects; a train covers each member and, with a restart, the service", () => {
  expect(subjects("confirm", "merge", "o/r#6")).toEqual(["pr:o/r#6"]);
  expect(subjects("confirm", "train-restart", "o/r#18,20")).toEqual(["pr:o/r#18", "pr:o/r#20", "service:elobot"]);
  expect(subjects("confirm", "restart", "elobot")).toEqual(["service:elobot"]);
  expect(subjects("plan", "plan", "o/r#6")).toEqual(["plan:o/r#6"]);
  expect(() => subjects("confirm", "deploy", "x")).toThrow("no subjects for action deploy");
});

test("satisfaction proves each action and every part of a merge-and-restart train", async () => {
  const row = prompts.get(prompt());
  if (!row) throw new Error("missing fixture prompt");
  const checks = {
    prState: async () => "MERGED",
    opened: async (_repo: string, issue: number, revision: string) => issue === 6 && revision === SHA,
    running: async () => SHA,
    trainTip: () => SHA,
  };
  for (const action of ["merge", "train", "train-restart", "pr", "restart"]) {
    expect(await carriedOut({ ...row, action }, checks)).toBe(true);
  }
  expect(await carriedOut({ ...row, action: "pr", revision: "a".repeat(40) }, checks)).toBe(false);
  expect(await carriedOut({ ...row, action: "restart", revision: "a".repeat(40) }, checks)).toBe(false);
  expect(await carriedOut({ ...row, action: "train-restart" }, { ...checks, running: async () => undefined })).toBe(false);
  expect(await carriedOut({ ...row, action: "train" }, { ...checks, prState: async () => "OPEN" })).toBe(false);
});

test("using one PR approval cannot retire or satisfy a train that also owes another PR", async () => {
  const train = prompts.get(prompt());
  const single = prompts.get(prompt());
  if (!train || !single) throw new Error("missing fixture prompts");
  const db = new Database(join(dir, "discord-prompts.sqlite"));
  try {
    db.query("UPDATE prompts SET action='train',target='o/r#6,7' WHERE id=?").run(train.id);
    const full = prompts.get(train.id);
    if (!full) throw new Error("missing train");
    expect(prompts.supersede(single)).toBe(0);
    now += 60_000;
    await handleInteraction(event(`h1:c:${single.id}:confirm`, OWNER), deps());
    expect(prompts.use(single.id, now)).toBe(true);
    expect(prompts.satisfied(full)).toBe(false);
    expect(prompts.get(train.id)?.status).toBe("open");
  } finally { db.close(); }
});


test("the exact timer targets the next expiry or lapse", async () => {
  expect(prompts.nextDeadline()).toBeUndefined();
  const first = prompt();
  now += 60_000;
  const second = prompt();
  expect(prompts.nextDeadline()).toBe(prompts.get(first)!.expires_at);
  await handleInteraction(event(`h1:c:${first}:confirm`, OWNER), deps());
  expect(prompts.nextDeadline()).toBe(Math.min(prompts.get(first)!.decided_at! + LAPSE_MS, prompts.get(second)!.expires_at));
});


test("a click on another message's buttons or a plan button on a confirmation is refused", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER, { message: { id: "999" } }), deps());
  await handleInteraction(event(`h1:p:${id}:approve`, OWNER), deps());
  expect(callbacks().map((body) => body.data.content)).toEqual(["This is no longer active.", "This is no longer active."]);
  expect(prompts.get(id)?.status).toBe("open");
});


test.each(["merge", "restart"])("%s prompts accept at eleven hours and expire at twelve", async (action) => {
  const early = prompt("confirm", action), late = prompt("confirm", action);
  now += 11 * 3_600_000;
  await handleInteraction(event(`h1:c:${early}:confirm`, OWNER), deps());
  expect(prompts.get(early)?.status).toBe("confirmed");
  now += 3_600_000;
  await handleInteraction(event(`h1:c:${late}:confirm`, OWNER), deps());
  expect(callbacks().at(-1)?.data.content).toBe("This has expired.");
  expireNow(deps());
  expect(prompts.get(late)?.status).toBe("expired");
});


test("plan replies save feedback with reply message identity and emit the existing monitor contract", () => {
  const pid = prompt("plan");
  const reply = { message_id: "802", channel_id: "100", author_id: TRUSTED, role: "TRUSTED_REQUEST",
    scope: "trusted-pr-merge-restart", content: "keep 24h", reply_to: PROMPT_MESSAGE };
  interactions.handlePlanReply(reply, deps());
  interactions.handlePlanReply(reply, deps());
  const feedback = prompts.feedback(pid);
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toMatchObject({ user_id: TRUSTED, text: "keep 24h", message_id: "802" });
  expect(lines.map((line) => JSON.parse(line.slice("INBOUND_PLAN_FEEDBACK ".length)))).toEqual([{
    id: pid, target: "o/r#6", revision: "2", feedback: feedback[0]?.id, by: TRUSTED, preview: "keep 24h",
    read: `helio confirm feedback ${pid}`,
  }]);
  expect(planButtons(pid)[0]?.components.map((button) => button.label)).toEqual(["Approve", "Cancel"]);
});


test.each([
  { author_id: STRANGER }, { channel_id: "101" }, { reply_to: "501" }, { role: "BOT_BUG_REPORT" },
])("plan feedback rejects unauthorized or unrelated replies: %j", (change) => {
  const pid = prompt("plan");
  interactions.handlePlanReply({ message_id: "802", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
    scope: "may-request-work", content: "change it", reply_to: PROMPT_MESSAGE, ...change }, deps());
  expect(prompts.feedback(pid)).toEqual([]);
  expect(lines).toEqual([]);
});


test("plan approval and cancellation retain their public decision behavior", async () => {
  const approved = prompt("plan");
  await handleInteraction(event(`h1:p:${approved}:approve`, OWNER), deps());
  expect(callbacks().at(-1)?.data.content).toBe(`✅ **[User ${OWNER}](<https://discord.com/users/${OWNER}>)** approved the plan for [Issue #6](<https://github.com/o/r/issues/6>) (r2)`);
  expect(prompts.use(approved, now + PLAN_LATE)).toBe(true);
  const cancelled = prompt("plan");
  await handleInteraction(event(`h1:p:${cancelled}:cancel`, TRUSTED), deps());
  expect(prompts.get(cancelled)?.status).toBe("cancelled");
});
