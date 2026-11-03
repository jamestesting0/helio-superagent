import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterConfig } from "./authorization.ts";
import { classify, type IncomingMessage } from "./filter.ts";
import { Delivery } from "./delivery.ts";

const helper = "1218071208197623880";
const normal = "1199770187738644652";
const other = "1220331873079922810";
const cfg = filterConfig({
  DORI_DISCORD_OWNER_ID: "99",
  DORI_DISCORD_ALLOWED: `${helper},${normal},${other}`,
  DORI_DISCORD_TRUSTED_CHANNELS: helper,
  DORI_DISCORD_TRUSTED_IDS: "77",
  DORI_DISCORD_REPORT_CHANNELS: `${normal},${other}`,
  DORI_DISCORD_BUG_REPORT_SOURCE: `55:${normal}`,
});
cfg.botId = "88";
const message: IncomingMessage = {
  id: "10", channel_id: normal, guild_id: "300",
  author: { id: "66", username: "staff" }, content: "<@88> unrelated",
  timestamp: "2026-11-02T12:00:00.000Z", mentions: [{ id: "88" }],
};
const parentOf = async (id: string) => id === "101" ? helper : id === "102" ? normal : undefined;

test.each([
  [helper, "trusted", "answer-only"], ["101", "trusted", "answer-only"],
  [normal, "normal", "may-report-issue"], [other, "normal", "may-report-issue"],
  ["102", "normal", "may-report-issue"],
] as const)("channel %s classifies independently of human work authority", async (channel_id, policy, scope) => {
  const inbound = await classify({ ...message, channel_id }, cfg, parentOf);
  expect([inbound?.channel_policy, inbound?.role, inbound?.scope]).toEqual([policy, "STAFF_QUESTION", scope]);
  const trusted = await classify({ ...message, channel_id, author: { id: "77", username: "trusted" } }, cfg, parentOf);
  expect([trusted?.channel_policy, trusted?.role, trusted?.scope]).toEqual([policy, "TRUSTED_REQUEST", "trusted-pr-merge-restart"]);
});

test("channel trust cannot admit messages outside the independent allowlist", async () => {
  const restricted = { ...cfg, allowed: new Set([normal]) };
  expect(await classify({ ...message, channel_id: helper }, restricted, parentOf)).toBeNull();
  expect(await classify({ ...message, channel_id: "101" }, restricted, parentOf)).toBeNull();
});

test.each([
  { content: "unmentioned discussion" },
  { content: "<@880> wrong bot <@!088>" },
  { content: "<@88 missing terminator" },
  { content: "reply", message_reference: { message_id: "9" }, referenced_message: { author: { id: "88" } } },
  { content: "", message_reference: { type: 1, message_id: "9" }, message_snapshots: [{ message: { content: "<@88> forwarded ping" } }] },
  { content: "", embeds: [{ description: "<@88> embedded ping" }] },
  { content: "", attachments: [{ filename: "<@88>.txt", url: "https://cdn.discordapp.com/attachments/1/2/file.txt" }] },
])("normal chats reject non-pinging top-level content for every human role: %j", async (overrides) => {
  for (const id of ["99", "77", "66"]) {
    expect(await classify({
      ...message, mentions: [], ...overrides, author: { id, username: "human" },
    }, cfg, parentOf)).toBeNull();
  }
});

test.each([
  { content: "<@88> help", mentions: [] },
  { content: "<@!88> help", mentions: [] },
  { content: "help", mentions: [{ id: "88" }] },
])("normal chats admit explicit literal or actual bot mention IDs: %j", async (ping) => {
  expect((await classify({ ...message, ...ping }, cfg, parentOf))?.channel_policy).toBe("normal");
  expect(await classify({ ...message, ...ping }, { ...cfg, botId: undefined }, parentOf)).toBeNull();
});

test("unknown bot identity leaves trusted chat and identity-authorized DMs unaffected", async () => {
  const unknown = { ...cfg, botId: undefined };
  expect((await classify({ ...message, content: "untagged", mentions: [], channel_id: helper }, unknown, parentOf))?.channel_policy).toBe("trusted");
  for (const id of ["99", "77"]) {
    const dm = await classify({ ...message, guild_id: undefined, content: "untagged", mentions: [], author: { id, username: "human" } }, unknown, parentOf);
    expect(dm?.channel_policy).toBe("trusted");
  }
});

test.each(["invalid", `${helper},${helper}`, `${helper},`, `,${helper}`])(
  "invalid or duplicate trusted CSV %s is rejected", (trusted) => {
    expect(() => filterConfig({
      DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: helper, DORI_DISCORD_TRUSTED_CHANNELS: trusted,
    })).toThrow("DORI_DISCORD_TRUSTED_CHANNELS");
  },
);

test.each([
  { name: "normal direct ping", channel_id: normal, author: message.author, allowed: true },
  { name: "trusted direct ping", channel_id: helper, author: message.author, allowed: false },
  { name: "trusted parent thread ping", channel_id: "101", author: message.author, allowed: false },
  { name: "evidence-only bot report", channel_id: normal, author: { id: "55", username: "Elo", bot: true }, allowed: false },
])("$name has an enforced durable relevance disposition", async ({ channel_id, author, allowed }) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-policy-"));
  const path = join(dir, "delivery.sqlite");
  const queue = new Delivery(path);
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse(message.timestamp));
  try {
    const inbound = await classify({ ...message, channel_id, author }, cfg, parentOf);
    expect(inbound).not.toBeNull();
    queue.stage("inbound", message.id, JSON.stringify(inbound));
    if (allowed) queue.irrelevant(message.id, "Reviewed direct ping: unrelated conversation");
    else expect(() => queue.irrelevant(message.id, "Unrelated")).toThrow("keep it pending");
    const reopened = new Delivery(path);
    try {
      expect(reopened.status("inbound", message.id).disposition).toBe(allowed ? "irrelevant" : "pending");
      expect(reopened.pending("inbound").map((item) => item.id)).toEqual(allowed ? [] : [message.id]);
      if (allowed) expect(reopened.status("inbound", message.id).reason).toBe("Reviewed direct ping: unrelated conversation");
    } finally { reopened.close(); }
  } finally {
    queue.close();
    clock.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
