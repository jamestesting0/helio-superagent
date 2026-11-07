import { expect, test } from "bun:test";
import { CallError, DiscordTransport } from "./transport.ts";

test.each(["lost-response", "server-error"])("administration writes are not retried after %s", async failure => {
  let requests = 0;
  using transport = new DiscordTransport("bot-secret");
  transport.rest.options.makeRequest = async () => {
    requests += 1;
    if (failure === "lost-response") throw new TypeError("response unavailable for interaction-secret");
    return Response.json({ message: "Service unavailable" }, { status: 503 });
  };
  let observed: unknown;
  try {
    await transport.call("PATCH", "/webhooks/33333333333333333/interaction-secret/messages/@original", { embeds: [] });
  } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(CallError);
  expect(requests).toBe(1);
  expect(String(observed)).not.toContain("interaction-secret");
  expect(String(observed)).not.toContain("bot-secret");
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
