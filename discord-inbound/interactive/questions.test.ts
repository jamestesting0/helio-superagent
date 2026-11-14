import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallError, discordCall, expireNow, handleInteraction, parseInteraction, sweep, type Deps } from "./handler.ts";
import { LAPSE_MS, PromptStore, QuestionStore, CONFIRM_TTL_MS } from "./store.ts";
import { recordAnswer } from "../conversations/question-answer.ts";

const OWNER = "99", TRUSTED = "77", STRANGER = "66", PROMPT_MESSAGE = "500", QUESTION_MESSAGE = "600";
const SHA = "9f45e57" + "a".repeat(33);
let dir: string, prompts: PromptStore, now: number, lines: string[], warnings: string[], calls: { method: string; path: string; body: any }[];
let replies: Array<[RegExp, (body: any) => unknown]>;
let sequence = 1000;
let restoreClock: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "helio-interactive-"));
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  now = Date.parse("2026-11-04T12:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  lines = []; warnings = []; calls = []; replies = [];
});
afterEach(async () => { restoreClock(); prompts.close(); await rm(dir, { recursive: true, force: true }); });

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

test("thread questions accept only their recipient or the owner", async () => {
  const qid = question(["yes", "no"], "thread");
  await handleInteraction(event(`h1:q:${qid}:o0`, STRANGER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(callbacks().at(-1)?.data.content).toBe(`This one's for **[Recipient](<https://discord.com/users/${TRUSTED}?tab=wishlist>)**.`);
});


test("an answer acknowledged before its public post keeps its text until the post succeeds", async () => {
  const qid = question();
  replies = [[/POST \/channels\/100\/messages$/, () => { throw new CallError(503, "unavailable"); }], [/messages\?after/, () => []]];
  await handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  const db = new Database(join(dir, "discord-questions.sqlite"));
  try { db.query("UPDATE questions SET status='done',question='' WHERE id=?").run(qid); } finally { db.close(); }
  replies = [[/messages\?after/, () => []]];
  now += 10 * 60_000;
  await sweep(deps());
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages").at(-1)?.body.content)
    .toBe(`**[User ${OWNER}](<https://discord.com/users/${OWNER}?tab=wishlist>)**: 8 hours`);
  expect(questionRow(qid)).toMatchObject({ status: "done", answer_text: null, announced_at: now });
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


test("one option tap records the answer and clears buttons without a review", async () => {
  const qid = question();
  await handleInteraction(event(`h1:q:${qid}:o1`, TRUSTED, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_author: TRUSTED, answer_text: "12 hours",
    answer_source: "component", cleared_at: now });
  expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body.components)).toEqual([[]]);
  expect(calls.filter((call) => call.path === "/webhooks/88/tok")).toHaveLength(0);
  expect(recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
    scope: "may-request-work", content: "later", reply_to: QUESTION_MESSAGE })).toBeUndefined();
});


test.each(["q:other", "q:pick", "d:submit", "d:cancel"])("legacy %s clicks only ask for a reply", async (legacy) => {
  const qid = question();
  const [kind, verb] = legacy.split(":");
  await handleInteraction(event(`h1:${kind}:${qid}:${verb}`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(callbacks()).toEqual([{ type: 4, data: { content: "Reply to the question message to answer.", flags: 64,
    allowed_mentions: { parse: [] } } }]);
  expect(questionRow(qid).status).toBe("awaiting_answer");
});


test("typed replies clear buttons once after restart and identify the answerer", async () => {
  const qid = question();
  expect(recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: TRUSTED, role: "TRUSTED_REQUEST",
    scope: "trusted-pr-merge-restart", content: "tomorrow", reply_to: QUESTION_MESSAGE })).toBe(qid);
  expect(questionRow(qid).answer_source).toBe("reply");
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  replies = [[/GET \/channels\/100\/messages\/600/, () => ({ content: "Question\nHow long?" })]];
  await sweep(deps());
  await sweep(deps());
  expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{
    content: `Question\nHow long?\nAnswered by **[User ${TRUSTED}](<https://discord.com/users/${TRUSTED}?tab=wishlist>)** (typed reply)`, components: [], allowed_mentions: { parse: [] },
  }]);
  expect(questionRow(qid).cleared_at).toBe(now);
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(0);
});


test("a lost option callback is recovered after restart without another tap", async () => {
  const qid = question();
  replies = [[/callback/, () => { throw new CallError(undefined, "lost response"); }]];
  await handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_text: "8 hours", cleared_at: null });
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  replies = [];
  await sweep(deps());
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ announced_at: now, cleared_at: now });
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(1);
});


test("simultaneous option taps record only the first answer", async () => {
  const qid = question();
  await Promise.all([
    handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps()),
    handleInteraction(event(`h1:q:${qid}:o1`, TRUSTED, { message: { id: QUESTION_MESSAGE } }), deps()),
  ]);
  expect(questionRow(qid)).toMatchObject({ status: "answered", answer_author: OWNER, answer_text: "8 hours" });
  expect(calls.filter((call) => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(1);
});

test.each([false, true])("uncertain answer posts survive a rename and reconcile old presentation: legacy=%s", async legacy => {
  const qid = question();
  let accepted = "";
  replies = [[/POST \/channels\/100\/messages$/, body => {
    accepted = body.content;
    throw new CallError(undefined, "accepted but response lost");
  }]];
  await handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  if (legacy) {
    using db = new Database(join(dir, "discord-questions.sqlite"));
    db.query("UPDATE questions SET answer_display=NULL WHERE id=?").run(qid);
  }
  now += 11 * 60_000;
  replies = [
    [/GET \/users\/99$/, () => ({ username: "Renamed user" })],
    [/GET \/channels\/100\/messages\?after=/, () => [{ id: "900", author: { bot: true },
      message_reference: { message_id: QUESTION_MESSAGE }, content: legacy ? `<@${OWNER}>: 8 hours` : accepted }]],
  ];

  await sweep(deps());

  expect(questionRow(qid).announced_at).toBe(now);
  expect(calls.filter(call => call.method === "POST" && call.path === "/channels/100/messages")).toHaveLength(1);
  expect(calls.filter(call => call.path === "/users/99")).toHaveLength(legacy ? 1 : 0);
});

test.each(["button", "reply"])("a %s answer at seventy-one hours still counts", async (source) => {
  const qid = question();
  now += 71 * 3_600_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    if (source === "button") await handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
    else recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
      scope: "may-request-work", content: "typed", reply_to: QUESTION_MESSAGE });
    expect(questionRow(qid).status).toBe("answered");
  } finally { clock.mockRestore(); }
});

test.each(["button", "reply"])("a late %s answer before upkeep leaves the question unanswered", async (source) => {
  const qid = question();
  now += 72 * 3_600_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    if (source === "button") await handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
    else expect(recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
      scope: "may-request-work", content: "too late", reply_to: QUESTION_MESSAGE })).toBeUndefined();
    expect(questionRow(qid)).toMatchObject({ status: "awaiting_answer", answer_text: null });
  } finally { clock.mockRestore(); }
});

test("upkeep expires unanswered questions once across restart and rejects later clicks and replies", async () => {
  const qid = question();
  now += 72 * 3_600_000 + 1;
  replies = [[/GET \/channels\/100\/messages\/600/, () => ({ content: "Question\nHow long?" })]];
  await sweep(deps());
  expect(questionRow(qid)).toMatchObject({ status: "expired", cleared_at: now });
  expect(lines).toEqual([`QUESTION_EXPIRED ${JSON.stringify({ id: qid, lane: "lead", audience: "staff", status: "expired",
    read: `helio question show ${qid}` })}`]);
  expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{
    content: "Question\nHow long?\nExpired without an answer.", components: [], allowed_mentions: { parse: [] },
  }]);
  prompts.close();
  prompts = new PromptStore(join(dir, "discord-prompts.sqlite"), 50);
  await sweep(deps());
  await handleInteraction(event(`h1:q:${qid}:o0`, OWNER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(callbacks().at(-1)?.data.content).toBe("This question expired without an answer.");
  expect(recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: OWNER, role: "OWNER_REQUEST",
    scope: "may-request-work", content: "too late", reply_to: QUESTION_MESSAGE })).toBeUndefined();
  expect(questionRow(qid)).toMatchObject({ status: "expired", answer_text: null });
  expect(lines).toHaveLength(1);
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
});


test("unauthorized option clicks and typed replies leave a question unanswered", async () => {
  const qid = question();
  expect(recordAnswer(dir, OWNER, { message_id: "801", channel_id: "100", author_id: STRANGER, role: "STAFF_QUESTION",
    scope: "answer-only", content: "tomorrow", reply_to: QUESTION_MESSAGE })).toBeUndefined();
  await handleInteraction(event(`h1:q:${qid}:o0`, STRANGER, { message: { id: QUESTION_MESSAGE } }), deps());
  expect(questionRow(qid).status).toBe("awaiting_answer");
  expect(callbacks().at(-1)?.data.content).toBe(`This one's for **[Owner](<https://discord.com/users/${OWNER}?tab=wishlist>)**.`);
});
