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

/** The lead opens a topic on a message it received; a claim records that message's channel and author. */
function received(dir: string, anchor: string, user = "99") {
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try { store.claimWorking("100", user, anchor, Date.now()); } finally { store.dispose(); }
}
const listed = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("CONVERSATION "))
  .map((line) => JSON.parse(line.slice("CONVERSATION ".length)));

test("CLI opens, lists and closes topics with machine consumed prefixes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-cli-"));
  try {
    received(dir, "10"); received(dir, "11");
    const opened = await invoke(dir, "open", "10", "Investigate", "timeout");
    expect([opened.code, opened.stderr]).toEqual([0, ""]);
    const row = JSON.parse(opened.stdout.slice("CONVERSATION_OPEN ".length));
    expect([row.topic_id, row.channel_id, row.user_id, row.topic, row.status]).toEqual(["10", "100", "99", "Investigate timeout", "open"]);
    const first = await invoke(dir, "list");
    expect([first.code, first.stderr]).toEqual([0, ""]);
    expect(listed(first.stdout)).toEqual([expect.objectContaining({ topic_id: "10", title: "Investigate timeout", opened_by: "99",
      participants: ["99"], state: "waiting_on_helio", age_ms: 0, idle_ms: 0, summary: "Investigate timeout" })]);
    expect((await invoke(dir, "open", "11", "another", "topic")).code).toBe(0);
    expect((await invoke(dir, "close", "12", "answered")).stdout).toBe("CONVERSATION_REFUSED No active topic 12\n");
    const closed = await invoke(dir, "close", "10", "answered");
    expect([closed.code, closed.stderr]).toEqual([0, ""]);
    expect(JSON.parse(closed.stdout.slice("CONVERSATION_CLOSED ".length))).toMatchObject({ anchor_message_id: "10", outcome: "answered" });
    expect(listed((await invoke(dir, "list")).stdout).map((topic) => topic.topic_id)).toEqual(["11"]);
    expect((await invoke(dir, "close", "11", "answered")).code).toBe(0);
    expect((await invoke(dir, "list")).stdout).toBe("");
    expect((await invoke(dir, "close", "11", "answered")).code).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["open", "bad", "topic"], ["open", "10", "x".repeat(201)], ["open", "10"], ["open", "10", "unknown anchor"],
  ["close", "10", "invalid"], ["close", "10", "other", "extra"], ["list", "extra"], ["show", "10", "extra"],
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

test("opening a new topic after claiming its anchor transfers that message out of the previous topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-transfer-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    store.open("100", "99", "500", "logs", Date.now());
    store.claim("100", "99", { message_id: "600", author_id: "99", author: "owner", bot: false, sent_at: new Date().toISOString(),
      content: "new topic", attachment_count: 0 }, Date.now(), { channel: "100", audience: "public" });
    expect((await invoke(dir, "open", "600", "roles")).code).toBe(0);
    const logs = store.get("100", "99", "500"), roles = store.get("100", "99", "600");
    if (!logs || !roles) throw new Error("Both topics must remain open");
    expect(store.transcriptOf(logs).map((entry) => entry.message_id)).toEqual([]);
    expect(store.transcriptOf(roles).map((entry) => entry.message_id)).toEqual(["600"]);
    expect(store.forReply("100", "99", "600")?.anchor_message_id).toBe("600");
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("show, note, hold, resume and explicit reopen preserve a request through the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-commands-"));
  const content = async () => JSON.parse(JSON.parse((await invoke(dir, "show", "10")).stdout.slice("CONVERSATION_SHOW ".length)).content);
  try {
    received(dir, "10");
    await invoke(dir, "open", "10", "queue request");
    const text = join(dir, "summary.txt");
    await Bun.write(text, "Queue fails after a timeout.");
    expect((await invoke(dir, "note", "10", "--text-file", text)).code).toBe(0);
    expect((await invoke(dir, "hold", "10", "owner", "decision")).code).toBe(0);
    const held = await content();
    expect([held.state, held.hold_reason, held.summary]).toEqual(["on_hold", "owner decision", "Queue fails after a timeout."]);
    expect((await invoke(dir, "resume", "10")).code).toBe(0);
    expect((await content()).state).toBe("waiting_on_helio");
    expect((await invoke(dir, "close", "10", "issue", "--issue", "https://github.com/o/r/issues/3")).code).toBe(0);
    const row = JSON.parse((await invoke(dir, "reopen", "10")).stdout.slice("CONVERSATION_REOPENED ".length));
    expect([row.status, row.summary, row.issue]).toEqual(["open", "Queue fails after a timeout.", "https://github.com/o/r/issues/3"]);
    await Bun.write(text, "x".repeat(601));
    expect((await invoke(dir, "note", "10", "--text-file", text)).code).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a useful unpinged message joins its topic silently and later replies to it find the topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-join-"));
  try {
    received(dir, "10");
    expect((await invoke(dir, "open", "10", "Queue stuck")).code).toBe(0);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      queue.stage("inbound", "11", JSON.stringify({ channel_id: "100", author_id: "77", author: "other", content: "same on mobile",
        sent_at: "2026-11-02T12:00:00Z", reply_to: "10", channel_policy: "normal" }));
    } finally { queue.close(); }
    expect((await invoke(dir, "join", "10", "77", "--message", "11")).code).toBe(0);
    expect((await invoke(dir, "join", "10", "78", "--message", "11")).code).toBe(2);
    const store = new Conversations(join(dir, "discord-conversations.sqlite"));
    try {
      expect(store.participants("10").map((person) => [person.user_id, person.via])).toEqual([["77", "lead"], ["99", "opened"]]);
      expect(store.topicOfMessage("11")?.anchor_message_id).toBe("10");
    } finally { store.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("conversation listing pages long multibyte summaries within the tool budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-pages-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    for (let user = 10; user < 25; user++) {
      store.open("100", String(user), String(user), "topic", Date.parse("2026-11-02T11:00:00Z"));
      store.note("100", String(user), "界".repeat(600));
    }
    const users: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await invoke(dir, "list", "--offset", String(offset));
      expect(Buffer.byteLength(page.stdout)).toBeLessThan(50_000);
      users.push(...listed(page.stdout).map((topic) => topic.opened_by));
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
    // Unthreaded follow-ups reach Helio only while its question waits on this person here.
    // Asked ten minutes before the follow-ups at 12:00, so they fall inside the question's 30-minute window.
    store.applyReply(store.open("100", "99", "9", "Match timeout", opened), { disposition: "question", waiting_on: "Which match?" },
      Date.parse("2026-11-02T11:50:00Z"));
    const stdout = await intake(dir, mode);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const pending = queue.pending("inbound").map((item) => queue.snapshots.hydrate(JSON.parse(item.payload)));
      expect(pending.map((item) => [item.message_id, item.attention])).toEqual([["80", "review"], ["82", "review"]]);
      const first = pending[0]?.conversation as Context;
      const next = pending[1]?.conversation as Context;
      expect([first.topic, first.opened_at, first.anchor_message_id, first.transcript])
        .toEqual(["Match timeout", new Date(opened).toISOString(), "9", []]);
      // Only cached messages within five minutes are initial evidence; missing history is lazy.
      const expected = mode === "fresh" ? Array.from({ length: 10 }, (_, i) => String(62 + i)) :
        mode === "old" ? ["70", "71"] : [];
      expect(first.recent.map((entry) => entry.message_id)).toEqual(expected);
      // 81 replies to unclaimed 80, so 82's explicit reply to 81 has no known source topic.
      expect(next.topic).toBeUndefined();
      expect(stdout.includes("TEST_CONVERSATION_HISTORY")).toBe(false);
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
    for (const entry of entries) store.claim("100", "99", entry, Date.parse("2026-11-02T11:00:00Z"), { channel: "100", audience: "public" });
    store.applyReply(store.get("100", "99")!, { disposition: "question", waiting_on: "Which match?" }, Date.parse("2026-11-02T11:50:00Z"));
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

test.each([false, true])("a late reply to Helio's question reopens its silently closed topic through intake (full=%s)", async (full) => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-late-answer-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const asked = Date.now() - 80 * 3_600_000;
  try {
    // Helio asked in 81 (a reply to 80); nobody answered, so upkeep closed the topic silently at 72 hours.
    store.open("100", "99", "80", "Match timeout", asked);
    store.append("100", "99", describeMessage({ id: "81", channel_id: "100", author: { id: "88", username: "Helio", bot: true },
      content: "What happened next?", timestamp: new Date(asked).toISOString(), message_reference: { message_id: "80" } }, 12000).entry, asked);
    store.applyReply(store.get("100", "99")!, { disposition: "question", waiting_on: "What happened next?" }, asked);
    store.resolveIfCurrent(store.get("100", "99")!, "timed_out", asked + 72 * 3_600_000);
    if (full) { store.open("100", "99", "70", "Other", asked); store.open("101", "99", "71", "Third", asked); }
    await intake(dir, "rest");
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const late = queue.pending("inbound").map((item) => JSON.parse(item.payload)).find((item) => item.message_id === "82");
      expect(late?.resumes_topic).toBe("80");
    } finally { queue.close(); }
    expect(store.topic("80")?.status).toBe(full ? "resolved" : "open");
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("startup sweep closes a stale question silently after catch-up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-startup-timeout-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    const opened = Date.parse("2026-10-29T12:00:00Z");
    const row = store.open("100", "55", "9", "stale", opened);
    store.applyReply(row, { disposition: "question", waiting_on: "Which error?" }, opened);
    const stdout = await intake(dir, "old");
    expect(stdout).not.toContain("INBOUND_CONVERSATION_TIMEOUT");
    expect([store.latest("100", "55")?.status, store.latest("100", "55")?.outcome]).toEqual(["resolved", "timed_out"]);
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("a long topic's continuation command stays on that topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-topic-page-"));
  try {
    received(dir, "10"); received(dir, "11");
    expect((await invoke(dir, "open", "10", "first")).code).toBe(0);
    expect((await invoke(dir, "open", "11", "second")).code).toBe(0);
    const store = new Conversations(join(dir, "discord-conversations.sqlite"));
    try {
      for (let i = 0; i < 3; i++) {
        store.append("100", "99", { message_id: String(20 + i), author_id: "88", author: "Helio", bot: true,
          sent_at: "2026-11-02T12:00:00Z", content: "x".repeat(5_000), attachment_count: 0, reply_to: "10" }, Date.now());
      }
    } finally { store.dispose(); }
    const shown = await invoke(dir, "show", "10");
    expect(shown.stdout).toContain("helio conversation show 10 --offset");
    expect(shown.stdout).toContain('"topic\\":\\"first');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a topic that timed out or was closed can still be read by its anchor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-closed-topic-"));
  try {
    received(dir, "9");
    expect((await invoke(dir, "open", "9", "stale")).code).toBe(0);
    expect((await invoke(dir, "close", "9", "timed_out")).code).toBe(0);
    const shown = await invoke(dir, "show", "9");
    expect([shown.code, shown.stdout.startsWith("CONVERSATION_SHOW ")]).toEqual([0, true]);
    expect(shown.stdout).toContain('\\"status\\":\\"resolved');
    expect((await invoke(dir, "show", "8")).code).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
