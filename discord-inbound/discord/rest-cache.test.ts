import { expect, spyOn, test } from "bun:test";
import { cachedReads, discordRest, DiscordRestError, type Rest } from "./rest.ts";

test("channel and identity reads are fetched once per run; message reads and writes always go through", async () => {
  const calls: string[] = [];
  const base = (async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    return { path };
  }) as Rest;
  const rest = cachedReads(base);
  await Promise.all([rest("/channels/1"), rest("/channels/1"), rest("/users/@me"), rest("/users/@me")]);
  await rest("/channels/1/messages/5");
  await rest("/channels/1/messages/5");
  await rest("/channels/1/messages", { method: "POST", body: { content: "x" } });
  expect(calls).toEqual([
    "GET /channels/1", "GET /users/@me",
    "GET /channels/1/messages/5", "GET /channels/1/messages/5",
    "POST /channels/1/messages",
  ]);
});

test("a receipt rate limit is returned to upkeep without sleeping or retrying", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ retry_after: 60 }, { status: 429 }));
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => { throw new Error("Receipt tried to sleep"); });
  try {
    await expect(discordRest("fake")("/channels/1/messages/2/reactions/x/@me",
      { method: "PUT", retryRateLimit: false })).rejects.toBeInstanceOf(DiscordRestError);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); sleep.mockRestore(); }
});

test("repeated or invalid rate limits terminate instead of trapping the intake queue", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const sleep = spyOn(Bun, "sleep").mockResolvedValue();
  try {
    fetch.mockImplementation(Object.assign(async () => Response.json({ retry_after: 0 }, { status: 429 }),
      { preconnect: globalThis.fetch.preconnect }));
    const request = discordRest("fake")("/channels/1");
    // Fail the old unbounded loop promptly instead of leaving this regression test spinning.
    sleep.mockImplementation(async () => { if (fetch.mock.calls.length > 3) throw new Error("unbounded rate-limit loop"); });
    await expect(request).rejects.toBeInstanceOf(DiscordRestError);
    expect(fetch.mock.calls.length).toBe(3);
    fetch.mockClear();
    fetch.mockImplementation(Object.assign(async () => Response.json({ retry_after: -1 }, { status: 429 }),
      { preconnect: globalThis.fetch.preconnect }));
    await expect(discordRest("fake")("/channels/1")).rejects.toBeInstanceOf(DiscordRestError);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); sleep.mockRestore(); }
});
