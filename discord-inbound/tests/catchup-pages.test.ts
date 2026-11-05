import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";

/** Runs a real inbound catch-up over 150 messages in normal chat 104; `author` and `ping` pick who wrote message n and whether it pings Helio. */
async function catchUp(history: { author: string; ping: string; blocked?: string }, cursor?: string) {
  const dir = await mkdtemp(join(tmpdir(), "catchup-pages-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  if (cursor) await Bun.write(join(dir, "discord-inbound.json"), JSON.stringify({ "104": cursor }));
  if (history.blocked) {
    const seed = new Delivery(join(dir, "discord-delivery.sqlite"));
    try { seed.block(history.blocked, { source: "owner", reason: "spam", by: "99" }, new Set(["99"])); } finally { seed.close(); }
  }
  const preload = join(dir, "history.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
const timestamp = new Date(Date.now() - 3_600_000).toISOString();
const history = Array.from({ length: 150 }, (_, i) => {
  const n = i + 1, ping = ${history.ping};
  return { id: String(1000 + n), channel_id: "104", guild_id: "300", author: { id: ${history.author}, username: "someone" },
    content: ping ? "<@88> request " + n : "chatter " + n, timestamp, attachments: [], mentions: ping ? [{ id: "88" }] : [] };
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
  const staged = (id: string) => delivery.contains("inbound", id);
  onTestFinished(() => delivery.close());
  return { stdout, staged, cursor: async () => (await Bun.file(join(dir, "discord-inbound.json")).json())["104"] };
}

test("catch-up delivers pings from every history page of a normal chat, not only the last page fetched", async () => {
  const run = await catchUp({ author: '"77"', ping: "n === 30 || n === 150" }, "1");
  expect([run.staged("1030"), run.staged("1150")]).toEqual([true, true]);
  expect(run.stdout).not.toContain("INBOUND_GAP");
  expect(await run.cursor()).toBe("1150");
});

test("the owner's ordinary chatter in a normal chat does not use up the catch-up cap a member's ping needs", async () => {
  const run = await catchUp({ author: 'n === 30 ? "77" : "99"', ping: "n === 30" }, "1");
  expect(run.staged("1030")).toBe(true);
  expect(run.stdout).not.toContain("INBOUND_GAP");
});

test("blocked senders never consume the cap needed by an older eligible request", async () => {
  const run = await catchUp({ author: 'n === 30 ? "77" : "501"', ping: "true", blocked: "501" }, "1");
  expect(run.staged("1030")).toBe(true);
  expect(run.stdout).not.toContain("INBOUND_GAP");
});

test("a first catch-up cut by the cap records its gap even without an earlier cursor", async () => {
  const run = await catchUp({ author: '"77"', ping: "true" });
  expect([run.staged("1050"), run.staged("1051")]).toEqual([false, true]);
  expect(run.stdout).toContain('INBOUND_GAP {"id":');
});
