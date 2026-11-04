import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Conversations, type ConversationEntry } from "../conversations/conversations.ts";
import { Delivery } from "../delivery/delivery.ts";
import { describeMessage } from "../messages/reply-context.ts";

async function invoke(state: string | undefined, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../fixtures/now.ts"),
    join(import.meta.dir, "../conversation.ts"), ...args], {
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
    const listed = await invoke(dir, "list");
    expect([listed.code, listed.stderr]).toEqual([0, ""]);
    expect(JSON.parse(listed.stdout.slice("CONVERSATION ".length))).toEqual({
      ...row, summary: row.topic, state: "waiting_on_requester", age_ms: 0, idle_ms: 0,
    });
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

test("show, note, hold, resume and explicit reopen preserve a request through the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-commands-"));
  try {
    await invoke(dir, "open", "100", "99", "10", "queue request");
    const text = join(dir, "summary.txt");
    await Bun.write(text, "Queue fails after a timeout.");
    expect((await invoke(dir, "note", "100", "99", "--text-file", text)).code).toBe(0);
    expect((await invoke(dir, "hold", "100", "99", "owner", "decision")).code).toBe(0);
    const held = JSON.parse((await invoke(dir, "list")).stdout.slice("CONVERSATION ".length));
    expect([held.state, held.hold_reason, held.summary]).toEqual(["on_hold", "owner decision", "Queue fails after a timeout."]);
    expect((await invoke(dir, "resume", "100", "99")).code).toBe(0);
    const shown = await invoke(dir, "show", "100", "99");
    const page = JSON.parse(shown.stdout.slice("CONVERSATION_SHOW ".length));
    expect([JSON.parse(page.content).state, page.truncated]).toEqual(["waiting_on_requester", false]);
    const closed = await invoke(dir, "close", "100", "99", "issue", "--issue", "https://github.com/o/r/issues/3");
    expect(closed.code).toBe(0);
    const reopened = await invoke(dir, "reopen", "100", "99");
    const row = JSON.parse(reopened.stdout.slice("CONVERSATION_REOPENED ".length));
    expect([row.status, row.summary, row.issue]).toEqual(["open", "Queue fails after a timeout.", "https://github.com/o/r/issues/3"]);
    await Bun.write(text, "x".repeat(601));
    expect((await invoke(dir, "note", "100", "99", "--text-file", text)).code).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("conversation listing pages long multibyte summaries and reasons within the tool budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-pages-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    for (let user = 10; user < 25; user++) {
      store.open("100", String(user), String(user), "topic", Date.parse("2026-11-02T11:00:00Z"));
      store.note("100", String(user), "界".repeat(600));
      store.hold("100", String(user), "界".repeat(600));
    }
    const users: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await invoke(dir, "list", "--offset", String(offset));
      expect(Buffer.byteLength(page.stdout)).toBeLessThan(50_000);
      users.push(...page.stdout.split("\n").filter((line) => line.startsWith("CONVERSATION "))
        .map((line) => JSON.parse(line.slice("CONVERSATION ".length)).user_id));
      const next = /--offset (\d+)"/.exec(page.stdout);
      if (!next) break;
      offset = Number(next[1]);
    }
    expect(users).toEqual(Array.from({ length: 15 }, (_, index) => String(10 + index)));
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

async function intake(state: string, mode: string, replay?: "open" | "closed") {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "..", replay ? "ack.ts" : "inbound.ts"), ...(replay ? ["pending", "inbound"] : []),
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
  .filter((line) => line.startsWith("INBOUND ")).map((line) => ({ message_id: JSON.parse(line.slice(8)).message_ids.at(-1) }));

test.each(["old", "fresh", "rest"])("intake excludes unclaimed chatter and retains only linked Helio replies (%s)", async (mode) => {
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
      expect(first.recent.map((entry) => entry.message_id)).toEqual(["67", "68", "69", "70", "71"]);
      expect(next.transcript).toEqual([]);
      expect(next.recent.map((entry) => entry.message_id)).toEqual(["69", "70", "71", "80", "81"]);
      expect(stdout.includes("TEST_CONVERSATION_HISTORY")).toBe(mode === "rest");
      expect(store.transcript("100", "99").map((entry) => entry.message_id)).toEqual(["83"]);
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
    for (const entry of entries) store.claim("100", "99", entry, Date.parse("2026-11-02T11:00:00Z"));
    await intake(dir, "old");
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const context: Context = JSON.parse(queue.pending("inbound")[0]?.payload ?? "{}").conversation;
      const expected = entries.slice(-6);
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
    const notices = stdout.split("\n").filter((line) => line.startsWith("INBOUND_CONVERSATION_TIMEOUT "))
      .map((line) => JSON.parse(line.slice("INBOUND_CONVERSATION_TIMEOUT ".length)));
    expect(notices).toEqual([{
      channel_id: "100", user_id: "55", anchor_message_id: "9", topic: "stale", opened_at: Date.parse("2026-10-29T12:00:00Z"),
      sent: "901", read: "helio conversation show 100 55",
    }]);
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});
