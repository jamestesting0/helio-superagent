import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");

async function intake() {
  const dir = await mkdtemp(join(tmpdir(), "moderation-flow-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const seed = new Delivery(join(dir, "discord-delivery.sqlite"));
  seed.block("501", { source: "owner", reason: "spam", by: "99" }, new Set(["99"]));
  seed.close();
  const preload = join(dir, "gateway.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
Listener.prototype.start = async function () {
  this.emit("connected", { user: { id: "88", username: "Helio" }, sessionId: "test" });
  const blocked = { id: "911", channel_id: "104", guild_id: "300", timestamp: new Date(${NOW} - 60000).toISOString(),
    author: { id: "501", username: "spammer" }, attachments: [], mentions: [{ id: "88" }] };
  Object.defineProperty(blocked, "content", { get() { console.log("TEST_BLOCKED_CONTENT_READ"); return "<@88> spam"; } });
  this.emit("message_create", blocked);
  for (let i = 0; i < 21; i++) {
    this.emit("message_create", { id: String(920 + i), channel_id: "104", guild_id: "300", content: "<@88> ping " + i,
      timestamp: new Date(${NOW} - (21 - i) * 1000).toISOString(), author: { id: "502", username: "eager" },
      attachments: [], mentions: [{ id: "88" }] });
  }
};
`);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "fixture", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "104", DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_TEST_INTERACTION: "",
      DORI_TEST_TURNS: "", DORI_TEST_REPLIES: "", DORI_TEST_UNKNOWN_BOT: "", DORI_TEST_TRACE_RECEIPTS: "1",
      HELIO_PING_LIMIT_PER_HOUR: "20" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    const staged = Array.from({ length: 21 }, (_, i) => delivery.contains("inbound", String(920 + i)));
    return { stdout, blocked: delivery.contains("inbound", "911"), staged };
  } finally { delivery.close(); }
}

test("a blacklisted sender's message is dropped before its content is read or staged", async () => {
  const result = await intake();
  expect(result.stdout).not.toContain("TEST_BLOCKED_CONTENT_READ");
  expect(result.blocked).toBe(false);
});

test("the 21st ping in an hour is not staged and gets one hourglass reaction", async () => {
  const result = await intake();
  expect(result.staged.slice(0, 20).every(Boolean)).toBe(true);
  expect(result.staged[20]).toBe(false);
  const hourglass = result.stdout.split("\n").filter((line) => line.startsWith("TEST_RECEIPT PUT") && line.includes("%E2%8F%B3"));
  expect(hourglass).toEqual(["TEST_RECEIPT PUT /api/v10/channels/104/messages/940/reactions/%E2%8F%B3/@me"]);
});
