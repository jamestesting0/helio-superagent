import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Delivery } from "../delivery/delivery.ts";
import { deliveryOutput } from "../fixtures/delivery-output.ts";
import { authorizationMetadata } from "../intake/authorization.ts";

async function invoke(dir: string, settings: {
  readonly prepareFailure?: boolean; readonly authorizationFailure?: boolean;
  readonly allowed?: string; readonly trusted?: string; readonly normal?: string;
  readonly inaccessible?: boolean; readonly script?: string; readonly args?: readonly string[];
  readonly policyTransient?: boolean;
} = {}) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "..", settings.script ?? "inbound.ts"), ...(settings.args ?? []),
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: settings.allowed ?? "100", DORI_DISCORD_TRUSTED_CHANNELS: settings.trusted ?? "100",
      DORI_DISCORD_NORMAL_CHANNELS: settings.normal ?? "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_TEST_ADDRESSED_INPUT: (settings.trusted ?? "100") === "100" ? "ping" : "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined,
      DORI_TEST_PREPARE_FAILURE: settings.prepareFailure ? "1" : "",
      DORI_TEST_AUTH_FAILURE: settings.authorizationFailure ? "1" : "",
      DORI_TEST_POLICY_TRANSIENT: settings.policyTransient ? "1" : "",
      DORI_TEST_INACCESSIBLE_MESSAGE: settings.inaccessible ? "1" : "",
      DORI_TEST_TRACE_RECOVERY: "1",
      DORI_TEST_REFRESH: "", DORI_TEST_FORWARDS: "", DORI_TEST_TRUSTED_DMS: "", DORI_TEST_NULL_PARENT: "",
      DORI_TEST_BUG_REPORTS: "", DORI_TEST_REPLIES: "", DORI_TEST_PING_REPLY: "", DORI_TEST_LIVE_REPLY: "",
      DORI_TEST_UNKNOWN_BOT: "", DORI_TEST_ARCHIVED: "", DORI_TEST_TRACE_READS: "",
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

test("a temporarily blocked channel cannot advance its cursor past missed requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-policy-gap-"));
  try {
    const cursor = '{"100":"1","200":"1"}';
    await Bun.write(join(dir, "discord-inbound.json"), cursor);
    const failed = await invoke(dir, { policyTransient: true });
    expect(failed.exitCode).toBe(0);
    expect(failed.stdout).toContain("cursor retained");
    expect(records(failed.stdout)).toEqual([]);
    expect(await Bun.file(join(dir, "discord-inbound.json")).json()).toEqual(JSON.parse(cursor));
    const recovered = await invoke(dir);
    expect(recovered.exitCode).toBe(0);
    expect(records(recovered.stdout).map((message) => message.message_id)).toEqual(["10", "11"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  { prepareFailure: true, allowed: "100", error: "TEST_PREPARATION_FAILURE" },
  { authorizationFailure: true, allowed: "400", error: "TEST_AUTHORIZATION_FAILURE" },
])("a failed preparation or authorization stops later cursor advancement and recovers real evidence on restart: %j", async (settings) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-recovery-failure-"));
  try {
    await Bun.write(join(dir, "discord-inbound.json"), '{"100":"1","200":"1"}');
    const failed = await invoke(dir, settings);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain(settings.error);
    expect(records(failed.stdout)).toEqual([]);
    expect(await Bun.file(join(dir, "discord-inbound.json")).json()).toEqual({ "100": "1", "200": "1" });
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    // A preparation failure keeps the authorized message staged but unprepared, hidden until restart prepares it.
    try { expect(queue.pending("inbound").map((item) => [item.id, JSON.parse(item.payload).preparation_complete]))
      .toEqual(settings.prepareFailure ? [["10", false]] : []); }
    finally { queue.close(); }
    const retry = await invoke(dir);
    expect({ exitCode: retry.exitCode, stderr: retry.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(records(retry.stdout).map((message) => message.message_id)).toEqual(["10", "11"]);
    const attachment = records(retry.stdout)[0]?.attachments;
    if (!Array.isArray(attachment) || typeof attachment[0]?.path !== "string") throw new Error("Missing recovered evidence");
    expect(await Bun.file(attachment[0].path).exists()).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("incomplete preparation stays private on ack replay and recovers evidence safely from the bounded history page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-incomplete-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    queue.stage("inbound", "10", JSON.stringify({
      message_id: "10", channel_id: "100", content: "unprepared private evidence", sent_at: "2026-11-02T12:00:00Z",
      discord_origin: authorizationMetadata({
        id: "10", type: 0, channel_id: "100", guild_id: "300", author: { id: "99", username: "owner" },
        content: "<@88> request", timestamp: "2026-11-02T12:00:00Z",
      }),
    }));
    await Bun.write(join(dir, "discord-inbound.json"), '{"100":"11","200":"1"}');
    const pending = await invoke(dir, { script: "ack.ts", args: ["pending", "inbound"] });
    expect(pending.exitCode).toBe(0);
    expect(records(pending.stdout)).toEqual([]);
    expect(pending.stderr).toContain("preparation");
    expect(queue.status("inbound", "10").disposition).toBe("pending");
    const watcher = await invoke(dir);
    expect(watcher.exitCode).toBe(0);
    expect(records(watcher.stdout).map((message) => [message.message_id, message.content, message.preparation_complete]))
      .toEqual([["10", "message 10", true], ["11", "message 11", true]]);
    expect(queue.status("inbound", "10").disposition).toBe("pending");
    expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10", "11"]);
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  { trusted: "", expected: ["10"] },
  { trusted: "100", expected: ["10", "11"] },
])("legacy IDs older than the cursor recover only authorized newest-page messages: %j", async ({ trusted, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-legacy-page-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    for (const id of ["5", "10", "11"]) {
      queue.stage("inbound", id, JSON.stringify({
        message_id: id, channel_id: "100", content: "legacy text", author_id: "77",
        role: "OWNER_REQUEST", sent_at: "2026-11-02T12:00:00Z",
      }));
    }
    await Bun.write(join(dir, "discord-inbound.json"), '{"100":"11","200":"1"}');
    const result = await invoke(dir, { trusted });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(records(result.stdout).map((message) => message.message_id)).toEqual([...expected]);
    expect(records(result.stdout).every((message) => message.author_id === "99" && message.preparation_complete === true)).toBe(true);
    expect(queue.pending("inbound").map((item) => item.id)).toEqual(["5", "10", "11"]);
    expect(queue.pending("inbound").find((item) => item.id === "5")?.payload).toContain('"content":"legacy text"');
    expect(result.stdout.split("\n").filter((line) => line.startsWith("INBOUND_WARN ") && line.includes("message_id=5"))
      .some((line) => line.includes("newest-100"))).toBe(true);
    const gets: unknown[] = result.stdout.split("\n").filter((line) => line.startsWith("TEST_RECOVERY_GET "))
      .map((line) => JSON.parse(line.slice("TEST_RECOVERY_GET ".length)));
    expect(gets).toEqual([{ channel: "100", kind: "history" }, { channel: "200", kind: "history" }]);
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history migration never rewrites or redispatches an already accepted legacy request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-accepted-migration-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    const original = JSON.stringify({ message_id: "10", channel_id: "100", content: "accepted work", sent_at: "2026-11-02T12:00:00Z" });
    queue.stage("inbound", "10", original);
    queue.accept("10", Date.parse("2026-11-02T12:00:00Z"));
    await Bun.write(join(dir, "discord-inbound.json"), '{"100":"11","200":"1"}');
    const result = await invoke(dir);
    expect(result.exitCode).toBe(0);
    expect(records(result.stdout).map((message) => message.message_id)).toEqual(["11"]);
    expect(queue.pending("inbound").filter((item) => item.id === "10")).toEqual([{ id: "10", payload: original }]);
    expect(queue.status("inbound", "10").disposition).toBe("accepted");
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  { trusted: "100", normal: "1566842840716152962", expected: ["10", "11"] },
  { trusted: "1566842840716152962", normal: "100", expected: ["10"] },
])("inaccessible configured channels block only that channel and never grant trust: %j", async ({ trusted, normal, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-inaccessible-policy-"));
  try {
    const result = await invoke(dir, { allowed: "100,1566842840716152962", trusted, normal, inaccessible: true });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(records(result.stdout).map((message) => message.message_id)).toEqual([...expected]);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("INBOUND_WARN ")).length).toBe(3);
    expect((await Bun.file(join(dir, "discord-inbound.json")).json())["1566842840716152962"]).toBeUndefined();
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try { expect(queue.contains("inbound", "40")).toBe(false); }
    finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pending replay performs channel checks but no per-message GETs beyond bounded history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-recovery-budget-"));
  try {
    expect((await invoke(dir)).exitCode).toBe(0);
    const replay = await invoke(dir);
    expect({ exitCode: replay.exitCode, stderr: replay.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(records(replay.stdout).map((message) => message.message_id)).toEqual(["10", "11"]);
    const gets: unknown[] = replay.stdout.split("\n").filter((line) => line.startsWith("TEST_RECOVERY_GET "))
      .map((line) => JSON.parse(line.slice("TEST_RECOVERY_GET ".length)));
    expect(gets).toEqual([{ channel: "100", kind: "history" }, { channel: "200", kind: "history" }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
