import { expect, spyOn, test } from "bun:test";
import { contextReplayAllowed } from "./context-replay.ts";
import { discordRest } from "../discord/rest.ts";

const settings = { DORI_DISCORD_CONTEXT: "100" };
const source = {
  message_id: "10", channel_id: "100", author_id: "99", bot: false,
  human_verified: true, content: "Season information",
};

test.each([4, 18])("system type %i never becomes learned human context", async (message_type) => {
  const paths: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    paths.push(String(input));
    return Response.json({ id: "100", type: 0, guild_id: "300" });
  }, { preconnect: fetch.preconnect }));
  try {
    expect(await contextReplayAllowed(JSON.stringify({ ...source, message_type }), settings, discordRest("fixture"))).toBe(false);
    expect(paths).toEqual([]);
  } finally { fetcher.mockRestore(); }
});

test.each([0, 4])("legacy learning checks the original message type %i after its channel policy", async (type) => {
  const paths: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Response.json(path.endsWith("/messages/10") ?
      { id: "10", channel_id: "100", type, author: { id: "99", bot: false } } :
      { id: "100", type: 0, guild_id: "300" });
  }, { preconnect: fetch.preconnect }));
  try {
    expect(await contextReplayAllowed(JSON.stringify(source), settings, discordRest("fixture"))).toBe(type === 0);
    expect(paths).toContain("/api/v10/channels/100/messages/10");
  } finally { fetcher.mockRestore(); }
});
