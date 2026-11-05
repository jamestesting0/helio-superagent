import { Database } from "bun:sqlite";
import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { Conversations } from "../conversations/conversations.ts";

async function stateWithAnswers() {
  const dir = await mkdtemp(join(tmpdir(), "helio-blacklist-cli-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, "discord-questions.sqlite"), { create: true });
  db.exec("CREATE TABLE questions (id TEXT PRIMARY KEY, question TEXT, status TEXT, answer_author TEXT, answer_text TEXT)");
  db.query("INSERT INTO questions VALUES ('q1', 'Block 501?', 'answered', '99', 'Block')").run();
  db.query("INSERT INTO questions VALUES ('q2', 'Block 42?', 'answered', '99', 'Block')").run();
  db.query("INSERT INTO questions VALUES ('q3', 'Undo the block of 501?', 'answered', '99', 'Undo')").run();
  db.close();
  return dir;
}

async function blacklist(dir: string, ...args: string[]) {
  return run(dir, { DORI_DISCORD_TRUSTED_IDS: "42" }, ...args);
}

async function run(dir: string, env: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../blacklist.ts"), ...args], {
    env: { ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_TOKEN: "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr, code };
}

test("the owner's Block answer blacklists and their Undo answer lifts it", async () => {
  const dir = await stateWithAnswers();
  expect(await blacklist(dir, "add", "501", "--reason", "spam", "--question", "q1"))
    .toEqual({ stdout: 'BLACKLIST_ADDED user=501 source=owner proof="question q1" dismissed=0', stderr: "", code: 0 });
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  try { expect(delivery.moderation.isBlocked("501")).toBe(true); } finally { delivery.close(); }
  expect(await blacklist(dir, "remove", "501", "--question", "q3"))
    .toEqual({ stdout: 'BLACKLIST_REMOVED user=501 proof="question q3"', stderr: "", code: 0 });
});

test("trusted users, missing proof and the wrong answer are refused", async () => {
  const dir = await stateWithAnswers();
  expect((await blacklist(dir, "add", "42", "--reason", "x", "--question", "q2")).stdout)
    .toBe("BLACKLIST_REFUSED User 42 is the owner or trusted and cannot be blacklisted");
  expect((await blacklist(dir, "add", "501", "--reason", "spam")).stdout)
    .toBe("BLACKLIST_REFUSED Proof needs --message M --channel C or --question ID");
  expect((await blacklist(dir, "add", "501", "--reason", "spam", "--question", "q3")).code).toBe(1);
  expect((await blacklist(dir, "list")).stdout).toBe("BLACKLIST_COUNT 0");
});

test("a proof is used once: an old Block answer cannot undo a later Undo", async () => {
  const dir = await stateWithAnswers();
  expect((await blacklist(dir, "add", "501", "--reason", "spam", "--question", "q1")).code).toBe(0);
  expect((await blacklist(dir, "add", "501", "--reason", "spam", "--question", "q1")).code).toBe(0);
  expect((await blacklist(dir, "remove", "501", "--question", "q3")).code).toBe(0);
  expect((await blacklist(dir, "add", "501", "--reason", "spam", "--question", "q1")).stdout)
    .toBe("BLACKLIST_REFUSED Proof question q1 was already used; ask the owner again");
  expect((await blacklist(dir, "list")).stdout).toBe("BLACKLIST_COUNT 0");
});

test("trusted users come from the installed trusted-users file, as the other wrappers load them", async () => {
  const dir = await stateWithAnswers();
  const home = join(dir, "home");
  await Bun.write(join(home, ".dori/elobot/trusted-users"), "42\n");
  expect((await run(dir, { HOME: home, DORI_DISCORD_TRUSTED_IDS: undefined }, "add", "42", "--reason", "x", "--question", "q2")).stdout)
    .toBe("BLACKLIST_REFUSED User 42 is the owner or trusted and cannot be blacklisted");
});

test("repeating a committed block repairs interrupted settlement without consuming accepted work", async () => {
  const dir = await stateWithAnswers();
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    queue.stage("inbound", "700", JSON.stringify({ author_id: "501", sent_at: new Date().toISOString() }));
    queue.accept("700");
    store.open("104", "501", "700", "work to preserve", Date.now());
    store.claimWorking("104", "501", "700", Date.now());
    queue.moderation.withProof("question q1", "501", "add", Date.now(), () =>
      queue.block("501", { source: "owner", reason: "spam", by: "99" }, new Set(["99"])));
  } finally { queue.close(); store.dispose(); }
  expect((await blacklist(dir, "add", "501", "--reason", "spam", "--question", "q1")).code).toBe(0);
  const reopened = new Delivery(join(dir, "discord-delivery.sqlite"));
  const conversations = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    expect(reopened.status("inbound", "700").disposition).toBe("accepted");
    expect(conversations.get("104", "501")).toBeNull();
    expect(conversations.working("700")?.closed_at).toBeNumber();
  } finally { reopened.close(); conversations.dispose(); }
});
