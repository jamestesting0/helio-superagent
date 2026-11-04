import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Delivery } from "../delivery/delivery.ts";
import { deliveryOutput } from "../fixtures/delivery-output.ts";
import type { Turn } from "../intake/turns.ts";

async function invoke(directory: string, mode: string, args: readonly string[] = []) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "..", args.length ? "ack.ts" : "inbound.ts"), ...args,
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: directory, DORI_DISCORD_TOKEN: "test",
      DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100",
      DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined,
      DORI_TEST_TURNS: mode, HELIO_GITHUB_REPO: "jamestesting0/elo-bot",
      DORI_TEST_REFRESH: "", DORI_TEST_FORWARDS: "", DORI_TEST_TRUSTED_DMS: "", DORI_TEST_NULL_PARENT: "",
      DORI_TEST_BUG_REPORTS: "", DORI_TEST_REPLIES: "", DORI_TEST_PING_REPLY: "", DORI_TEST_LIVE_REPLY: "",
      DORI_TEST_UNKNOWN_BOT: "", DORI_TEST_ARCHIVED: "", DORI_TEST_TRACE_READS: "",
      DORI_TEST_PREPARE_FAILURE: "", DORI_TEST_AUTH_FAILURE: "", DORI_TEST_POLICY_TRANSIENT: "",
    }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return stdout.includes("INBOUND ") ? deliveryOutput(directory, stdout) : stdout;
}

const records = (stdout: string): Turn[] => stdout.split("\n")
  .filter((line) => line.startsWith("INBOUND ")).map((line) => JSON.parse(line.slice(8)));

test("live intake stages each burst message, honors typing, and attaches volatile preceding evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-live-"));
  try {
    const stdout = await invoke(directory, "live");
    const turns = records(stdout);
    expect(turns.map((turn) => turn.turn.message_ids)).toEqual([["1002", "1003"]]);
    expect(turns[0]?.turn.preceding).toEqual([
      { message_id: "1000", sent_at: "2026-11-02T11:59:58.000Z", content: "Context jamestesting0/elo-bot#1000 (pull request)" },
      { message_id: "1001", sent_at: "2026-11-02T11:59:59.000Z", content: "Context jamestesting0/elo-bot#1001 (pull request)" },
    ]);
    expect([turns[0]?.role, turns[0]?.scope, turns[0]?.message_id]).toEqual(["OWNER_REQUEST", "may-request-work", "1003"]);
    expect(stdout).toContain(`TEST_TURN_CLOCK ${Date.parse("2026-11-02T12:00:10Z")}`);
    expect(stdout.indexOf("INBOUND_READY ")).toBeLessThan(stdout.indexOf("INBOUND "));
    const delivery = new Delivery(join(directory, "discord-delivery.sqlite"));
    try {
      expect(delivery.pending("inbound").map((item) => item.id)).toEqual(["1002", "1003"]);
      expect(delivery.pending("inbound").every((item) => !("turn" in JSON.parse(item.payload)))).toBe(true);
    } finally { delivery.close(); }
    for (const id of ["1002", "1003"]) {
      expect(JSON.parse(await invoke(directory, "live", ["status", "inbound", id])).disposition).toBe("pending");
      expect(await invoke(directory, "live", ["done", "inbound", id])).toBe(`ACK_DONE stream=inbound message_id=${id}\n`);
      expect(JSON.parse(await invoke(directory, "live", ["status", "inbound", id])).disposition).toBe("done");
    }
    expect(records(await invoke(directory, "live"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a process ending before its timer loses no staged messages and replays them grouped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-crash-"));
  try {
    expect(records(await invoke(directory, "crash"))).toEqual([]);
    const delivery = new Delivery(join(directory, "discord-delivery.sqlite"));
    try {
      expect(delivery.pending("inbound").map((item) => item.id)).toEqual(["1002", "1003"]);
    } finally { delivery.close(); }
    const replay = await invoke(directory, "live");
    expect(records(replay).map((turn) => turn.turn.message_ids)).toEqual([["1002", "1003"]]);
    expect(records(replay)[0]?.turn.preceding).toBeUndefined();
    expect(replay).toContain("backlog=2");
    expect(replay.indexOf("INBOUND ")).toBeLessThan(replay.indexOf("INBOUND_READY "));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("catch-up emits grouped turns immediately and keeps the readiness count in messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-backlog-"));
  try {
    const stdout = await invoke(directory, "backlog");
    expect(records(stdout).map((turn) => turn.turn.message_ids)).toEqual([["1002", "1003"]]);
    expect(stdout).toContain("backlog=2");
    expect(stdout).toContain(`TEST_TURN_CLOCK ${Date.parse("2026-11-02T12:00:00Z")}`);
    expect(stdout.indexOf("INBOUND ")).toBeLessThan(stdout.indexOf("INBOUND_READY "));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recordAnswer flushes buffered live messages immediately with durable question identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-answer-"));
  const path = join(directory, "discord-questions.sqlite");
  const db = new Database(path);
  try {
    await chmod(path, 0o600);
    db.exec(`CREATE TABLE questions(
      id TEXT PRIMARY KEY,recipient TEXT,audience TEXT,status TEXT,answer_id TEXT,channel_id TEXT,
      message_id TEXT,answer_author TEXT,answer_role TEXT,answer_scope TEXT,answer_text TEXT,updated INTEGER
    )`);
    db.query("INSERT INTO questions (id,recipient,audience,status,channel_id,message_id) VALUES (?,?,?,?,?,?)")
      .run("q1", "99", "owner", "awaiting_answer", "100", "999");
    const stdout = await invoke(directory, "live");
    expect(records(stdout).map((turn) => turn.turn.message_ids)).toEqual([["1002", "1003"]]);
    expect(JSON.parse(stdout.split("\n").find((line) => line.startsWith("INBOUND "))?.slice(8) ?? "{}").question_id).toBe("q1");
    expect(stdout).toContain(`TEST_TURN_CLOCK ${Date.parse("2026-11-02T12:00:00Z")}`);
    expect(stdout.indexOf("INBOUND ")).toBeLessThan(stdout.indexOf("INBOUND_READY "));
    const delivery = new Delivery(join(directory, "discord-delivery.sqlite"));
    try {
      expect(JSON.parse(delivery.pending("inbound").find((item) => item.id === "1003")?.payload ?? "{}").question_id).toBe("q1");
    } finally { delivery.close(); }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
