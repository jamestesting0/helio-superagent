import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";

test("catch-up delivers pings from every history page of a normal chat, not only the last page fetched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catchup-pages-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await Bun.write(join(dir, "discord-inbound.json"), '{"104":"1"}');
  const preload = join(dir, "history.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
const history = Array.from({ length: 150 }, (_, i) => {
  const n = i + 1, ping = n === 30 || n === 150;
  return { id: String(1000 + n), channel_id: "104", guild_id: "300", author: { id: "77", username: "member" },
    content: ping ? "<@88> request " + n : "chatter " + n, timestamp: "2026-11-02T11:00:00Z", attachments: [],
    mentions: ping ? [{ id: "88" }] : [] };
}).reverse();
const fixture = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/v10/channels/104/messages") {
    const before = url.searchParams.get("before");
    const older = before ? history.filter((m) => BigInt(m.id) < BigInt(before)) : history;
    return Response.json(older.slice(0, Number(url.searchParams.get("limit") ?? 100)));
  }
  return fixture(input, init);
}, { preconnect: fixture.preconnect });
Listener.prototype.start = async function () {
  this.emit("connected", { user: { id: "88", username: "Helio" }, sessionId: "test" });
};
`);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "fixture", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "104", DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_TEST_INTERACTION: "",
      DORI_TEST_TURNS: "", DORI_TEST_REPLIES: "", DORI_TEST_UNKNOWN_BOT: "" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    expect([delivery.contains("inbound", "1030"), delivery.contains("inbound", "1150")]).toEqual([true, true]);
  } finally { delivery.close(); }
  expect(stdout).not.toContain("INBOUND_GAP");
  expect((await Bun.file(join(dir, "discord-inbound.json")).json())["104"]).toBe("1150");
});
