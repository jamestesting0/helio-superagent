import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallError, discordCall, expireNow, handleInteraction, parseInteraction, sweep, type Deps } from "./handler.ts";
import { Delivery } from "../delivery/delivery.ts";
import { LAPSE_MS, PromptStore, QuestionStore, CONFIRM_TTL_MS, DRAFT_TTL_MS } from "./store.ts";
import { recordAnswer } from "../conversations/question-answer.ts";

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
    member: { user: { id: user } }, message: { id: PROMPT_MESSAGE }, data: { custom_id: customId }, ...extra,
  };
}
const callbacks = () => calls.filter((call) => call.path.includes("/callback")).map((call) => call.body);

test("existing prompt databases upgrade before a click needs the durable recovery columns", () => {
  const id = prompt();
  prompts.close();
  const old = new Database(join(dir, "discord-prompts.sqlite"));
  try {
    for (const name of ["pending_app", "pending_token", "pending_accept", "pending_expected"]) old.exec(`ALTER TABLE prompts DROP COLUMN ${name}`);
    for (const name of ["app_id", "token"]) old.exec(`ALTER TABLE drafts DROP COLUMN ${name}`);
    old.exec("PRAGMA user_version=1");
  } finally { old.close(); }
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  expect(prompts.begin(id, OWNER, now, CLAIM)).toBeUndefined();
  const draft = prompts.putDraft("q", OWNER, null, "answer", now);
  prompts.claimDraft(draft, "88", "token");
  expect(prompts.draft(draft)?.token).toBe("token");
  expect(prompts.finish(id, OWNER, "confirmed", now, "700", false)).toBe(true);
});

test("legacy pending decisions without recovery data expire and cannot accept an opposite click", async () => {
  const id = prompt();
  prompts.db.query("UPDATE prompts SET status='pending',pending_by=?,pending_at=? WHERE id=?").run(OWNER, now, id);
  prompts.close();
  const old = new Database(join(dir, "discord-prompts.sqlite"));
  try {
    for (const name of ["pending_app", "pending_token", "pending_accept", "pending_expected"]) old.exec(`ALTER TABLE prompts DROP COLUMN ${name}`);
    for (const name of ["app_id", "token"]) old.exec(`ALTER TABLE drafts DROP COLUMN ${name}`);
    old.exec("PRAGMA user_version=1");
  } finally { old.close(); }
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  now += 60_000;
  await sweep(deps());
  await handleInteraction(event(`h1:c:${id}:cancel`, TRUSTED), deps());
  expect(prompts.get(id)).toMatchObject({ status: "expired", decided_by: null, result_message_id: null });
  expect(callbacks().some((body) => body.data?.content?.includes("Cancelled by"))).toBe(false);
  expect(lines.some((line) => line.includes('"outcome":"cancelled"'))).toBe(false);
});

test("callback transport failures preserve uncertainty without exposing interaction tokens", async () => {
  const secret = "private-interaction-token";
  const path = `/interactions/1/${secret}/callback?with_response=true`;
  const fetch = spyOn(globalThis, "fetch");
  try {
    const responses = [
      new Response(new ReadableStream({ start(controller) { controller.error(new Error(`body lost ${secret}`)); } })),
      new Response("{"),
    ];
    for (const response of responses) {
      fetch.mockResolvedValueOnce(response);
      const error: unknown = await discordCall("bot")("POST", path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CallError);
      if (!(error instanceof CallError)) throw new Error("expected an uncertain callback error");
      expect(error.status).toBeUndefined();
      expect(error.message).not.toContain(secret);
    }
    fetch.mockResolvedValueOnce(Response.json({ message: "unknown interaction" }, { status: 400 }));
    const error: unknown = await discordCall("bot")("POST", path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CallError);
    if (!(error instanceof CallError)) throw new Error("expected a callback refusal");
    expect(error.status).toBe(400);
    expect(error.message).not.toContain(secret);
  } finally { fetch.mockRestore(); }
});

test("a server error after an accepted callback is reconciled before releasing the claim", async () => {
  const id = prompt();
  replies = [[/callback/, () => { throw new CallError(503, "server error"); }],
    [/@original/, () => ({ id: "701", content: `✅ <@${OWNER}> confirmed merge #6 · \`9f45e57\`` })]];
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", result_message_id: "701" });
});

function question(options: string[] | null = ["8 hours", "12 hours"], audience = "staff"): string {
  const path = join(dir, "discord-questions.sqlite");
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, lane TEXT NOT NULL,
    audience TEXT NOT NULL, recipient TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, channel_id TEXT,
    message_id TEXT, answer_id TEXT, answer_author TEXT, answer_role TEXT, answer_scope TEXT, answer_text TEXT,
    error TEXT, updated INTEGER NOT NULL, options TEXT, components TEXT, answer_source TEXT, announced_at INTEGER,
    cleared_at INTEGER, pending_by TEXT, pending_at INTEGER)`);
  const id = (sequence++).toString(16).padStart(20, "0");
  db.query(`INSERT INTO questions (id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated,options,components)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, "lead", audience, audience === "thread" ? TRUSTED : "1", "How long?",
    "awaiting_answer", "100", QUESTION_MESSAGE, now, options && JSON.stringify(options), JSON.stringify([{ type: 1, components: [] }]));
  db.close();
  return id;
}
const questionRow = (id: string) => {
  const store = QuestionStore.open(join(dir, "discord-questions.sqlite"), 50)!;
  try { return store.get(id)!; } finally { store.close(); }
};
const CLAIM = { app: "88", token: "tok", accept: true, expected: "✅ shown" };
const draftFrom = (body: any): string => /^h1:d:([0-9a-f]{20}):submit$/.exec(body.components[0].components[0].custom_id)![1]!;

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
    components: [{ type: 18, component: { type: 4, custom_id: "text", value: "typed" } }] } })).toMatchObject({ type: 5, text: "typed" });
  expect(parseInteraction({ ...event(`h1:c:${id}:confirm`, OWNER), ...named, data: { custom_id: `h1:c:${id}:confirm` } })).toBeUndefined();
});

test("an outcome Discord cannot confirm survives a watcher restart and settles from Discord's record", async () => {
  const ids = [prompt(), prompt(), prompt()];
  const [first, second, third] = ids;
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  for (const [index, id] of ids.entries()) await handleInteraction(event(`h1:c:${id}:confirm`, OWNER, { token: `t${index}` }), deps());
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  now += 60_000;
  await sweep(deps());
  expect(ids.map((id) => prompts.get(id)?.status)).toEqual(["pending", "pending", "pending"]);
  replies = [];
  await handleInteraction(event(`h1:c:${first}:cancel`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe("Someone is answering this.");
  replies = [
    [/\/t0\/messages\/@original/, () => ({ id: "702", content: `✅ <@${OWNER}> confirmed merge #6 · \`9f45e57\`` })],
    [/\/t1\/messages\/@original/, () => { throw new CallError(404, "unknown message"); }],
    [/@original/, () => { throw new CallError(undefined, "timeout"); }],
  ];
  await sweep(deps());
  expect(prompts.get(first)).toMatchObject({ status: "confirmed", result_message_id: "702", pending_token: null });
  expect(prompts.get(second)?.status).toBe("open");
  expect(prompts.get(third)?.status).toBe("pending");
  now += 14 * 60_000;
  await sweep(deps());
  expect(prompts.get(third)?.status).toBe("expired");
  const outcomes = lines.filter((line) => line.startsWith("INBOUND_CONFIRM ")).map((line) => JSON.parse(line.slice(16)));
  expect(outcomes.filter((row) => row.outcome !== "expired" || row.id === third).map((row) => [row.id, row.outcome]))
    .toEqual([[first, "confirmed"], [third, "expired"]]);
});

test("only the owner or trusted users can decide; others get a private notice and nothing changes", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, STRANGER), deps());
  expect(callbacks()).toEqual([{ type: 4, data: { content: `This one's for <@${OWNER}>.`, flags: 64, allowed_mentions: { parse: [] } } }]);
  expect(prompts.get(id)?.status).toBe("open");
});

test("a confirm posts the public proof, records its message and removes the buttons", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, TRUSTED), deps());
  expect(callbacks()[0]).toEqual({ type: 4, data: { content: `✅ <@${TRUSTED}> confirmed merge #6 · \`9f45e57\``, allowed_mentions: { parse: [] } } });
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", decided_by: TRUSTED, result_message_id: "700", cleared_at: now });
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: `/channels/100/messages/${PROMPT_MESSAGE}`, body: { components: [] } });
  expect(JSON.parse(lines[0]!.slice("INBOUND_CONFIRM ".length))).toMatchObject({ id, outcome: "confirmed", by: TRUSTED, result_message_id: "700" });
});

test("a refused callback reverts; an unknown outcome is settled by Discord's stored response", async () => {
  const id = prompt();
  replies.push([/callback/, () => { throw new CallError(400, "invalid token"); }]);
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(prompts.get(id)?.status).toBe("open");
  expect(lines).toEqual([]);

  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(404, "none"); }]];
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(prompts.get(id)?.status).toBe("open");

  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }],
    [/@original/, () => ({ id: "701", content: `✅ <@${OWNER}> confirmed merge #6 · \`9f45e57\`` })]];
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", result_message_id: "701" });
});

test("a second click while one is in flight, or after a decision, cannot change it", async () => {
  const id = prompt();
  expect(prompts.begin(id, OWNER, now, CLAIM)).toBeUndefined();
  await handleInteraction(event(`h1:c:${id}:cancel`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe("Someone is answering this.");
  prompts.finish(id, OWNER, "confirmed", now, "700", true);
  await handleInteraction(event(`h1:c:${id}:cancel`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe(`Already answered by <@${OWNER}>.`);
  expect(prompts.get(id)?.status).toBe("confirmed");
});

test("cancel edits the prompt in place and creates no proof message", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:cancel`, OWNER), deps());
  expect(callbacks()).toEqual([{ type: 7, data: {
    content: `Merge #6 · \`9f45e57\`?\n❌ Cancelled by <@${OWNER}>`, components: [], allowed_mentions: { parse: [] } } }]);
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
  expect(notices[0]?.body).toMatchObject({ content: "⌛ Not done in time. Ask again.", nonce: `l${id}`, enforce_nonce: true,
    message_reference: { message_id: "700" } });
  expect(prompts.get(id)?.status).toBe("lapsed");
});

test("failed edits are retried later; a deleted message counts as cleared", async () => {
  const id = prompt();
  prompts.cancel(id);
  replies.push([/PATCH/, () => { throw new CallError(403, "missing access"); }]);
  await sweep(deps());
  await sweep(deps());
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  expect(warnings).toHaveLength(1);
  now += 10 * 60_000;
  replies = [[/PATCH/, () => { throw new CallError(404, "unknown message"); }]];
  await sweep(deps());
  expect(prompts.get(id)?.cleared_at).toBe(now);
});

test("a stale in-flight claim is released for the next click", async () => {
  const id = prompt();
  prompts.begin(id, OWNER, now, CLAIM);
  now += 30_000;
  await sweep(deps());
  expect(prompts.get(id)?.status).toBe("open");
});

test("a locked database gives a private busy notice instead of missing Discord's deadline", async () => {
  const id = prompt();
  const holder = new Database(join(dir, "discord-prompts.sqlite"));
  holder.exec("BEGIN IMMEDIATE");
  try {
    await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
    expect(callbacks().at(-1)?.data.content).toBe("Busy, try again.");
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  expect(prompts.get(id)?.status).toBe("open");
});

test("a decision already shown is still recorded when the database is briefly locked", async () => {
  const id = prompt();
  const holder = new Database(join(dir, "discord-prompts.sqlite"));
  replies.push([/callback/, () => { holder.exec("BEGIN IMMEDIATE"); setTimeout(() => holder.exec("ROLLBACK"), 250); return { resource: { message: { id: "700" } } }; }]);
  try { await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps()); }
  finally { holder.close(); }
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", result_message_id: "700" });
});

test("picking an option resets the menu, reviews privately, and submitting answers once publicly", async () => {
  const qid = question();
  await handleInteraction(event(`h1:q:${qid}:pick`, TRUSTED, { message: { id: QUESTION_MESSAGE }, data: { custom_id: `h1:q:${qid}:pick`, values: ["1"] } }), deps());
  expect(callbacks()[0]).toEqual({ type: 7, data: { components: [{ type: 1, components: [] }] } });
  const review = calls.find((call) => call.path === "/webhooks/88/tok")!.body;
  expect(review).toMatchObject({ content: "**12 hours**", flags: 64 });
  const draft = draftFrom(review);
  await handleInteraction(event(`h1:d:${draft}:submit`, TRUSTED), deps());
  expect(callbacks().at(-1)).toEqual({ type: 7, data: { content: "Sent ✓", components: [], allowed_mentions: { parse: [] } } });
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_author: TRUSTED, answer_text: "12 hours", answer_source: "component", announced_at: now, cleared_at: now });
  expect(calls.find((call) => call.method === "POST" && call.path === "/channels/100/messages")?.body).toMatchObject({
    content: `<@${TRUSTED}>: 12 hours`, nonce: `a${qid}`, enforce_nonce: true, message_reference: { message_id: QUESTION_MESSAGE } });
  expect(prompts.draft(draft)).toBeUndefined();
});

test("two people submitting at once record exactly one answer", async () => {
  const qid = question();
  const first = prompts.putDraft(qid, OWNER, 0, "8 hours", now), second = prompts.putDraft(qid, TRUSTED, 1, "12 hours", now);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  replies.push([new RegExp(`callback`), async () => { await gate; return {}; }]);
  const slow = handleInteraction(event(`h1:d:${first}:submit`, OWNER), deps());
  replies = [];
  await handleInteraction(event(`h1:d:${second}:submit`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe("Someone is answering this.");
  release();
  await slow;
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_author: OWNER, answer_text: "8 hours" });
});

test("an answer shown as sent but closed meanwhile is reported privately, not lost silently", async () => {
  const qid = question();
  const draft = prompts.putDraft(qid, OWNER, 0, "8 hours", now);
  replies.push([/callback/, () => {
    const db = new Database(join(dir, "discord-questions.sqlite"));
    try { db.query("UPDATE questions SET status='cancelled' WHERE id=?").run(qid); } finally { db.close(); }
    return {};
  }]);
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER), deps());
  expect(calls.find((call) => call.path === "/webhooks/88/tok")?.body).toMatchObject({
    content: "This question was closed before your answer was saved.", flags: 64 });
  expect(questionRow(qid).answer_text).toBeNull();
});

test("a typed reply cannot overwrite an answer that is being submitted by click", () => {
  const qid = question();
  const store = QuestionStore.open(join(dir, "discord-questions.sqlite"), 50)!;
  try { expect(store.begin(qid, OWNER, now)).toBeUndefined(); } finally { store.close(); }
  expect(recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
    scope: "may-request-work", content: "typed", reply_to: QUESTION_MESSAGE })).toBeUndefined();
});

test("drafts belong to one person, expire, and fail when the options changed", async () => {
  const qid = question();
  const mine = prompts.putDraft(qid, OWNER, 0, "8 hours", now);
  await handleInteraction(event(`h1:d:${mine}:submit`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe("This is no longer active.");
  const stale = prompts.putDraft(qid, TRUSTED, 0, "8 hours", now);
  now += DRAFT_TTL_MS;
  await handleInteraction(event(`h1:d:${stale}:submit`, TRUSTED), deps());
  expect(callbacks().at(-1)?.data.content).toBe("This has expired.");
  const changed = prompts.putDraft(qid, OWNER, 0, "6 hours", now);
  await handleInteraction(event(`h1:d:${changed}:submit`, OWNER), deps());
  expect(callbacks().at(-1)?.data.content).toBe("This is no longer active.");
  expect(questionRow(qid).status).toBe("awaiting_answer");
});

const typed = (qid: string, value: string, token = "tok") => ({
  ...event(`h1:qm:${qid}:other`, OWNER, { message: { id: QUESTION_MESSAGE }, token }), type: 5,
  data: { custom_id: `h1:qm:${qid}:other`, components: [{ type: 18, component: { type: 4, custom_id: "text", value } }] },
});

test("Other opens a form whose Submit records the answer without a second review", async () => {
  const qid = question();
  await handleInteraction(event(`h1:q:${qid}:other`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(callbacks()[0]).toMatchObject({ type: 9, data: { custom_id: `h1:qm:${qid}:other`, title: "Your answer" } });
  await handleInteraction(typed(qid, " 10 *hours* "), deps());
  expect(callbacks().at(-1)).toMatchObject({ type: 4, data: { content: "Sent ✓", flags: 64 } });
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_author: OWNER, answer_text: "10 *hours*" });
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages").at(-1)?.body.content)
    .toBe(`<@${OWNER}>: 10 *hours*`);
});

test("an open question's Answer button opens the form that records the answer", async () => {
  const qid = question([]);
  await handleInteraction(event(`h1:q:${qid}:other`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(callbacks()[0]).toMatchObject({ type: 9, data: { custom_id: `h1:qm:${qid}:other` } });
  await handleInteraction(typed(qid, "soon"), deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_text: "soon" });
});

test("a typed form answer whose reply was unclear is recorded after a restart, once Discord shows it", async () => {
  const qid = question();
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  await handleInteraction(typed(qid, "tomorrow", "t0"), deps());
  expect(questionRow(qid).status).toBe("answering");
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  now += 60_000;
  replies = [[/\/t0\/messages\/@original/, () => ({ id: "706", content: "Sent ✓" })], [/messages\?after/, () => []]];
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_text: "tomorrow" });
});

test("thread questions accept only their recipient or the owner", async () => {
  const qid = question(["yes", "no"], "thread");
  await handleInteraction(event(`h1:q:${qid}:pick`, STRANGER, { message: { id: QUESTION_MESSAGE }, data: { custom_id: `h1:q:${qid}:pick`, values: ["0"] } }), deps());
  expect(callbacks().at(-1)?.data.content).toBe(`This one's for <@${TRUSTED}>.`);
});

test("a submitted answer whose reply was unclear is recorded after a restart, once Discord shows it", async () => {
  const qid = question();
  const draft = prompts.putDraft(qid, OWNER, 1, "12 hours", now);
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER), deps());
  expect(questionRow(qid).status).toBe("answering");
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  now += 60_000;
  replies = [[/@original/, () => ({ id: "703", content: "Sent ✓" })], [/messages\?after/, () => []]];
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_author: OWNER, answer_text: "12 hours", cleared_at: now });
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(1);
});

test("an answer acknowledged before its public post keeps its text until the post succeeds", async () => {
  const qid = question();
  const draft = prompts.putDraft(qid, OWNER, 0, "8 hours", now);
  replies = [[/POST \/channels\/100\/messages$/, () => { throw new CallError(503, "unavailable"); }], [/messages\?after/, () => []]];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER), deps());
  const db = new Database(join(dir, "discord-questions.sqlite"));
  try { db.query("UPDATE questions SET status='done',question='' WHERE id=?").run(qid); } finally { db.close(); }
  replies = [[/messages\?after/, () => []]];
  now += 10 * 60_000;
  await sweep(deps());
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages").at(-1)?.body.content).toBe(`<@${OWNER}>: 8 hours`);
  expect(questionRow(qid)).toMatchObject({ status: "done", answer_text: null, announced_at: now });
});

test("a public post whose response was lost is found again instead of posted twice", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  now += LAPSE_MS;
  replies = [[/messages\?after/, () => []], [/POST \/channels\/100\/messages$/, () => { throw new CallError(undefined, "response lost"); }]];
  await sweep(deps());
  expect(prompts.get(id)?.notice_at).toBeNull();
  now += 10 * 60_000;
  replies = [[/messages\?after/, () => [{ id: "800", author: { id: "88", bot: true }, content: "⌛ Not done in time. Ask again.", message_reference: { message_id: "700" } }]]];
  await sweep(deps());
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(1);
  expect(prompts.get(id)?.notice_at).toBe(now);
});

test("a withdrawn question visibly says Cancelled and loses its menu", async () => {
  const qid = question();
  const db = new Database(join(dir, "discord-questions.sqlite"));
  try { db.query("UPDATE questions SET status='cancelled',question='' WHERE id=?").run(qid); } finally { db.close(); }
  replies = [[/GET \/channels\/100\/messages\/600/, () => ({ content: "Question [x]\nHow long?\n\nChoose below or reply to this message." })]];
  await sweep(deps());
  expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
    content: "Question [x]\nHow long?\n\nChoose below or reply to this message.\n❌ Cancelled", components: [], allowed_mentions: { parse: [] } });
  expect(questionRow(qid).cleared_at).toBe(now);
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

test("a typed answer gives up a locked question database within a quarter second instead of stalling clicks", () => {
  const qid = question();
  const holder = new Database(join(dir, "discord-questions.sqlite"));
  holder.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  try {
    expect(() => recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
      scope: "may-request-work", content: "typed", reply_to: QUESTION_MESSAGE }, 250)).toThrow();
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  expect(performance.now() - started).toBeLessThan(2000);
  expect(questionRow(qid).status).toBe("awaiting_answer");
});

test("a repeat Submit or Cancel while one is unsettled cannot disturb the winning click's record", async () => {
  const qid = question();
  const draft = prompts.putDraft(qid, OWNER, 1, "12 hours", now);
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER, { token: "t0" }), deps());
  replies = [];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER, { token: "t1" }), deps());
  await handleInteraction(event(`h1:d:${draft}:cancel`, OWNER, { token: "t2" }), deps());
  expect(callbacks().slice(-2).map((body) => [body.type, body.data.flags, body.data.content]))
    .toEqual([[4, 64, "Someone is answering this."], [4, 64, "Someone is answering this."]]);
  expect(prompts.draft(draft)).toMatchObject({ token: "t0" });
  now += 60_000;
  replies = [[/\/t0\/messages\/@original/, () => ({ id: "703", content: "Sent ✓" })], [/messages\?after/, () => []]];
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_text: "12 hours" });
});

test("an expired duplicate click cannot remove an unsettled submit's record", async () => {
  const qid = question();
  const draft = prompts.putDraft(qid, OWNER, 0, "8 hours", now);
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER, { token: "t0" }), deps());
  now += DRAFT_TTL_MS;
  replies = [];
  for (const verb of ["submit", "cancel"]) await handleInteraction(event(`h1:d:${draft}:${verb}`, OWNER, { token: `x${verb}` }), deps());
  expect(callbacks().slice(-2).map((body) => body.data.content)).toEqual(["Someone is answering this.", "Someone is answering this."]);
  expect(prompts.draft(draft)?.token).toBe("t0");
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  replies = [[/\/t0\/messages\/@original/, () => ({ id: "705", content: "Sent ✓" })], [/messages\?after/, () => []]];
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_text: "8 hours" });
});

test("a refused submit leaves no stale record for the retry that succeeds", async () => {
  const qid = question();
  const draft = prompts.putDraft(qid, OWNER, 0, "8 hours", now);
  replies = [[/callback/, () => { throw new CallError(400, "unknown interaction"); }]];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER, { token: "t0" }), deps());
  expect(prompts.draft(draft)?.token).toBeNull();
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  await handleInteraction(event(`h1:d:${draft}:submit`, OWNER, { token: "t1" }), deps());
  expect(prompts.draft(draft)?.token).toBe("t1");
  now += 60_000;
  replies = [[/\/t1\/messages\/@original/, () => ({ id: "704", content: "Sent ✓" })], [/messages\?after/, () => []]];
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_text: "8 hours" });
});

test("expiry runs while a sweep is still waiting on Discord", async () => {
  const held = prompt(), late = prompt();
  replies = [[/callback/, () => { throw new CallError(undefined, "timeout"); }], [/@original/, () => { throw new CallError(undefined, "timeout"); }]];
  await handleInteraction(event(`h1:c:${held}:confirm`, OWNER), deps());
  let release!: () => void;
  replies = [[/@original/, () => new Promise((resolve) => { release = () => resolve({ id: "1", content: "other" }); })]];
  now += CONFIRM_TTL_MS;
  const stuck = sweep(deps());
  expireNow(deps());
  expect(prompts.get(late)?.status).toBe("expired");
  release();
  await stuck;
});

test("an earlier copy beyond the first hundred messages is still found", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  now += LAPSE_MS;
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: String(1000 + i), author: { id: "5" }, content: "chat" }));
  replies = [[/after=700&/, () => filler], [/after=1099&/, () => [{ id: "1200", author: { id: "88", bot: true },
    content: "⌛ Not done in time. Ask again.", message_reference: { message_id: "700" } }]]];
  await sweep(deps());
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(0);
  expect(prompts.get(id)?.notice_at).toBe(now);
});

test("the delivery database gives up a held lock within its short watcher wait", () => {
  const path = join(dir, "discord-delivery.sqlite");
  new Delivery(path).close();
  const holder = new Database(path);
  holder.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  try { expect(() => { const d = new Delivery(path, 250); try { d.stage("inbound", "1", "{}"); } finally { d.close(); } }).toThrow(); }
  finally { holder.exec("ROLLBACK"); holder.close(); }
  expect(performance.now() - started).toBeLessThan(2000);
});

test("plan approval and suggestions are public, recorded and announced", async () => {
  const id = prompt("plan");
  await handleInteraction(event(`h1:p:${id}:suggest`, TRUSTED), deps());
  expect(callbacks()[0]).toMatchObject({ type: 9, data: { custom_id: `h1:pm:${id}:suggest`, title: "Suggested changes" } });
  await handleInteraction({ ...event(`h1:pm:${id}:suggest`, TRUSTED), type: 5,
    data: { custom_id: `h1:pm:${id}:suggest`, components: [{ type: 18, component: { type: 4, custom_id: "text", value: "keep 24h for old matches" } }] } }, deps());
  expect(callbacks().at(-1)?.data.content).toBe(`<@${TRUSTED}> suggested: keep 24h for old matches`);
  expect(prompts.feedback(id).map((row) => row.text)).toEqual(["keep 24h for old matches"]);
  expect(lines[0]).toStartWith("INBOUND_PLAN_FEEDBACK ");
  await handleInteraction(event(`h1:p:${id}:approve`, OWNER), deps());
  expect(callbacks().at(-1)?.data.content).toBe(`✅ <@${OWNER}> approved the plan for #6 (r2)`);
  expect(prompts.get(id)?.status).toBe("confirmed");
  expect(prompts.use(id, now + PLAN_LATE)).toBe(true);
});
const PLAN_LATE = 60 * 60_000;

test("a click on another message's buttons or a plan button on a confirmation is refused", async () => {
  const id = prompt();
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER, { message: { id: "999" } }), deps());
  await handleInteraction(event(`h1:p:${id}:approve`, OWNER), deps());
  expect(callbacks().map((body) => body.data.content)).toEqual(["This is no longer active.", "This is no longer active."]);
  expect(prompts.get(id)?.status).toBe("open");
});
