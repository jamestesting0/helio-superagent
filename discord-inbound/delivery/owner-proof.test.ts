import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerApproved } from "./owner-proof.ts";
import type { Rest } from "../discord/rest.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
let dir = "";
let questions = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "helio-owner-proof-"));
  questions = join(dir, "questions.sqlite");
  const db = new Database(questions, { create: true });
  db.exec("CREATE TABLE questions (id TEXT PRIMARY KEY, question TEXT, status TEXT, answer_author TEXT, answer_text TEXT)");
  db.query("INSERT INTO questions VALUES ('q1', 'Block 501 (spammer)?', 'answered', '99', 'Block')").run();
  db.query("INSERT INTO questions VALUES ('q2', 'Block 501?', 'answered', '42', 'Block')").run();
  db.query("INSERT INTO questions VALUES ('q3', 'Undo the automatic block of 501?', 'answered', '99', 'Undo')").run();
  db.close();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function restWith(message: Record<string, unknown>): Rest {
  return (async (path: string) => {
    if (path !== "/channels/700/messages/800") throw new Error(`unexpected ${path}`);
    return message;
  }) as Rest;
}
const owner = (content: string, minutesAgo = 1) => restWith({
  id: "800", channel_id: "700", author: { id: "99" }, content, timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
});
const check = (action: "add" | "remove", proof: { message?: string; channel?: string; question?: string }, rest?: Rest) =>
  ownerApproved({ ownerId: "99", rest, questionsPath: questions, now: NOW }, "501", action, proof);

test("a fresh owner message naming the user and the action approves it", async () => {
  await expect(check("add", { message: "800", channel: "700" }, owner("please blacklist <@501>, they spam"))).resolves.toBeDefined();
  await expect(check("remove", { message: "800", channel: "700" }, owner("unblock 501"))).resolves.toBeDefined();
});

test("another author, a stale message, quoted text or a missing action never approves", async () => {
  const other = restWith({ id: "800", channel_id: "700", author: { id: "42" }, content: "blacklist 501", timestamp: new Date(NOW).toISOString() });
  await expect(check("add", { message: "800", channel: "700" }, other)).rejects.toThrow("not the owner");
  await expect(check("add", { message: "800", channel: "700" }, owner("blacklist 501", 20))).rejects.toThrow("older than 15 minutes");
  await expect(check("add", { message: "800", channel: "700" }, owner("> blacklist 501\nlol"))).rejects.toThrow("does not ask");
  await expect(check("add", { message: "800", channel: "700" }, owner("501 is funny"))).rejects.toThrow("does not ask");
  await expect(check("add", { message: "800", channel: "700" }, owner("blacklist 777"))).rejects.toThrow("does not ask");
});

test("an owner's Block or Undo answer about this user approves only the matching action", async () => {
  await expect(check("add", { question: "q1" })).resolves.toBeDefined();
  await expect(check("remove", { question: "q3" })).resolves.toBeDefined();
  await expect(check("remove", { question: "q1" })).rejects.toThrow("not an owner Undo answer");
  await expect(check("add", { question: "q2" })).rejects.toThrow("not an owner Block answer");
  await expect(check("add", { question: "missing" })).rejects.toThrow("Unknown question");
});

test("negations, inline code, quoted examples and edited messages never approve", async () => {
  for (const content of ["Do not block 501", "don't blacklist <@501>", "They wrote `block 501` as an example",
    'he said "block 501" earlier', "I would never ban 501", "what if we block 501?"]) {
    await expect(check("add", { message: "800", channel: "700" }, owner(content)), content).rejects.toThrow("does not ask");
  }
  const edited = restWith({ id: "800", channel_id: "700", author: { id: "99" }, content: "block 501",
    timestamp: new Date(NOW - 60_000).toISOString(), edited_timestamp: new Date(NOW).toISOString() });
  await expect(check("add", { message: "800", channel: "700" }, edited)).rejects.toThrow("edited");
  await expect(check("add", { message: "800", channel: "700" }, owner("<@88> block <@501> they keep spamming"))).resolves.toBeDefined();
});
