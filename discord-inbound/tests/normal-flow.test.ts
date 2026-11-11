import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { deliveryOutput } from "../fixtures/delivery-output.ts";
import { Conversations } from "../conversations/conversations.ts";

async function run(dir: string, options: {
  readonly trusted?: boolean; readonly unknown?: boolean; readonly script?: string; readonly args?: readonly string[];
  readonly liveReply?: boolean; readonly replyParent?: boolean; readonly replyImage?: boolean;
} = {}) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "..", options.script ?? "inbound.ts"), ...(options.args ?? []),
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: options.trusted ? "100" : "",
      DORI_DISCORD_NORMAL_CHANNELS: "", DORI_TEST_REPLY_PARENT: options.replyParent ? "1" : "",
      DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined,
      DORI_TEST_REPLIES: "1", DORI_TEST_PING_REPLY: "1", DORI_TEST_TRACE_READS: "1",
      DORI_TEST_FORWARDS: "1", DORI_TEST_UNKNOWN_BOT: options.unknown ? "1" : "",
      DORI_TEST_LIVE_REPLY: options.liveReply ? "1" : "",
      DORI_TEST_REPLY_IMAGE: options.replyImage ? "1" : "",
      DORI_TEST_REFRESH: "", DORI_TEST_TRUSTED_DMS: "", DORI_TEST_NULL_PARENT: "", DORI_TEST_BUG_REPORTS: "", DORI_TEST_ARCHIVED: "",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout: stdout.includes("INBOUND ") ? deliveryOutput(dir, stdout) : stdout, stderr, exitCode };
}
const records = (stdout: string): Record<string, unknown>[] => stdout.split("\n")
  .filter((line) => line.startsWith("INBOUND ")).map((line) => JSON.parse(line.slice(8)));
const reads = (stdout: string): unknown[] => stdout.split("\n")
  .filter((line) => line.startsWith("TEST_READ ")).map((line) => JSON.parse(line.slice(10)));

test("prepared but unclaimed normal input preserves the outstanding question across intake and replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-unclaimed-question-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const now = Date.parse("2026-11-02T12:00:00Z");
  try {
    const topic = store.open("100", "99", "1", "Server selection", now - 10_000);
    store.applyReply(topic, { disposition: "question", waiting_on: "Which server?" }, now - 9_000);
    const before = store.get("100", "99", "1");
    for (const result of [await run(dir), await run(dir)]) {
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(records(result.stdout).some(message => message.message_id === "10")).toBe(true);
    }
    expect(store.get("100", "99", "1")).toMatchObject({
      waiting_on: "Which server?", question_started_at: now - 9_000,
      last_activity: before?.last_activity, reply_disposition: "question",
    });
    expect(store.working("10")?.claimed_at ?? null).toBeNull();
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const pending = queue.pending("inbound").find(item => item.id === "10");
      if (!pending) throw new Error("Fixture request was not staged");
      queue.recovery.review(pending.id, pending.payload, {
        outcome: "resume", reason: "The fixture requester still needs the server decision", evidence: "{}",
      });
    } finally { queue.close(); }

    const claimed = await run(dir, { script: "ack.ts", args: ["working", "inbound", "10"] });

    expect(claimed.exitCode).toBe(0);
    expect(claimed.stdout).toContain("ACK_WORKING stream=inbound message_id=10");
    expect(store.get("100", "99", "1")).toMatchObject({ waiting_on: "", question_started_at: null });
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test.each([false, true])("history and live non-pings never stage or prepare attachments/forwards (trusted %s)", async trusted => {
  const dir = await mkdtemp(join(tmpdir(), "dori-normal-gate-"));
  try {
    const result = await run(dir, { trusted });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(records(result.stdout).map((message) => [message.message_id, message.channel_policy]))
      .toEqual([["10", trusted ? "trusted" : "normal"], ["90", trusted ? "trusted" : "normal"]]);
    const later = records(result.stdout).find(message => message.message_id === "90");
    expect(later?.conversation).toMatchObject({
      context_status: "cached",
      recent: expect.arrayContaining([expect.objectContaining({ message_id: "11" })]),
    });
    expect(reads(result.stdout).filter(read => typeof read === "object" && read !== null && "kind" in read && read.kind === "attachment"))
      .toEqual([{ kind: "attachment", file: "photo.png" }]);
    if (!trusted) expect(reads(result.stdout)).not.toContainEqual(expect.objectContaining({ kind: "ancestor" }));
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10", "90"]);
      expect(queue.contains("inbound", "11")).toBe(false);
      expect(queue.contains("inbound", "21")).toBe(false);
      expect(queue.contains("inbound", "22")).toBe(false);
      const before = queue.pending("inbound");
      const context = await run(dir, { trusted, script: "ack.ts", args: ["context", "inbound", "90"] });
      expect({ code: context.exitCode, stderr: context.stderr, evidence: context.stdout }).toMatchObject({ code: 0, stderr: "" });
      const evidence = JSON.parse(context.stdout.split("\n").find(line =>
        line.startsWith("ACK_EVIDENCE "))?.slice("ACK_EVIDENCE ".length) ?? "{}").context_evidence;
      expect(evidence).toMatchObject({ root_id: "90", provenance: "live_refetch" });
      expect(evidence.messages.some((entry: { message_id: string }) => entry.message_id === "11")).toBe(true);
      expect(evidence.messages.every((entry: { message_id: string }) => BigInt(entry.message_id) < 90n)).toBe(true);
      expect(queue.pending("inbound")).toEqual(before);
      expect(context.stdout.length).toBeLessThanOrEqual(12_000);
    } finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown identity is withheld without losing pending, and a now-normal reply keeps only its parent", async () => {
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
    const chain = (message: Record<string, unknown>) => message.reply_context as { status: string; messages: { message_id: string }[] } | undefined;
    expect(records(known.stdout).map((message) => [message.message_id, chain(message)?.status,
      chain(message)?.messages.map((m) => m.message_id)]))
      .toEqual([["10", undefined, undefined], ["90", "parent_only", ["89"]]]);
    expect(reads(known.stdout)).toEqual([]);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10", "90"]);
    } finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([true, false])("a normal-chat ping that replies to a bot embed carries that one message, read from the event without any lookup (live %s)", async (liveReply) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-normal-parent-"));
  try {
    const result = await run(dir, { replyParent: true, liveReply });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    const reply = records(result.stdout).find((message) => message.message_id === "90") as { reply_context?: { status: string; messages: Record<string, unknown>[] } };
    expect(reply.reply_context?.status).toBe("parent_only");
    expect(reply.reply_context?.messages.map((m) => [m.message_id, m.embed_text, m.component_text])).toEqual([
      ["89", ["Final blocked", "Reason", "browser not connected"], ["[button: Retry]"]],
    ]);
    expect(reads(result.stdout)).not.toContainEqual(expect.objectContaining({ kind: "ancestor" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([false, true])("a reply image reaches the reader through ack show and lives until the replying request is handled (trusted %s)", async (trusted) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-reply-image-"));
  const options = { trusted, replyParent: true, replyImage: true, liveReply: true };
  try {
    const intake = await run(dir, options);
    expect({ code: intake.exitCode, stderr: intake.stderr }).toEqual({ code: 0, stderr: "" });
    if (!trusted) expect(reads(intake.stdout)).not.toContainEqual(expect.objectContaining({ kind: "ancestor" }));

    const shown = await run(dir, { ...options, script: "ack.ts", args: ["show", "inbound", "90"] });
    expect({ code: shown.exitCode, stderr: shown.stderr }).toEqual({ code: 0, stderr: "" });
    const turn = JSON.parse(shown.stdout.split("\n").find(line => line.startsWith("ACK_TURN "))?.slice(9) ?? "{}");
    const parent = turn.reply_chain.messages.find((entry: { message_id: string }) => entry.message_id === "89");
    expect(parent.attachment_count).toBe(1);
    expect(parent.blocked_attachments).toEqual([]);
    expect(parent.attachments).toHaveLength(1);
    const image = parent.attachments[0];
    expect({ name: image.name, kind: image.kind, width: image.width, height: image.height })
      .toEqual({ name: "photo.png", kind: "image", width: 1, height: 1 });
    expect(image.path).toStartWith(join(dir, "attachments/inbound/pending/90") + "/");
    const bytes = Buffer.from(await Bun.file(image.path).arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const handled = await run(dir, { ...options, script: "ack.ts", args: ["done", "inbound", "90"] });
    expect({ code: handled.exitCode, stderr: handled.stderr }).toEqual({ code: 0, stderr: "" });
    expect(await Bun.file(image.path).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("one irrelevant call dismisses a whole turn and leaves an unrecordable ID pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-irrelevant-turn-"));
  try {
    const intake = await run(dir);
    expect(intake.exitCode).toBe(0);
    const staged = records(intake.stdout).map(message => String(message.message_id));
    expect(staged).toEqual(expect.arrayContaining(["10", "90"]));
    const result = await run(dir, { script: "ack.ts", args: ["irrelevant", "inbound", "10,90,999", "Reviewed: unrelated chatter"] });
    expect(result.stdout).toContain("ACK_IRRELEVANT stream=inbound message_id=10");
    expect(result.stdout).toContain("ACK_IRRELEVANT stream=inbound message_id=90");
    expect(result.stdout).toContain("ACK_WITHHELD 999:");
    expect(result.exitCode).toBe(1);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      expect(["10", "90"].map(id => queue.status("inbound", id).disposition)).toEqual(["irrelevant", "irrelevant"]);
    } finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
