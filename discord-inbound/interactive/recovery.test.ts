import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallError, discordCall, expireNow, handleInteraction, parseInteraction, sweep, type Deps } from "./handler.ts";
import { Delivery } from "../delivery/delivery.ts";
import { LAPSE_MS, PromptStore, QuestionStore, CONFIRM_TTL_MS } from "./store.ts";

const OWNER = "99", TRUSTED = "77", STRANGER = "66", PROMPT_MESSAGE = "500", QUESTION_MESSAGE = "600";
const SHA = "9f45e57" + "a".repeat(33);
const PROOF = "✅ **[User 99](<https://discord.com/users/99>)** confirmed merge [PR #6](<https://github.com/o/r/pull/6>) · `9f45e57`";
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

test("legacy pending decisions without recovery data expire and cannot accept an opposite click", async () => {
  const id = prompt();
  prompts.db.query("UPDATE prompts SET status='pending',pending_by=?,pending_at=? WHERE id=?").run(OWNER, now, id);
  prompts.close();
  const old = new Database(join(dir, "discord-prompts.sqlite"));
  try {
    for (const name of ["pending_app", "pending_token", "pending_accept", "pending_expected"]) old.exec(`ALTER TABLE prompts DROP COLUMN ${name}`);
    old.exec("CREATE TABLE drafts (id TEXT PRIMARY KEY,question_id TEXT,user_id TEXT,option_index INTEGER,label TEXT,created_at INTEGER)");
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
    [/@original/, () => ({ id: "701", content: PROOF })]];
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", result_message_id: "701" });
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
    [/\/t0\/messages\/@original/, () => ({ id: "702", content: PROOF })],
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
    [/@original/, () => ({ id: "701", content: PROOF })]];
  await handleInteraction(event(`h1:c:${id}:confirm`, OWNER), deps());
  expect(prompts.get(id)).toMatchObject({ status: "confirmed", result_message_id: "701" });
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
