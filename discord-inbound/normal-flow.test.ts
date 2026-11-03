import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";

async function run(dir: string, options: {
  readonly trusted?: boolean; readonly unknown?: boolean; readonly script?: string; readonly args?: readonly string[];
  readonly liveReply?: boolean;
} = {}) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "fixtures/discord.ts"),
    join(import.meta.dir, options.script ?? "inbound.ts"), ...(options.args ?? []),
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: options.trusted ? "100" : "",
      DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined,
      DORI_TEST_REPLIES: "1", DORI_TEST_PING_REPLY: "1", DORI_TEST_TRACE_READS: "1",
      DORI_TEST_FORWARDS: "1", DORI_TEST_UNKNOWN_BOT: options.unknown ? "1" : "",
      DORI_TEST_LIVE_REPLY: options.liveReply ? "1" : "",
      DORI_TEST_REFRESH: "", DORI_TEST_TRUSTED_DMS: "", DORI_TEST_NULL_PARENT: "", DORI_TEST_BUG_REPORTS: "", DORI_TEST_ARCHIVED: "",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
const records = (stdout: string): Record<string, unknown>[] => stdout.split("\n")
  .filter((line) => line.startsWith("INBOUND ")).map((line) => JSON.parse(line.slice(8)));
const reads = (stdout: string): unknown[] => stdout.split("\n")
  .filter((line) => line.startsWith("TEST_READ ")).map((line) => JSON.parse(line.slice(10)));

test("normal history and live non-pings never stage or prepare attachments/forwards, and ping replies never read ancestors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-normal-gate-"));
  try {
    const result = await run(dir);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(records(result.stdout).map((message) => [message.message_id, message.channel_policy, message.reply_context]))
      .toEqual([["10", "normal", undefined], ["90", "normal", undefined]]);
    expect(reads(result.stdout)).toEqual([{ kind: "attachment", file: "photo.png" }]);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10", "90"]);
      expect(queue.contains("inbound", "11")).toBe(false);
      expect(queue.contains("inbound", "21")).toBe(false);
      expect(queue.contains("inbound", "22")).toBe(false);
    } finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy non-pings and unknown identity are withheld on both replay paths without losing pending, and old ancestors are removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-normal-replay-"));
  try {
    const first = await run(dir, { trusted: true, liveReply: true });
    expect(first.exitCode).toBe(0);
    expect(records(first.stdout).find((message) => message.message_id === "90")?.reply_context).toBeDefined();
    const cursor = await Bun.file(join(dir, "discord-inbound.json")).text();
    const unknown = await run(dir, { unknown: true });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("bot identity");
    expect(records(unknown.stdout)).toEqual([]);
    expect(reads(unknown.stdout)).toEqual([]);
    expect(await Bun.file(join(dir, "discord-inbound.json")).text()).toBe(cursor);
    const unknownPending = await run(dir, { unknown: true, script: "ack.ts", args: ["pending", "inbound"] });
    expect(unknownPending.exitCode).toBe(0);
    expect(records(unknownPending.stdout)).toEqual([]);

    const known = await run(dir, { script: "ack.ts", args: ["pending", "inbound"] });
    expect(known.exitCode).toBe(0);
    expect(records(known.stdout).map((message) => [message.message_id, message.reply_context]))
      .toEqual([["10", undefined], ["90", undefined]]);
    expect(reads(known.stdout)).toEqual([]);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10", "11", "21", "22", "90"]);
    } finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
