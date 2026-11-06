import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";

test("a slow upkeep request never holds back a live message: it stages while upkeep waits on Discord", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upkeep-independent-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const seed = new Delivery(join(dir, "discord-delivery.sqlite"));
  // A blocked sender whose 🚫 reaction is still owed: the first upkeep pass sends it.
  seed.block("66", { source: "auto", reason: "fixture", by: "auto", evidenceMessageId: "800", evidenceChannelId: "104" }, new Set(["99"]));
  seed.close();
  const preload = join(dir, "gateway.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
import { Delivery } from ${JSON.stringify(join(import.meta.dir, "../delivery/delivery.ts"))};
const staged = Promise.withResolvers();
const stage = Delivery.prototype.stage;
Delivery.prototype.stage = function (stream, id, ...rest) {
  const result = stage.call(this, stream, id, ...rest);
  if (stream === "inbound" && id === "902") staged.resolve("TEST_STAGED_DURING_UPKEEP");
  return result;
};
const fetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  if (new URL(String(input)).pathname.startsWith("/api/v10/channels/104/messages/800/reactions/")) {
    // Held until the live message stages; a bounded fallback turns the old deadlock into a visible failure.
    let timer;
    const fallback = new Promise((resolve) => { timer = setTimeout(() => resolve("TEST_UPKEEP_RELEASED_BY_TIMEOUT"), 5_000); });
    console.log(await Promise.race([staged.promise, fallback]));
    clearTimeout(timer);
    return new Response(null, { status: 204 });
  }
  return fetch(input, init);
}, { preconnect: fetch.preconnect });
Listener.prototype.start = async function () {
  this.emit("connected", { user: { id: "88", username: "Helio" }, sessionId: "test" });
  this.emit("message_create", { type: "MESSAGE_CREATE", message_type: 0, id: "902", channel_id: "104", guild_id: "300", content: "<@88> live request",
    timestamp: new Date().toISOString(), author: { id: "99", username: "owner" }, attachments: [], mentions: [{ id: "88" }] });
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
  expect(stdout).toContain("TEST_STAGED_DURING_UPKEEP");
  expect(stdout).not.toContain("TEST_UPKEEP_RELEASED_BY_TIMEOUT");
});
