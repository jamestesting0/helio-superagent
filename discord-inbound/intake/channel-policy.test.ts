import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizationMetadata, filterConfig, reauthorize, validateChannelPolicy } from "./authorization.ts";
import { classify, insideCategory, type IncomingMessage } from "./filter.ts";
import { Delivery } from "../delivery/delivery.ts";
import { Conversations } from "../conversations/conversations.ts";
import { discordRest } from "../discord/rest.ts";

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
  id: "10", type: 0, channel_id: normal, guild_id: "300",
  author: { id: "66", username: "staff" }, content: "<@88> unrelated",
  timestamp: "2026-11-02T12:00:00.000Z", mentions: [{ id: "88" }],
};
const parentOf = async (id: string) => id === "101" ? { type: 11, parent_id: helper } :
  id === "102" ? { type: 11, parent_id: normal } : undefined;

test("unavailable deny ancestry withholds even a directly allowlisted owner request", async () => {
  await expect(classify({ ...message, author: { id: "99", username: "owner" } },
    { ...cfg, ignoredChannels: new Set(["500"]) }, async () => undefined)).rejects.toThrow("ancestry");
});

test("replay in a directly ignored channel neither reads Discord nor returns its content", async () => {
  const original = Object.assign({ ...message }, { type: 0 });
  const inbound = await classify(original, cfg, parentOf);
  const payload = JSON.stringify({ ...inbound, preparation_complete: true, discord_origin: authorizationMetadata(original) });
  const reads: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    reads.push(new URL(String(input)).pathname);
    return Response.json({ id: normal, guild_id: "300", type: 0 });
  }, { preconnect: fetch.preconnect }));
  try {
    expect(await reauthorize(payload, { ...cfg, ignoredChannels: new Set([normal]) }, discordRest("fixture"))).toBeNull();
    expect(reads).toEqual([]);
  } finally { fetcher.mockRestore(); }
});

test("legacy replay resolves the original type before treating a saved heading as a request", async () => {
  const original = Object.assign({ ...message, author: { id: "99", username: "owner" }, content: "Base Storage" }, { type: 0 });
  const inbound = await classify(original, cfg, parentOf);
  const origin = Object.fromEntries(Object.entries(authorizationMetadata(original)).filter(([key]) => key !== "message_type"));
  const payload = JSON.stringify({ ...inbound, preparation_complete: true, discord_origin: origin });
  const reads: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    return Response.json(path.endsWith("/messages/10") ? { ...original, type: 4 } :
      { id: normal, guild_id: "300", type: 0 });
  }, { preconnect: fetch.preconnect }));
  try {
    expect(await reauthorize(payload, cfg, discordRest("fixture"))).toBeNull();
    expect(reads).toContain(`/api/v10/channels/${normal}/messages/10`);
  } finally { fetcher.mockRestore(); }
});

test("conversation follow-ups preserve authority, require an exact owner/channel match, and revoke on replay after close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-policy-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try {
    const config = { ...cfg, inConversation: (channel: string, user: string) => store.isOpen(channel, user) };
    store.open(normal, "66", "9", "intake", 1000);
    const followup = {
      ...message, content: "more details", mentions: [],
      message_reference: { message_id: "9" }, referenced_message: { author: { id: "88" } },
    };
    const current = await classify(followup, config, parentOf);
    expect([current?.attention, current?.role, current?.scope]).toEqual(["review", "STAFF_QUESTION", "may-report-issue"]);
    expect(await classify({ ...followup, author: { id: "77", username: "other" } }, config, parentOf)).toBeNull();
    expect(await classify({ ...followup, channel_id: other }, config, parentOf)).toBeNull();
    expect(await classify({ ...followup, author: { ...followup.author, bot: true } }, config, parentOf)).toBeNull();
    const payload = JSON.stringify({ ...current, preparation_complete: true, discord_origin: authorizationMetadata(followup) });
    const rest = async <T>(): Promise<T> => ({ id: normal, guild_id: "300", type: 0 } as T);
    expect((await reauthorize(payload, config, rest))?.attention).toBe("review");
    store.close(normal, "66", "answered", 2000);
    expect(await classify(followup, config, parentOf)).toBeNull();
    expect(await reauthorize(payload, config, rest)).toBeNull();
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

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

test("the category boundary admits its channels and their threads without ever reading a category", async () => {
  const tree: Record<string, { type: number; parent_id?: string }> = {
    chat: { type: 0, parent_id: "scope" }, thread: { type: 11, parent_id: "chat" },
    secret: { type: 0, parent_id: "hidden" }, stray: { type: 11, parent_id: "secret" },
  };
  const read: string[] = [];
  const lookup = async (id: string) => { read.push(id); return tree[id]; };
  expect(await Promise.all(["chat", "thread", "secret", "stray", "unknown"].map((id) => insideCategory(id, "scope", lookup))))
    .toEqual([true, true, false, false, false]);
  expect(read).not.toContain("scope");
  expect(read).not.toContain("hidden");
});

test("configured channels outside the scope category are ignored with one warning, not a failed start", async () => {
  const scoped = filterConfig({
    DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: `${helper},${normal}`,
    DORI_DISCORD_TRUSTED_CHANNELS: helper, DORI_DISCORD_SCOPE_CATEGORY: "500",
  });
  const rest = async <T>(path: string): Promise<T> => ({
    [`/channels/${helper}`]: { id: helper, type: 0, guild_id: "300", parent_id: "500" },
    [`/channels/${normal}`]: { id: normal, type: 0, guild_id: "300", parent_id: "600" },
  } as Record<string, unknown>)[path] as T;
  const warnings: string[] = [];
  await validateChannelPolicy(scoped, rest, (text) => warnings.push(text));
  expect([...scoped.blockedChannels ?? []]).toEqual([normal]);
  expect(warnings).toEqual([`channel ${normal} is outside DORI_DISCORD_SCOPE_CATEGORY 500; ignored`]);
  expect(() => filterConfig({ DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: helper, DORI_DISCORD_SCOPE_CATEGORY: "abc" })).toThrow("Invalid DORI_DISCORD_SCOPE_CATEGORY");
});
