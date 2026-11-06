import { expect, onTestFinished, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchedChannels } from "../intake/watched-channels.ts";
import { discordRest } from "../discord/rest.ts";
import { Delivery } from "../delivery/delivery.ts";

test("discovery excludes ignored parents and their directly authorized, active, and archived threads", async () => {
  const paths: string[] = [];
  const parent = (id: string) => ({ id, type: 0, parent_id: "400", guild_id: "300" });
  const thread = (id: string, parent_id: string) => ({ id, parent_id, type: 11, guild_id: "300",
    thread_metadata: { archived: true, archive_timestamp: new Date().toISOString() } });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    paths.push(path);
    if (path === "/channels/400") return Response.json({ id: "400", type: 4, guild_id: "300" });
    if (path === "/channels/103") return Response.json(thread("103", "100"));
    if (path === "/guilds/300/channels") return Response.json([parent("100"), parent("101")]);
    if (path === "/guilds/300/threads/active") return Response.json({ threads: [thread("103", "100"), thread("104", "101")] });
    if (path === "/channels/100/threads/archived/public") return Response.json({ threads: [thread("105", "100")], has_more: false });
    if (path === "/channels/101/threads/archived/public") return Response.json({ threads: [thread("106", "101")], has_more: false });
    if (path.includes("/users/@me/threads/archived/private")) return Response.json({ threads: [], has_more: false });
    if (path === "/users/@me/channels") return Response.json({ id: "200" });
    throw new Error(`Unexpected request ${path}`);
  }, { preconnect: fetch.preconnect }));
  onTestFinished(() => fetchSpy.mockRestore());
  const warnings: string[] = [];

  const watched = await watchedChannels({ ownerId: "99", allowed: new Set(["400", "103"]), ignoredChannels: new Set(["100"]) },
    discordRest("fixture"), (warning) => warnings.push(warning));

  expect(watched.map((channel) => channel.id)).toEqual(["101", "104", "106", "200"]);
  expect(paths.filter((path) => path.startsWith("/channels/100/"))).toEqual([]);
  expect(warnings).toEqual([]);
});

test("an allowed thread whose category is ignored is never discovered for catch-up", async () => {
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    paths.push(path);
    if (path === "/channels/107") return Response.json({ id: "107", type: 11, parent_id: "102", guild_id: "300" });
    if (path === "/channels/102") return Response.json({ id: "102", type: 0, parent_id: "500", guild_id: "300" });
    if (path === "/channels/500") return Response.json({ id: "500", type: 4, guild_id: "300" });
    if (path === "/guilds/300/threads/active") return Response.json({ threads: [] });
    if (path === "/users/@me/channels") return Response.json({ id: "200" });
    throw new Error(`Unexpected request ${path}`);
  }, { preconnect: fetch.preconnect }));
  onTestFinished(() => fetchSpy.mockRestore());

  const watched = await watchedChannels({ ownerId: "99", allowed: new Set(["107"]), ignoredChannels: new Set(["500"]) },
    discordRest("fixture"), () => {});

  expect(watched.map((channel) => channel.id)).toEqual(["200"]);
  expect(paths.filter((path) => path.startsWith("/channels/107/"))).toEqual([]);
});

async function intake() {
  const dir = await mkdtemp(join(tmpdir(), "ignored-thread-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, "gateway.ts");
  await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
const fetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  console.log("TEST_REQUEST " + new URL(String(input)).pathname);
  return fetch(input, init);
}, { preconnect: fetch.preconnect });
Listener.prototype.start = async function () {
  this.emit("connected", { user: { id: "88", username: "Helio" }, sessionId: "test" });
  const ignored = { type: "MESSAGE_CREATE", message_type: 0, id: "901", channel_id: "103", guild_id: "300", content: "private",
    timestamp: new Date(Date.now()).toISOString(), attachments: [], mentions: [{id: "88"}] };
  Object.defineProperty(ignored, "author", { get() {
    console.log("TEST_IGNORED_AUTHOR_READ"); return {id: "99", username: "owner"};
  } });
  this.emit("message_create", ignored);
  this.emit("message_create", { type: "MESSAGE_CREATE", message_type: 0, id: "902", channel_id: "104", guild_id: "300", content: "control",
    timestamp: new Date(Date.now()).toISOString(), author: {id: "99", username: "owner"}, attachments: [], mentions: [{id: "88"}] });
};
`);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "fixture", DORI_DISCORD_OWNER_ID: "99",
      DORI_DISCORD_ALLOWED: "400,104", DORI_DISCORD_TRUSTED_CHANNELS: "104", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_IGNORED_CHANNELS: "100", DORI_DISCORD_SCOPE_CATEGORY: "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_TEST_INTERACTION: "",
      DORI_TEST_TURNS: "", DORI_TEST_REPLIES: "", DORI_TEST_UNKNOWN_BOT: "", DORI_TEST_ARCHIVED: "1" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    return { stdout, ignored: delivery.contains("inbound", "901"), control: delivery.contains("inbound", "902") };
  } finally { delivery.close(); }
}

test("live threads of ignored parents never enter the message cache or delivery", async () => {
  const result = await intake();
  expect(result.stdout).not.toContain("TEST_IGNORED_AUTHOR_READ");
  expect(result.ignored).toBe(false);
  expect(result.control).toBe(true);
});

test("catch-up never reads ignored thread history or discovers archived threads of ignored parents", async () => {
  const result = await intake();
  const requests = result.stdout.split("\n").filter((line) => line.startsWith("TEST_REQUEST "))
    .map((line) => line.slice("TEST_REQUEST ".length));
  expect(requests.filter((path) => /^\/api\/v10\/channels\/(100|103)\//.test(path))).toEqual([]);
  expect(requests).toContain("/api/v10/channels/104/messages");
  expect(result.control).toBe(true);
});
