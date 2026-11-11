import { expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { authorizationMetadata } from "../intake/authorization.ts";
import { Conversations } from "../conversations/conversations.ts";
import { pendingReminder } from "../delivery/pending-reminder.ts";
import { renderTurn } from "../delivery/context-render.ts";
import { contextSummary } from "../delivery/monitor-summary.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
function message(id: string, changes: Record<string, unknown> = {}) {
  return {
    message_id: id, channel_id: "100", author_id: "99", author: "owner",
    role: "OWNER_REQUEST", scope: "may-request-work", attention: "direct", channel_policy: "trusted",
    sent_at: new Date(NOW).toISOString(), preparation_complete: true, backlog: true, content: "request",
    discord_origin: authorizationMetadata({
      id, type: 0, channel_id: "100", guild_id: "300", author: { id: "99", username: "owner" },
      content: "<@88> request", timestamp: new Date(NOW).toISOString(),
    }), ...changes,
  };
}

async function invoke(dir: string, args: readonly string[], settings: Record<string, string> = {}, expectedCode = 0) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "..", args.length ? "ack.ts" : "inbound.ts"), ...args,
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: "100", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined,
      DORI_DISCORD_CONTEXT: "600", DORI_DISCORD_CONTEXT_EXCLUDED: "", ...settings,
    }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(expectedCode);
  return { stdout, stderr };
}

test("intake writes its own readiness receipt and a failed next startup resets the old ready state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intake-readiness-"));
  try {
    const first = await invoke(dir, []);
    expect(first.stdout).toContain("INBOUND_READY ");
    const ready = await Bun.file(join(dir, "intake-readiness.json")).json();
    expect(ready).toMatchObject({ phase: "ready", pid: expect.any(Number), start_ticks: expect.stringMatching(/^\d+$/), at_ms: expect.any(Number) });
    const failed = await invoke(dir, [], { DORI_TEST_UNKNOWN_BOT: "1" }, 1);
    expect(failed.stdout).not.toContain("INBOUND_READY ");
    const starting = await Bun.file(join(dir, "intake-readiness.json")).json();
    expect(starting.phase).toBe("starting");
    expect(starting.pid).not.toBe(ready.pid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a forty-thousand-character turn emits bounded pointers containing every durable ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summary-contract-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    for (const id of ["500", "501"]) queue.stage("inbound", id, JSON.stringify(message(id, { content: "x".repeat(40_000) })));
    const { stdout } = await invoke(dir, []);
    const claims = new Conversations(join(dir, "discord-conversations.sqlite"));
    try {
      expect(["500", "501"].map((id) => claims.working(id)?.claimed_at)).toEqual([NOW, NOW]);
    } finally { claims.dispose(); }
    const lines = stdout.split("\n").filter((line) => line.startsWith("INBOUND "));
    expect(lines.every((line) => line.length <= 1000)).toBe(true);
    const summary = lines.map((line) => JSON.parse(line.slice(8))).find((row) => row.turn === "500");
    expect(summary.message_ids).toEqual(["500", "501"]);
    expect(summary.read).toBe("ack show inbound 500,501");
    expect(summary.preview.length).toBeLessThanOrEqual(200);
    const before = queue.pending("inbound").filter((row) => ["500", "501"].includes(row.id));
    const shown = await invoke(dir, ["show", "inbound", "500,501"]);
    expect(shown.stdout.length).toBeLessThanOrEqual(20_000);
    const turn = JSON.parse(shown.stdout.slice("ACK_TURN ".length));
    expect(turn.turn.messages.map((row: { message_id: string }) => row.message_id)).toEqual(["500", "501"]);
    expect(turn.turn.messages.every((row: { truncated: boolean }) => row.truncated)).toBe(true);
    expect(queue.pending("inbound").filter((row) => ["500", "501"].includes(row.id))).toEqual(before);
    for (const row of before) queue.recovery.review(row.id, row.payload, {
      outcome: "resume", reason: "Current fixture request remains unfinished", evidence: "{}",
    });
    const reviewed = await invoke(dir, ["show", "inbound", "500,501"]);
    const working = await invoke(dir, ["working", "inbound", "500,501"]);
    expect(working.stdout.split("\n")[0]).toBe(reviewed.stdout.trim());
    expect(working.stdout).toContain("ACK_WORKING stream=inbound message_id=500");
    expect(working.stdout).toContain("ACK_WORKING stream=inbound message_id=501");
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test.each(["", "999", "malformed"])("show never exposes content that current authorization cannot verify (%s)", async (allowed) => {
  const dir = await mkdtemp(join(tmpdir(), "show-withheld-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    const saved = allowed === "malformed" ? '{"content":"private-unverified-content"' :
      JSON.stringify(message("500", { content: "private-unverified-content" }));
    queue.stage("inbound", "500", saved);
    const { stdout } = await invoke(dir, ["show", "inbound", "500"], {
      DORI_DISCORD_ALLOWED: allowed && allowed !== "malformed" ? allowed : "100", ...(allowed ? {} : { DORI_DISCORD_TOKEN: "" }),
    });
    expect(stdout).toStartWith("ACK_WITHHELD 500:");
    expect(stdout).not.toContain("private-unverified-content");
    expect(queue.pending("inbound")).toEqual([{ id: "500", payload: saved }]);
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("show reports terminal outcomes without requiring Discord authorization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "show-handled-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    queue.stage("context", "500", '{"content":"handled private body"}');
    queue.acknowledge("context", "500");
    const { stdout } = await invoke(dir, ["show", "context", "500"], { DORI_DISCORD_TOKEN: "" });
    expect(JSON.parse(stdout.slice("ACK_HANDLED ".length))).toMatchObject({ message_id: "500", disposition: "done" });
    expect(stdout).not.toContain("handled private body");
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test.each(["inbound", "context"])("pending %s pages a large backlog within fifty kilobytes", async (stream) => {
  const dir = await mkdtemp(join(tmpdir(), "pending-pages-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    for (let id = 500; id < 700; id++) {
      const payload = stream === "inbound" ? message(String(id), { content: "😃".repeat(2_000) }) :
        { message_id: String(id), message_type: 0, channel_id: "104", human_verified: true, bot: false, content: "😃".repeat(2_000) };
      queue.stage(stream === "inbound" ? "inbound" : "context", String(id), JSON.stringify(payload));
    }
    const seen: string[] = [];
    let args = ["pending", stream];
    for (;;) {
      const { stdout, stderr } = await invoke(dir, args);
      expect(Buffer.byteLength(stdout + stderr)).toBeLessThan(50_000);
      const rows = stdout.split("\n").filter((line) => line.startsWith(`${stream.toUpperCase()} `));
      expect(rows.every((line) => line.length <= 1000)).toBe(true);
      for (const row of rows) {
        const summary = JSON.parse(row.slice(8));
        seen.push(stream === "inbound" ? summary.message_ids[0] : summary.message_id);
      }
      const next = /next="ack ([^"]+)"/.exec(stdout)?.[1];
      if (!next) break;
      args = next.split(" ");
    }
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => String(500 + i)));
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("reminders begin at five minutes, exclude accepted and working items, and stop at zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reminder-contract-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const conversations = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    for (const id of ["500", "501", "502"]) queue.stage("inbound", id, JSON.stringify(message(id)));
    queue.accept("501", NOW);
    conversations.claimWorking("100", "99", "502", NOW);
    expect(pendingReminder(queue, conversations, NOW + 299_999)).toBeUndefined();
    expect(pendingReminder(queue, conversations, NOW + 300_000)).toBe("INBOUND_PENDING count=1 oldest=500");
    setSystemTime(new Date(NOW + 600_000));
    queue.acknowledge("inbound", "500");
    expect(pendingReminder(queue, conversations, NOW + 600_000)).toBeUndefined();
  } finally { setSystemTime(); queue.close(); conversations.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("inbound schedules the pending reminder separately from ten-minute reaction upkeep", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reminder-timer-"));
  try {
    const { stdout } = await invoke(dir, [], { DORI_TEST_PENDING_TIMER: "1", DORI_TEST_ADDRESSED_INPUT: "reply" });
    expect(stdout.split("\n").filter((line) => line.startsWith("TEST_INTERVAL ")).sort())
      .toEqual(["TEST_INTERVAL 15000", "TEST_INTERVAL 300000", "TEST_INTERVAL 600000"]);
    expect(stdout.split("\n").filter((line) => line.startsWith("INBOUND_PENDING ")))
      .toEqual(["INBOUND_PENDING count=1 oldest=11"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a malformed retained delivery stays visible to the pending safety net", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reminder-malformed-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const conversations = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    queue.stage("inbound", "500", "malformed");
    expect(pendingReminder(queue, conversations, NOW)).toBe("INBOUND_PENDING count=1 oldest=500");
  } finally { queue.close(); conversations.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test.each(["300", null])("authorized turn references include message destinations and named profiles without changing source (%s)", guild => {
  const raw = { message_id: "500", channel_id: "104", author_id: "66", author: "James [staff]",
    content: "Literal <@77>", mentioned_users: { "77": "Other user" },
    discord_origin: { guild_id: guild }, channel_policy: "trusted" };
  const before = JSON.stringify(raw);

  const rendered = JSON.parse(renderTurn([raw]).slice("ACK_TURN ".length)).turn.messages[0];

  expect(rendered.message_url).toBe(`https://discord.com/channels/${guild ?? "@me"}/104/500`);
  expect(rendered.author_reference).toBe("**[James \\[staff\\]](<https://discord.com/users/66>)**");
  expect(rendered.user_references["77"]).toBe("**[Other user](<https://discord.com/users/77>)**");
  expect(rendered.content).toBe("Literal <@77>");
  expect(JSON.stringify(raw)).toBe(before);
});

test.each(["trusted", "normal"])("render-time budgets bound legacy context and expose section pagination (%s)", (policy) => {
  const entry = (i: number) => ({ message_id: String(i), author_id: "66", author: "[".repeat(100),
    content: "c".repeat(10_000), sent_at: "2026-11-02T12:00:00Z" });
  const raw = message("500", {
    channel_policy: policy, content: "t".repeat(40_000), discord_origin: { guild_id: "300" },
    conversation: { topic: "Existing topic", summary: "s".repeat(600), state: "on_hold",
      recently_resolved: { topic: "Previous request", summary: "r".repeat(600), outcome: "answered" },
      anchor_message_id: "1", opened_at: "2026-11-01",
      transcript: Array.from({ length: 100 }, (_, i) => entry(i)), recent: Array.from({ length: 10 }, (_, i) => entry(i + 100)) },
    reply_context: { messages: Array.from({ length: 12 }, (_, i) => entry(i + 200)) },
    preceding: Array.from({ length: 10 }, (_, i) => entry(i + 300)),
  });
  const text = renderTurn([raw]);
  expect(text.length).toBeLessThanOrEqual(20_000);
  const result = JSON.parse(text.slice("ACK_TURN ".length));
  for (const [name, limit] of [["turn", 8000], ["conversation", 4000], ["channel_since_last_claim", 2000], ["reply_chain", 6000], ["preceding", 1500]] as const) {
    expect(JSON.stringify(result[name]).length).toBeLessThanOrEqual(limit);
    expect(result[name].truncated).toBe(true);
    expect(result[name].read_more).toContain(`--section ${name}`);
    const entries = result[name].messages ?? result[name].transcript ?? [];
    for (const entry of entries) {
      if (entry.author_reference !== undefined) expect(entry.author_reference).toMatch(/>\)\*\*$/);
      if (entry.message_url !== undefined) expect(entry.message_url).toBe(`https://discord.com/channels/300/100/${entry.message_id}`);
    }
  }
  expect(result.reply_chain.messages).toHaveLength(policy === "normal" ? 1 : 6);
  expect(result.conversation.earlier_entries).toBe(94);
  expect([result.conversation.summary, result.conversation.state]).toEqual(["s".repeat(600), "on_hold"]);
  expect(result.conversation.recently_resolved.summary).toBe("r".repeat(600));
  expect(result.turn.messages[0].conversation).toBeUndefined();
});

test("context summaries and authorized detail pages bound hundred-thousand-character records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-details-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    const payload = JSON.stringify({ message_id: "500", message_type: 0, channel_id: "104", bot: false, human_verified: true, content: "z".repeat(100_000) });
    queue.stage("context", "500", payload);
    expect(contextSummary("500", payload).length).toBeLessThanOrEqual(1000);
    const first = await invoke(dir, ["show", "context", "500"]);
    const page = JSON.parse(first.stdout.slice("ACK_CONTEXT ".length));
    expect(first.stdout.length).toBeLessThan(20_000);
    expect(page.truncated).toBe(true);
    const next = await invoke(dir, page.read_more.split(" ").slice(1));
    expect(JSON.parse(next.stdout.slice("ACK_CONTEXT ".length)).offset).toBe(page.content.length);
    const denied = await invoke(dir, ["show", "context", "500"], { DORI_DISCORD_CONTEXT_EXCLUDED: "104" });
    expect(denied.stdout).toStartWith("ACK_WITHHELD 500:");
    expect(denied.stdout).not.toContain("zzzz");
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("inbound section pages expose omitted legacy transcript entries after authorization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "section-details-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    queue.stage("inbound", "500", JSON.stringify(message("500", {
      conversation: { transcript: Array.from({ length: 100 }, (_, i) => ({ message_id: String(i), content: `entry ${i}` })) },
    })));
    const { stdout } = await invoke(dir, ["show", "inbound", "500", "--section", "conversation"]);
    let page = JSON.parse(stdout.slice("ACK_SECTION ".length));
    let content = page.content;
    while (page.read_more) {
      const next = await invoke(dir, page.read_more.split(" ").slice(1));
      page = JSON.parse(next.stdout.slice("ACK_SECTION ".length));
      content += page.content;
    }
    expect(JSON.parse(content)[0].transcript.map((entry: { message_id: string }) => entry.message_id))
      .toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a blacklisted sender's retained message and quoted history are withheld from ack, while the record is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blocked-ack-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    queue.stage("inbound", "777", JSON.stringify(message("777", {
      author_id: "501", author: "spammer", role: "STAFF_QUESTION", scope: "answer-only", content: "<@88> blocked-secret",
      discord_origin: authorizationMetadata({ id: "777", type: 0, channel_id: "100", guild_id: "300", author: { id: "501", username: "spammer" },
        content: "<@88> blocked-secret", timestamp: new Date(NOW).toISOString() }),
    })));
    queue.accept("777", NOW);
    queue.stage("inbound", "778", JSON.stringify(message("778", {
      reply_context: { status: "complete", messages: [{ message_id: "770", author_id: "501", author: "spammer", content: "quoted-secret" }] },
    })));
    queue.block("501", { source: "owner", reason: "spam", by: "99" }, new Set(["99"]));
    const shown = await invoke(dir, ["show", "inbound", "777,778"]);
    expect(shown.stdout + shown.stderr).not.toContain("blocked-secret");
    expect(shown.stdout + shown.stderr).not.toContain("quoted-secret");
    expect(shown.stdout).toContain("ACK_WITHHELD 777");
    expect(queue.status("inbound", "777").disposition).toBe("accepted");
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ack show keeps the conversation a reply was routed to, not the person's most recent topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routed-ack-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const conversations = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    conversations.open("100", "99", "400", "logs topic", NOW - 2_000);
    conversations.open("100", "99", "450", "roles topic", NOW - 1_000);
    queue.stage("inbound", "500", JSON.stringify(message("500", { reply_to: "400",
      discord_origin: authorizationMetadata({ id: "500", type: 19, channel_id: "100", guild_id: "300", author: { id: "99", username: "owner" },
        content: "<@88> request", timestamp: new Date(NOW).toISOString(), message_reference: { message_id: "400" } }) })));
    const shown = await invoke(dir, ["show", "inbound", "500"]);
    // The reply binds its own topic; the person's other topic is only listed beside it.
    const conversation = JSON.parse(shown.stdout.slice("ACK_TURN ".length)).conversation;
    expect(conversation.topic).toBe("logs topic");
    expect(conversation.other_topics.map((topic: { title: string }) => topic.title)).toEqual(["roles topic"]);
  } finally { queue.close(); conversations.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("the default lead view preserves structured corrections beyond six messages and keeps examples distinct from current requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "structured-lead-view-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const conversations = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    conversations.open("100", "99", "400", "registration", NOW - 1000);
    const fields = { request: "Investigate EU registration", decided: "EU, not NA; the old close command was an example",
      waiting_on: "Owner to provide the error", result: "PR #22 merged; do not implement it again" };
    conversations.setState("100", "99", fields);
    for (let i = 0; i < 10; i++) conversations.append("100", "99", {
      message_id: String(410 + i), author_id: "88", author: "Helio", bot: true, sent_at: new Date(NOW - 500 + i).toISOString(),
      content: `discussion ${i}`, attachment_count: 0 }, NOW - 500 + i);
    const example = 'Example only: "close the issue". Current request: investigate registration, not closure.';
    queue.stage("inbound", "500", JSON.stringify(message("500", { content: example })));
    const shown = await invoke(dir, ["show", "inbound", "500"]);
    const turn = JSON.parse(shown.stdout.slice("ACK_TURN ".length));
    expect(Object.fromEntries(Object.keys(fields).map((name) => [name, turn.conversation[name]]))).toEqual(fields);
    expect(turn.conversation.transcript.map((entry: { message_id: string }) => entry.message_id))
      .toEqual(["414", "415", "416", "417", "418", "419"]);
    expect(turn.turn.messages[0].content).toBe(example);
  } finally { queue.close(); conversations.dispose(); await rm(dir, { recursive: true, force: true }); }
});
