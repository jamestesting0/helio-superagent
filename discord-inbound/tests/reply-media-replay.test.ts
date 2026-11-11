import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Delivery } from "../delivery/delivery.ts";
import { authorizationMetadata } from "../intake/authorization.ts";
import { prepareReplyMessage, type ReplyMessage } from "../messages/reply-context.ts";

const url = "https://cdn.discordapp.com/attachments/100/500/photo.png";
const root = {
  id: "90", type: 19, channel_id: "100", guild_id: "300", content: "<@88> check this",
  author: { id: "99", username: "owner" }, mentions: [{ id: "88" }],
  timestamp: "2026-11-02T12:00:00Z",
  message_reference: { message_id: "20", channel_id: "100", guild_id: "300" },
  referenced_message: { author: { id: "66" } },
};

async function stage(dir: string, parent: ReplyMessage) {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
    new Response(png, { headers: { "content-type": "image/png" } }), { preconnect: fetch.preconnect }));
  const prepared = await prepareReplyMessage(parent, root.id, join(dir, "attachments/inbound"), "trusted")
    .finally(() => { fetcher.mockRestore(); });
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    queue.stage("inbound", root.id, JSON.stringify({
      message_id: root.id, channel_id: root.channel_id, author_id: root.author.id, author: "owner",
      role: "OWNER_REQUEST", scope: "may-request-work", attention: "direct", pinged: true,
      channel_policy: "trusted", content: root.content, sent_at: root.timestamp,
      preparation_complete: true, discord_origin: authorizationMetadata(root), attachments: [],
      reply_context: { status: "complete", messages: [prepared.entry] },
    }));
  } finally { queue.close(); }
  return prepared.entry;
}

async function show(dir: string, trusted: boolean) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "../ack.ts"), "show", "inbound", root.id,
  ], {
    env: { ...process.env, HOME: dir, DORI_POLICY_DIR: undefined, DORI_STATE_DIR: dir,
      DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100",
      DORI_DISCORD_TRUSTED_CHANNELS: trusted ? "100" : "", DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const line = stdout.split("\n").find(line => line.startsWith("ACK_TURN "));
  expect(line).toBeDefined();
  return { stdout, parent: JSON.parse(line?.slice(9) ?? "{}").reply_chain.messages[0] };
}

test("normal replay strips trusted linked reply files and linked forwarded files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reply-link-downgrade-"));
  const parent = { id: "20", channel_id: "100", guild_id: "300", author: { id: "66", username: "staff" },
    content: url, message_reference: { type: 1, message_id: "2", channel_id: "999" },
    message_snapshots: [{ message: { content: url } }] };
  try {
    const prepared = await stage(dir, parent);
    const linkedPath = prepared.attachments[0]?.path;
    expect(typeof linkedPath).toBe("string");
    const trusted = await show(dir, true);
    expect(trusted.parent.attachments).toHaveLength(1);
    expect(trusted.parent.forwarded[0].attachments).toHaveLength(1);
    const forwardedPath = trusted.parent.forwarded[0].attachments[0].path;

    const normal = await show(dir, false);

    expect(normal.parent.attachments).toEqual([]);
    expect(normal.parent.forwarded[0].attachments).toEqual([]);
    expect(normal.stdout).not.toContain(linkedPath);
    expect(normal.stdout).not.toContain(forwardedPath);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("blocking a reply author removes supplied forwarded text and image paths from ack show", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reply-blocked-forward-"));
  const parent = { id: "20", channel_id: "100", guild_id: "300", author: { id: "66", username: "staff" },
    content: "parent text", message_reference: { type: 1, message_id: "2", channel_id: "999" },
    message_snapshots: [{ message: { content: "PRIVATE_FORWARDED_IMAGE",
      attachments: [{ filename: "photo.png", url }] } }] };
  try {
    await stage(dir, parent);
    const before = await show(dir, true);
    expect(before.parent.forwarded[0].content).toBe("PRIVATE_FORWARDED_IMAGE");
    const path = before.parent.forwarded[0].attachments[0].path;
    expect(await Bun.file(path).exists()).toBe(true);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try { queue.block("66", { source: "owner", reason: "blocked after preparation", by: "99" }, new Set(["99"])); }
    finally { queue.close(); }

    const blocked = await show(dir, true);

    expect(blocked.parent.content).toBe("[message from a blocked user omitted]");
    expect(blocked.parent.forwarded).toBeUndefined();
    expect(blocked.stdout).not.toContain("PRIVATE_FORWARDED_IMAGE");
    expect(blocked.stdout).not.toContain(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
