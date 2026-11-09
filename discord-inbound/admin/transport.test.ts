import { expect, test } from "bun:test";
import { CallError, DiscordTransport } from "./transport.ts";

test.each((["PATCH", "DELETE"] as const).flatMap(method =>
  ["lost-response", "server-error"].map(failure => ({ method, failure })),
))("administration $method writes are not retried after $failure", async ({ method, failure }) => {
  let requests = 0;
  using transport = new DiscordTransport("bot-secret");
  transport.rest.options.makeRequest = async () => {
    requests += 1;
    if (failure === "lost-response") throw new TypeError("response unavailable for interaction-secret");
    return Response.json({ message: "Service unavailable" }, { status: 503 });
  };
  let observed: unknown;
  try {
    await transport.call(method, "/webhooks/33333333333333333/interaction-secret/messages/@original",
      method === "DELETE" ? undefined : { embeds: [] });
  } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(CallError);
  expect(requests).toBe(1);
  expect(String(observed)).not.toContain("interaction-secret");
  expect(String(observed)).not.toContain("bot-secret");
});

test("ephemeral response deletion reaches Discord as a bodyless DELETE", async () => {
  const requests: { method: string | undefined; body: unknown }[] = [];
  using transport = new DiscordTransport("bot-secret");
  transport.rest.options.makeRequest = async (_url, options) => {
    requests.push({ method: options.method, body: options.body });
    return new Response(null, { status: 204 });
  };
  await transport.call("DELETE", "/webhooks/33333333333333333/interaction-secret/messages/@original");
  expect(requests).toEqual([{ method: "DELETE", body: undefined }]);
});

test("rate-limited callbacks reject immediately instead of waiting beyond the interaction deadline", async () => {
  let requests = 0;
  using transport = new DiscordTransport("bot-secret");
  transport.rest.options.makeRequest = async () => {
    requests += 1;
    return Response.json({ retry_after: 60, global: false }, { status: 429, headers: {
      "x-ratelimit-limit": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "60",
    } });
  };
  await expect(transport.call("POST", "/interactions/11111111111111111/interaction-secret/callback", { type: 6 }))
    .rejects.toMatchObject({ status: 429 });
  expect(requests).toBe(1);
});

test("ordinary response edits use the wrapper's rate-limit recovery after a rejected request", async () => {
  let requests = 0;
  using transport = new DiscordTransport("bot-secret");
  transport.rest.options.makeRequest = async () => {
    requests += 1;
    return requests === 1 ? Response.json({ retry_after: 0, global: false }, { status: 429 }) :
      Response.json({ id: "77777777777777777" });
  };
  expect(await transport.call("PATCH", "/webhooks/33333333333333333/interaction-secret/messages/@original", { embeds: [] }))
    .toEqual({ id: "77777777777777777" });
  expect(requests).toBe(2);
});
