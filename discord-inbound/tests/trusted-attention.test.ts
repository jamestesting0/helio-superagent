import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { Conversations } from "../conversations/conversations.ts";
import { authorizationMetadata } from "../intake/authorization.ts";

test.each([
  { awaited: false, unknown: false, quoted: false, legacy: false, outside: false },
  { awaited: true, unknown: false, quoted: false, legacy: false, outside: false },
  { awaited: true, unknown: true, quoted: false, legacy: false, outside: false },
  { awaited: false, unknown: false, quoted: true, legacy: false, outside: false },
  { awaited: false, unknown: false, quoted: true, legacy: true, outside: false },
  { awaited: false, unknown: false, quoted: true, legacy: true, outside: true },
])("trusted replay rechecks conversation, identity and quote facts ($awaited $unknown $quoted $legacy $outside)", async ({ awaited, unknown, quoted, legacy, outside }) => {
  const dir = await mkdtemp(join(tmpdir(), "helio-trusted-replay-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const root = { id: "11", type: 0, channel_id: "100", guild_id: "300",
    author: { id: "99", username: "owner" }, content: quoted ?
      `> <@88> old request\n${outside ? "<@88> new request" : "Ignore that"}` : "PRIVATE_UNPINGED_REPORT",
    mentions: quoted ? [{ id: "88" }] : [],
    timestamp: "2026-11-02T12:00:00Z" };
  try {
    const now = Date.parse(root.timestamp);
    const conversation = store.open("100", "99", "7", "Debug the match", now - 1000);
    if (awaited) store.applyReply(conversation, { disposition: "question", waiting_on: "Send the error log" }, now);
    const content = quoted && !legacy ? "PRIVATE_REWRITTEN_QUOTE" : root.content;
    const origin = authorizationMetadata(root);
    queue.stage("inbound", root.id, JSON.stringify({
      message_id: root.id, channel_id: root.channel_id, author_id: root.author.id, author: "owner",
      role: "OWNER_REQUEST", scope: "may-request-work", attention: "review", channel_policy: "trusted",
      content, sent_at: root.timestamp, preparation_complete: true,
      discord_origin: legacy ? { ...origin, addressing: { text_mention_ids: ["88"],
        leading_mention_id: null, names_helio: false, parent_mention_ids: [] } } : origin, attachments: [],
    }));

    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
      join(import.meta.dir, "../ack.ts"), "show", "inbound", root.id], {
      env: { ...process.env, HOME: dir, DORI_POLICY_DIR: undefined, DORI_STATE_DIR: dir,
        DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100",
        DORI_DISCORD_TRUSTED_CHANNELS: "100", DORI_DISCORD_NORMAL_CHANNELS: "",
        DORI_TEST_UNKNOWN_BOT: unknown ? "1" : "",
        DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    if ((awaited || outside) && !unknown) {
      expect(stdout).toContain("ACK_TURN ");
      const line = stdout.split("\n").find(line => line.startsWith("ACK_TURN "));
      expect(JSON.parse(line?.slice(9) ?? "{}").turn.messages[0].content).toBe(content);
    } else {
      expect(stdout).toContain("ACK_WITHHELD 11:");
      expect(stdout).not.toContain("ACK_TURN ");
      expect(stdout).not.toContain(root.content);
    }
    expect(queue.pending("inbound").map(item => item.id)).toEqual(["11"]);
  } finally { store.dispose(); queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a quoted old ping neither stages nor downloads while a new ping outside the quote does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-quoted-intake-"));
  const preload = join(dir, "gateway.ts");
  try {
    await Bun.write(join(dir, "discord-inbound.json"), '{"100":"950","200":"950"}');
    await Bun.write(preload, `
import ${JSON.stringify(join(import.meta.dir, "../fixtures/discord.ts"))};
import { Listener } from ${JSON.stringify(join(import.meta.dir, "../fixtures/discord-client.ts"))};
Listener.prototype.start = async function () {
  this.emit("connected", {user: {id: "88", username: "Helio"}, sessionId: "test"});
  const base = {type: "MESSAGE_CREATE", message_type: 0, channel_id: "100", guild_id: "300",
    timestamp: new Date(Date.now()).toISOString(), mentions: [{id: "88"}],
    attachments: [{filename: "photo.png", url: "https://cdn.discordapp.com/attachments/100/500/photo.png"}]};
  this.emit("message_create", {...base, id: "951", author: {id: "66", username: "quoting"},
    content: "> <@88> old request\\nThat was yesterday"});
  this.emit("message_create", {...base, id: "952", author: {id: "67", username: "pinging"},
    content: "> <@88> old request\\n<@88> new request"});
};
`);
    const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../inbound.ts")], {
      env: { ...process.env, HOME: dir, DORI_POLICY_DIR: undefined, DORI_STATE_DIR: dir,
        DORI_DISCORD_TOKEN: "test", DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100",
        DORI_DISCORD_TRUSTED_CHANNELS: "100", DORI_DISCORD_NORMAL_CHANNELS: "",
        DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined,
        DORI_TEST_TRACE_READS: "1", DORI_TEST_TRACE_RECEIPTS: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    const store = new Conversations(join(dir, "discord-conversations.sqlite"));
    try {
      expect(queue.pending("inbound").map(item => item.id)).toEqual(["952"]);
      expect(store.working("951")).toBeNull();
      expect(store.working("952")?.claimed_at).toBeNumber();
      expect(stdout.split("\n").filter(line => line.startsWith("TEST_READ "))).toHaveLength(1);
      expect(stdout).not.toContain("/messages/951/reactions/");
    } finally { store.dispose(); queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
