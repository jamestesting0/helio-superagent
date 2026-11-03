import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Conversations, type ConversationEntry } from "./conversations.ts";
import { Delivery } from "./delivery.ts";
import { describeMessage } from "./reply-context.ts";

async function invoke(state: string | undefined, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "conversation.ts"), ...args], {
    env: { ...process.env, DORI_STATE_DIR: state }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI opens, lists and closes conversations with machine consumed prefixes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-cli-"));
  try {
    const opened = await invoke(dir, "open", "100", "99", "10", "Investigate", "timeout");
    expect([opened.code, opened.stderr]).toEqual([0, ""]);
    expect(opened.stdout.startsWith("CONVERSATION_OPEN ")).toBe(true);
    const row = JSON.parse(opened.stdout.slice("CONVERSATION_OPEN ".length));
    expect([row.channel_id, row.user_id, row.anchor_message_id, row.topic, row.status])
      .toEqual(["100", "99", "10", "Investigate timeout", "open"]);
    expect(await invoke(dir, "list")).toEqual({ code: 0, stderr: "", stdout: `CONVERSATION ${JSON.stringify(row)}\n` });
    expect(await invoke(dir, "open", "100", "99", "11", "replace"))
      .toEqual({ code: 2, stderr: "", stdout: "CONVERSATION_REFUSED Conversation already open in this channel\n" });
    const closed = await invoke(dir, "close", "100", "99", "answered");
    expect([closed.code, closed.stderr, closed.stdout.startsWith("CONVERSATION_CLOSED ")]).toEqual([0, "", true]);
    expect(JSON.parse(closed.stdout.slice("CONVERSATION_CLOSED ".length)).outcome).toBe("answered");
    expect((await invoke(dir, "list")).stdout).toBe("");
    expect((await invoke(dir, "close", "100", "99", "answered")).code).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["open", "bad", "99", "10", "topic"],
  ["open", "100", "bad", "10", "topic"],
  ["open", "100", "99", "bad", "topic"],
  ["open", "100", "99", "10", "x".repeat(201)],
  ["open", "100", "99", "10"],
  ["close", "100", "99", "invalid"],
  ["close", "100", "99", "other", "extra"],
  ["list", "extra"],
].map((args) => ({ args })))("CLI refuses malformed arguments %j with exit 2", async ({ args }) => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-invalid-"));
  try {
    const result = await invoke(dir, ...args);
    expect([result.code, result.stderr, result.stdout.startsWith("CONVERSATION_REFUSED ")]).toEqual([2, "", true]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI requires DORI_STATE_DIR", async () => {
  expect(await invoke(undefined, "list"))
    .toEqual({ code: 2, stderr: "", stdout: "CONVERSATION_REFUSED Requires DORI_STATE_DIR\n" });
});

async function intake(state: string, mode: string, replay?: "open" | "closed") {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "fixtures/discord.ts"),
    join(import.meta.dir, replay ? "ack.ts" : "inbound.ts"), ...(replay ? ["pending", "inbound"] : []),
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: state, DORI_DISCORD_TOKEN: "test",
      DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100",
      DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "",
      DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_DISCORD_SCOPE_CATEGORY: undefined,
      DORI_TEST_CONVERSATIONS: mode,
    }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({
    code: 0, stderr: replay === "closed" ? [80, 82].map((id) =>
      `ACK_WARN message_id=${id} replay withheld: Delivery ${id} is no longer authorized; keep it pending\n`).join("") : "",
  });
  return stdout;
}

type Context = {
  topic: string; opened_at: string; anchor_message_id: string;
  transcript: ConversationEntry[]; recent: ConversationEntry[];
};
const inboundRecords = (stdout: string): { message_id: string }[] => stdout.split("\n")
  .filter((line) => line.startsWith("INBOUND ")).map((line) => JSON.parse(line.slice(8)));

test.each(["old", "fresh", "rest"])("intake carries previous human and Helio turns, with bounded recent evidence (%s)", async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-intake-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const opened = Date.parse("2026-11-02T11:00:00Z");
  try {
    store.open("100", "99", "9", "Match timeout", opened);
    const stdout = await intake(dir, mode);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const pending = queue.pending("inbound").map((item) => JSON.parse(item.payload));
      expect(pending.map((item) => [item.message_id, item.attention])).toEqual([["80", "review"], ["82", "review"]]);
      const first: Context = pending[0].conversation;
      const next: Context = pending[1].conversation;
      expect([first.topic, first.opened_at, first.anchor_message_id, first.transcript])
        .toEqual(["Match timeout", new Date(opened).toISOString(), "9", []]);
      expect(first.recent.map((entry) => entry.message_id)).toEqual(
        mode === "fresh" ? ["62", "63", "64", "65", "66", "67", "68", "69", "70", "71"] : ["69", "70", "71"],
      );
      expect(next.transcript.map((entry) => [entry.message_id, entry.author_id, entry.content]))
        .toEqual([["80", "99", "initial details"], ["81", "88", "What happened next?"]]);
      expect(next.recent.some((entry) => ["80", "81", "82"].includes(entry.message_id))).toBe(false);
      expect(stdout.includes("TEST_CONVERSATION_HISTORY")).toBe(mode === "rest");
      expect(store.transcript("100", "99").map((entry) => entry.message_id)).toEqual(["80", "81", "82", "83", "84"]);
      expect(store.get("100", "99")?.last_activity).toBe(Date.parse("2026-11-02T12:00:00Z"));
      expect(inboundRecords(stdout).map((record) => record.message_id)).toEqual(["82"]);
      expect(inboundRecords(await intake(dir, mode, "open")).map((record) => record.message_id)).toEqual(["80", "82"]);
      store.close("100", "99", "answered", Date.parse("2026-11-02T12:01:00Z"));
      expect(inboundRecords(await intake(dir, mode, "closed"))).toEqual([]);
      expect(inboundRecords(await intake(dir, mode))).toEqual([]);
      expect(queue.pending("inbound").map((item) => item.id)).toEqual(["80", "82"]);
    } finally { queue.close(); }
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test.each([10, 1000])("transcript payload keeps newest entries within count and character caps (content length %s)", async (length) => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-budget-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    store.open("100", "99", "9", "budget", Date.parse("2026-11-02T11:00:00Z"));
    const entries = Array.from({ length: 35 }, (_, index) => describeMessage({
      id: String(20 + index), channel_id: "100", author: { id: "99", username: "owner" },
      content: "x".repeat(length), timestamp: "2026-11-02T11:00:00Z",
    }, 12000).entry);
    for (const entry of entries) store.append("100", "99", entry);
    await intake(dir, "old");
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const context: Context = JSON.parse(queue.pending("inbound")[0]?.payload ?? "{}").conversation;
      const expected = entries.slice(-30);
      while (JSON.stringify(expected).length > 12000) expected.shift();
      expect(context.transcript).toEqual(expected);
      expect(context.transcript.at(-1)?.message_id).toBe("54");
    } finally { queue.close(); }
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("startup sweep reports a stale conversation once after catch-up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-startup-timeout-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    store.open("100", "55", "9", "stale", Date.parse("2026-10-29T12:00:00Z"));
    const stdout = await intake(dir, "old");
    expect(stdout.split("\n").filter((line) => line.startsWith("INBOUND_CONVERSATION_TIMEOUT "))).toEqual([
      `INBOUND_CONVERSATION_TIMEOUT ${JSON.stringify({
        channel_id: "100", user_id: "55", anchor_message_id: "9", topic: "stale", opened_at: Date.parse("2026-10-29T12:00:00Z"),
      })}`,
    ]);
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});
