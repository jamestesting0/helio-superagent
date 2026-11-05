import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a slow attachment in one channel does not delay another conversation's message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stage-first-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, "gateway.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
import { Database } from "bun:sqlite";
const fixtureFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  if (String(input).includes("slow-notes.txt")) {
    await Bun.sleep(1500);
    const db = new Database(${JSON.stringify(join(dir, "discord-delivery.sqlite"))}, { readonly: true });
    const row = db.query("SELECT payload FROM delivery WHERE stream='inbound' AND id='952'").get();
    db.close();
    console.log("TEST_DM_READY_DURING_SLOW_DOWNLOAD " + Boolean(row?.payload?.includes('"preparation_complete":true')));
    return new Response("notes", { headers: { "content-type": "text/plain" } });
  }
  return fixtureFetch(input, init);
}, { preconnect: fixtureFetch.preconnect });
Listener.prototype.start = async function () {
  this.emit("connected", { user: { id: "88", username: "Helio" }, sessionId: "test" });
  const at = new Date(Date.now()).toISOString();
  this.emit("message_create", { id: "951", channel_id: "104", guild_id: "300", content: "<@88> see notes", timestamp: at,
    author: { id: "99", username: "owner" }, mentions: [{ id: "88" }],
    attachments: [{ id: "1", filename: "slow-notes.txt", url: "https://cdn.discordapp.com/attachments/1/2/slow-notes.txt", content_type: "text/plain", size: 5 }] });
  this.emit("message_create", { id: "952", channel_id: "200", content: "quick question", timestamp: at,
    author: { id: "99", username: "owner" }, attachments: [] });
};
`);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "fixture", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "104", DORI_DISCORD_TRUSTED_CHANNELS: "104", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_TEST_INTERACTION: "",
      DORI_TEST_TURNS: "", DORI_TEST_REPLIES: "", DORI_TEST_UNKNOWN_BOT: "" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("TEST_DM_READY_DURING_SLOW_DOWNLOAD true");
  expect(stdout).toContain('"message_ids":["951"]');
  expect(stdout).toContain('"message_ids":["952"]');
}, 30_000);
