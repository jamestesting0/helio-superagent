import { expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";

test("unsupported-only input settles quietly while short human text survives and system events never stage", async () => {
  const state = await mkdtemp(join(tmpdir(), "helio-quiet-input-"));
  onTestFinished(() => rm(state, { recursive: true, force: true }));
  await Bun.write(join(state, "discord-inbound.json"), JSON.stringify({ "104": "950", "200": "950" }));
  const preload = join(state, "gateway.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
const fixtureFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  if (init?.method && init.method !== "GET") console.log("TEST_WRITE " + String(input));
  return fixtureFetch(input, init);
}, {preconnect: fixtureFetch.preconnect});
Listener.prototype.start = async function () {
  this.emit("connected", {user: {id: "88", username: "Helio"}, sessionId: "test"});
  const base = {type: "MESSAGE_CREATE", message_type: 0, channel_id: "104", guild_id: "300",
    timestamp: new Date(Date.now()).toISOString(), author: {id: "99", username: "owner"}};
  this.emit("message_create", {...base, id: "951", content: "", attachments: [
    {filename: "notes.zip", url: "https://cdn.discordapp.com/attachments/1/2/notes.zip"}]});
  this.emit("message_create", {...base, id: "952", content: "hi", attachments: []});
  this.emit("message_create", {...base, message_type: 4, id: "953", content: "Title", attachments: []});
};
`);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_STATE_DIR: state, DORI_DISCORD_TOKEN: "fixture", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "104", DORI_DISCORD_TRUSTED_CHANNELS: "104", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_TEST_INTERACTION: "",
      DORI_TEST_TURNS: "", DORI_TEST_REPLIES: "", DORI_TEST_UNKNOWN_BOT: "" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const queue = new Delivery(join(state, "discord-delivery.sqlite"));
  const conversations = new Database(join(state, "discord-conversations.sqlite"), { readonly: true });
  try {
    expect(queue.status("inbound", "951").disposition).toBe("ignored");
    expect(queue.pending("inbound").map(row => row.id)).toEqual(["952"]);
    expect(queue.contains("inbound", "953")).toBe(false);
    expect(conversations.query("SELECT * FROM working WHERE message_id='951'").all()).toEqual([]);
    expect(stdout).not.toContain("/messages/951/");
    expect(stdout).not.toContain('"message_ids":["951"]');
    expect(stdout).toContain('"message_ids":["952"]');
    expect(stdout).not.toContain("INBOUND_WARN");
  } finally { queue.close(); conversations.close(); }
});
