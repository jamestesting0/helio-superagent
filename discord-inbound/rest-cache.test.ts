import { expect, test } from "bun:test";
import { cachedReads, type Rest } from "./rest.ts";

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
