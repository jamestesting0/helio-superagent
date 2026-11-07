import { expect, spyOn, test } from "bun:test";
import { discordRest, IgnoredChannelError } from "./rest.ts";

test.each(["GET", "POST", "DELETE"].flatMap(method => [false, true].map(allowIgnoredMetadata => ({ method, allowIgnoredMetadata }))))(
  "ignored channel refuses content access before any Discord request: %s", async ({ method, allowIgnoredMetadata }) => {
  const previous = process.env.DORI_DISCORD_IGNORED_CHANNELS;
  process.env.DORI_DISCORD_IGNORED_CHANNELS = "100";
  const calls: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return Response.json({ id: "10" });
  }, { preconnect: fetch.preconnect }));
  try {
    const rest = discordRest("fixture", { allowIgnoredMetadata, metadataActor: "11111" });
    for (const path of ["/channels/100/messages/10", "/channels/100/thread-members/22222", "/channels/100/thread-members",
      ...(method !== "GET" || !allowIgnoredMetadata ? ["/channels/100/thread-members/11111"] : [])]) {
      const result = await rest(path, { method }).then(() => undefined, (error: unknown) => error);
      expect(result).toBeInstanceOf(IgnoredChannelError);
    }
    expect(calls).toEqual([]);
  } finally {
    fetcher.mockRestore();
    if (previous === undefined) delete process.env.DORI_DISCORD_IGNORED_CHANNELS;
    else process.env.DORI_DISCORD_IGNORED_CHANNELS = previous;
  }
});

test("ignored parent prevents body and reaction access in its thread", async () => {
  const previous = process.env.DORI_DISCORD_IGNORED_CHANNELS;
  process.env.DORI_DISCORD_IGNORED_CHANNELS = "100";
  const paths: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    paths.push(new URL(String(input)).pathname);
    return Response.json({ id: "103", type: 11, parent_id: "100", guild_id: "300" });
  }, { preconnect: fetch.preconnect }));
  try {
    const rest = discordRest("fixture");
    const result = await rest("/channels/103/messages/10/reactions/x/@me", { method: "DELETE" })
      .then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(IgnoredChannelError);
    expect(paths).toEqual(["/api/v10/channels/103"]);
  } finally {
    fetcher.mockRestore();
    if (previous === undefined) delete process.env.DORI_DISCORD_IGNORED_CHANNELS;
    else process.env.DORI_DISCORD_IGNORED_CHANNELS = previous;
  }
});
