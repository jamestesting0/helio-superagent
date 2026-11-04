import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { deliveryOutput } from "../fixtures/delivery-output.ts";

const normal = "1199770187738644652";
const other = "1220331873079922810";
const trusted = "1218071208197623880";
const channels = [
  { id: "400", type: 4, parent_id: null },
  { id: normal, type: 0, parent_id: "400" },
  { id: other, type: 0, parent_id: "400" },
  { id: trusted, type: 0, parent_id: "400" },
  { id: "104", type: 5, parent_id: "400" },
  { id: "110", type: 0, parent_id: "111" },
  { id: "111", type: 4, parent_id: normal },
  ...[10, 11, 12].map((type) => ({ id: String(type), type, parent_id: trusted })),
  { id: "120", type: 0, parent_id: "121" },
  { id: "122", type: 0, parent_id: "123" },
  { id: "123", type: 4, parent_id: "122" },
].map((channel) => ({ ...channel, guild_id: "300" }));

async function invoke(dir: string, settings: Record<string, string | undefined>) {
  // Exercise the shipped CLI and discordRest; replace only the HTTP boundary.
  const script = `
    Date.now = () => Date.parse("2026-11-02T12:00:00Z");
    const channels = ${JSON.stringify(channels)};
    globalThis.fetch = Object.assign(async (input) => {
      const url = new URL(String(input));
      console.log("REST " + url.pathname);
      if (url.pathname === "/api/v10/guilds/300/channels") return Response.json(channels);
      const metadata = /^\\/api\\/v10\\/channels\\/(\\d+)$/.exec(url.pathname);
      if (metadata) {
        const found = channels.find(c => c.id === metadata[1]);
        return found ? Response.json(found) : new Response("Missing access", { status: 403 });
      }
      const history = /^\\/api\\/v10\\/channels\\/(\\d+)\\/messages$/.exec(url.pathname);
      if (history && process.env.TEST_QUIET_CHANNEL === history[1]) return Response.json([{
        id: "5" + history[1], channel_id: history[1], guild_id: "300", author: { id: "99", username: "staff" },
        content: "old", timestamp: "2026-09-01T00:00:00Z", attachments: [],
      }]);
      if (history) return Response.json([{
        id: "990" + history[1], channel_id: history[1], guild_id: "300",
        author: { id: "55", username: "bot", bot: true }, content: "blocked-bot-content",
        timestamp: "2026-11-02T12:00:00Z",
        attachments: [{ filename: "secret.txt", url: "https://forbidden.invalid/bot" }],
      }, {
        id: "980" + history[1], channel_id: history[1], guild_id: "300", webhook_id: "56",
        author: { id: "56", username: "webhook" }, content: "blocked-webhook-content",
        timestamp: "2026-11-02T12:00:00Z",
        attachments: [{ filename: "secret.txt", url: "https://forbidden.invalid/webhook" }],
      }, {
        id: "900" + history[1], channel_id: history[1], guild_id: "300",
        author: { id: "99", username: "staff" }, content: "fresh " + history[1],
        timestamp: "2026-11-02T12:00:00Z", attachments: [],
      }]);
      throw new Error("Unexpected REST request " + url.pathname);
    }, { preconnect: () => undefined });
    await import(${JSON.stringify(join(import.meta.dir, "../context.ts"))});
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: {
      ...process.env, DORI_DISCORD_TOKEN: "fixture-only", DORI_STATE_DIR: dir,
      DORI_DISCORD_CONTEXT: `400,${normal},${other},110,10,11,12,120,122`,
      DORI_DISCORD_ALLOWED: `${normal},${other},${trusted}`,
      DORI_DISCORD_TRUSTED_CHANNELS: trusted,
      DORI_DISCORD_NORMAL_CHANNELS: undefined, DORI_DISCORD_CONTEXT_EXCLUDED: "",
      ...settings,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout: stdout.includes("CONTEXT ") ? deliveryOutput(dir, stdout) : stdout, stderr, exitCode };
}

test.each([
  { name: "explicit normal roots", settings: { DORI_DISCORD_NORMAL_CHANNELS: `${normal},${other}` } },
  { name: "allowed minus trusted default", settings: {} },
  { name: "incomplete explicit list cannot weaken inbound policy", settings: { DORI_DISCORD_NORMAL_CHANNELS: normal } },
])("$name blocks history and pending replay for normal descendants and all threads", async ({ settings }) => {
  const dir = await mkdtemp(join(tmpdir(), "helio-learning-policy-"));
  const path = join(dir, "discord-delivery.sqlite");
  const queuedChannels = [normal, other, "110", "10", "11", "12", "120", "122", "999"];
  const queue = new Delivery(path);
  try {
    for (const [index, channel_id] of queuedChannels.entries()) {
      queue.stage("context", String(700 + index), JSON.stringify({ channel_id, human_verified: true, content: "blocked-private-content" }));
    }
    queue.stage("context", "800", JSON.stringify({ channel_id: trusted, human_verified: true, content: "pending trusted" }));
    queue.stage("context", "801", JSON.stringify({ channel_id: trusted, human_verified: true, bot: true, content: "blocked-bot-content" }));
    queue.stage("context", "802", JSON.stringify({ channel_id: trusted, human_verified: true, webhook_id: "56", content: "blocked-webhook-content" }));
  } finally { queue.close(); }
  try {
    const result = await invoke(dir, settings);
    expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const lines = result.stdout.split("\n");
    const payloads = lines.filter(line => line.startsWith("CONTEXT ")).map(line => JSON.parse(line.slice(8)));
    expect(payloads.map(payload => [payload.channel_id, payload.content])).toEqual([
      [trusted, "pending trusted"], [trusted, `fresh ${trusted}`], ["104", "fresh 104"],
    ]);
    expect(lines.filter(line => /^REST .*\/messages$/.test(line)).sort()).toEqual([
      `REST /api/v10/channels/${trusted}/messages`, "REST /api/v10/channels/104/messages",
    ].sort());
    expect(lines.some(line => line.startsWith("REST ") && line.includes("/threads/"))).toBe(false);
    expect(lines.filter(line => line.startsWith("REST ") && !line.startsWith("REST /api/v10/"))).toEqual([]);
    expect(result.stdout).not.toContain("blocked-private-content");
    expect(result.stderr).not.toContain("blocked-private-content");
    expect(result.stdout).not.toContain("blocked-bot-content");
    expect(result.stdout).not.toContain("blocked-webhook-content");
    expect(result.stdout).toContain(`CONTEXT_WITHHELD pending=${queuedChannels.length + 2}`);
    expect(await Bun.file(join(dir, "discord-context.json")).json()).toEqual({
      [trusted]: `990${trusted}`, "104": "990104",
    });
    const reopened = new Delivery(path);
    try {
      expect(reopened.pending("context").map(item => item.id).sort()).toEqual([
        ...queuedChannels.map((_, index) => String(700 + index)), "800", "801", "802", `900${trusted}`, "900104",
      ].sort());
    } finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy pending context stays private and unchanged while newly verified humans persist and replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-learning-legacy-"));
  const path = join(dir, "discord-delivery.sqlite");
  const legacy = [
    { channel_id: trusted, bot: false, content: "ambiguous legacy bot false" },
    { channel_id: trusted, content: "ambiguous legacy missing metadata" },
    { channel_id: trusted, bot: false, human_verified: false, content: "explicitly unverified" },
    { channel_id: trusted, bot: false, human_verified: "true", content: "invalid marker type" },
  ];
  const queue = new Delivery(path);
  try {
    for (const [index, payload] of legacy.entries()) {
      queue.stage("context", String(810 + index), JSON.stringify(payload));
    }
  } finally { queue.close(); }
  try {
    for (const result of [await invoke(dir, {}), await invoke(dir, {})]) {
      expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT "))
        .map(line => JSON.parse(line.slice(8)))
        .map(payload => [payload.channel_id, payload.content, payload.human_verified]).sort()).toEqual([
        [trusted, `fresh ${trusted}`, true], ["104", "fresh 104", true],
      ].sort());
      expect(result.stdout).toContain("CONTEXT_WITHHELD pending=4");
      for (const payload of legacy) {
        expect(result.stdout).not.toContain(payload.content);
        expect(result.stderr).not.toContain(payload.content);
      }
    }
    const reopened = new Delivery(path);
    try {
      expect(reopened.pending("context").filter(item => ["810", "811", "812", "813"].includes(item.id))
        .map(item => item.payload)).toEqual(legacy.map(payload => JSON.stringify(payload)));
      expect(reopened.pending("context").filter(item => item.id.startsWith("900"))
        .map(item => JSON.parse(item.payload).human_verified)).toEqual([true, true]);
    } finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit exclusions suppress trusted history and pending content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-learning-excluded-"));
  try {
    const result = await invoke(dir, { DORI_DISCORD_CONTEXT_EXCLUDED: trusted });
    expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT "))
      .map(line => JSON.parse(line.slice(8)).channel_id)).toEqual(["104"]);
    expect(result.stdout).not.toContain(`REST /api/v10/channels/${trusted}/messages`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unset trusted channels makes every allowlisted channel normal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-learning-untrusted-"));
  try {
    const result = await invoke(dir, { DORI_DISCORD_TRUSTED_CHANNELS: undefined });
    expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT "))
      .map(line => JSON.parse(line.slice(8)).channel_id)).toEqual(["104"]);
    expect(result.stdout).not.toContain(`REST /api/v10/channels/${trusted}/messages`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a quiet learning channel still yields its newest messages on the first read, without a truncation warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-learning-quiet-"));
  try {
    const settings = { DORI_DISCORD_CONTEXT: trusted, TEST_QUIET_CHANNEL: trusted };
    const first = await invoke(dir, settings);
    expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(first.stdout).not.toContain("CONTEXT_TRUNCATED");
    expect(first.stdout).toContain("CONTEXT_DONE channels=1 messages=1");
    const second = await invoke(dir, settings);
    expect(second.stdout).not.toContain("CONTEXT_TRUNCATED");
    expect(second.stdout.match(/^CONTEXT \{/gm)?.length).toBe(1);
    expect(JSON.parse(await Bun.file(join(dir, "discord-context.json")).text())[trusted]).toBe("5" + trusted);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a clean refresh forgets read positions of channels that are no longer learned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-learning-prune-"));
  try {
    await Bun.write(join(dir, "discord-context.json"), JSON.stringify({ "888075523044040729": "5", [trusted]: "1" }));
    const result = await invoke(dir, { DORI_DISCORD_CONTEXT: trusted });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(Object.keys(JSON.parse(await Bun.file(join(dir, "discord-context.json")).text()))).toEqual([trusted]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
