import { expect, test } from "bun:test";
import type { DiscordGatewayMessageCreateEvent } from "agent-messenger/discordbot";
import type { broker } from "./broker.ts";
import { reactWhileSleeping } from "./sleep-reaction.ts";
import type { Call } from "./transport.ts";

const helio = { id: "88", username: "Helio" };
const ping: DiscordGatewayMessageCreateEvent = {
  type: "MESSAGE_CREATE", message_type: 0, id: "12", channel_id: "34", guild_id: "99",
  author: { id: "56", username: "staff" }, content: "<@88> help", mentions: [helio], timestamp: "2026-11-25T12:00:00Z",
};

test.each([
  { scenario: "direct ping in an allowed thread", patch: {}, sleeping: true, expected: true },
  { scenario: "lead is running or its status is unknown", patch: {}, sleeping: false, expected: false },
  { scenario: "plain reply to Helio", patch: { message_type: 19, content: "help" }, sleeping: true, expected: false },
  { scenario: "quoted mention", patch: { content: "> <@88> help" }, sleeping: true, expected: false },
  { scenario: "thread inherits ignored parent", patch: { channel_id: "35" }, sleeping: true, expected: false },
  { scenario: "untrusted DM", patch: { guild_id: undefined }, sleeping: true, expected: false },
])("sleeping reaction eligibility for $scenario", async ({ patch, sleeping, expected }) => {
  const reactions: string[] = [];
  const channels = new Map([
    ["/channels/34", { id: "34", guild_id: "99", parent_id: "45", type: 11 }],
    ["/channels/35", { id: "35", guild_id: "99", parent_id: "46", type: 11 }],
    ["/channels/45", { id: "45", guild_id: "99", parent_id: null, type: 0 }],
  ]);
  const call: Call = async (method, path) => {
    if (method === "GET" && channels.has(path)) return channels.get(path);
    if (method === "PUT") { reactions.push(decodeURIComponent(path)); return null; }
    throw new Error(`Unexpected offline request ${method} ${path}`);
  };
  const request: typeof broker = async order => {
    if (order.kind === "sleep-reaction") return sleeping;
    if (order.kind === "policy") return { version: 1, revision: "a".repeat(64), timing: [], values: {
      DORI_DISCORD_OWNER_ID: "66", HELIO_TRUSTED_USERS: "77",
      DORI_DISCORD_ALLOWED: "45,46", DORI_DISCORD_IGNORED_CHANNELS: "46",
    } };
    throw new Error(`Unexpected broker request ${order.kind}`);
  };
  await reactWhileSleeping({ ...ping, ...patch }, helio.id, call, request);
  expect(reactions).toEqual(expected ? ["/channels/34/messages/12/reactions/😴/@me"] : []);
});
