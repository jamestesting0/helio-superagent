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

test.each([
  ...["EAI_AGAIN", "DNS_EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"].map(code => ({
    name: code, error: Object.assign(new TypeError("Temporary transport failure"), { code }),
  })),
  { name: "nested DNS cause", error: new TypeError("Fetch failed", {
    cause: Object.assign(new Error("Temporary DNS failure"), { code: "EAI_AGAIN" }),
  }) },
  { name: "timeout", error: new DOMException("Read timed out", "TimeoutError") },
])(
  "a transient $name read recovers within the request", async ({ error }) => {
    let calls = 0;
    const sleeping = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (++calls === 1) throw error;
      return Response.json({ recovered: true });
    }, { preconnect: fetch.preconnect }));
    try {
      expect(await discordRest("fixture")("/users/@me")).toEqual({ recovered: true });
      expect(calls).toBe(2);
    } finally { fetcher.mockRestore(); sleeping.mockRestore(); }
  },
);

test.each([{ elapsed: 0, attempts: 3 }, { elapsed: 10_000, attempts: 2 }])(
  "a sustained failure is bounded by attempts and the overall deadline: %j", async ({ elapsed, attempts }) => {
    let now = 1_000_000;
    let calls = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const sleeping = spyOn(Bun, "sleep").mockImplementation(async milliseconds => { now += Number(milliseconds); });
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      calls++; now += elapsed;
      throw Object.assign(new TypeError("Temporary DNS failure"), { code: "EAI_AGAIN" });
    }, { preconnect: fetch.preconnect }));
    try {
      const error = await discordRest("fixture")("/users/@me").then(() => undefined, (error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(calls).toBe(attempts);
    } finally { fetcher.mockRestore(); sleeping.mockRestore(); clock.mockRestore(); }
  },
);

test.each(["POST", "PATCH", "DELETE", "GET"])(
  "transport writes and unclassified read errors are not replayed: %s", async method => {
    let calls = 0;
    const failure = method === "GET" ? new TypeError("Invalid application input") :
      Object.assign(new TypeError("Connection lost"), { code: "ECONNRESET" });
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      calls++; throw failure;
    }, { preconnect: fetch.preconnect }));
    try {
      const error = await discordRest("fixture")("/users/@me", { method }).then(() => undefined, (error: unknown) => error);
      expect(error).toBe(failure);
      expect(calls).toBe(1);
    } finally { fetcher.mockRestore(); }
  },
);

test.each([{ status: 503, attempts: 2 }, { status: 403, attempts: 1 }])(
  "HTTP failure recovery preserves permission boundaries: %j", async ({ status, attempts }) => {
    let calls = 0;
    const sleeping = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (++calls === 1) return new Response("Unavailable", { status });
      return Response.json({ recovered: true });
    }, { preconnect: fetch.preconnect }));
    try {
      const result = await discordRest("fixture")("/users/@me").then(value => value, (error: unknown) => error);
      if (status === 503) expect(result).toEqual({ recovered: true });
      else expect(result).toBeInstanceOf(Error);
      expect(calls).toBe(attempts);
    } finally { fetcher.mockRestore(); sleeping.mockRestore(); }
  },
);

test("Discord's mandated cooldown does not consume the transient read recovery budget", async () => {
  let now = 1_000_000;
  let calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sleeping = spyOn(Bun, "sleep").mockImplementation(async milliseconds => { now += Number(milliseconds); });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    calls++;
    if (calls === 1) return Response.json({ retry_after: 20 }, { status: 429 });
    if (calls === 2) throw Object.assign(new TypeError("Temporary DNS failure"), { code: "EAI_AGAIN" });
    return Response.json({ recovered: true });
  }, { preconnect: fetch.preconnect }));
  try {
    expect(await discordRest("fixture")("/users/@me")).toEqual({ recovered: true });
    expect(calls).toBe(3);
  } finally { fetcher.mockRestore(); sleeping.mockRestore(); clock.mockRestore(); }
});

test("a read retry rechecks an ignored-channel change before fetching again", async () => {
  const previous = process.env.DORI_DISCORD_IGNORED_CHANNELS;
  process.env.DORI_DISCORD_IGNORED_CHANNELS = "";
  let calls = 0;
  const sleeping = spyOn(Bun, "sleep").mockImplementation(async () => {
    process.env.DORI_DISCORD_IGNORED_CHANNELS = "100";
  });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    if (++calls === 1) throw Object.assign(new TypeError("Temporary DNS failure"), { code: "EAI_AGAIN" });
    return Response.json({ content: "Newly excluded fixture" });
  }, { preconnect: fetch.preconnect }));
  try {
    const error = await discordRest("fixture")("/channels/100/messages")
      .then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(IgnoredChannelError);
    expect(calls).toBe(1);
  } finally {
    fetcher.mockRestore(); sleeping.mockRestore();
    if (previous === undefined) delete process.env.DORI_DISCORD_IGNORED_CHANNELS;
    else process.env.DORI_DISCORD_IGNORED_CHANNELS = previous;
  }
});

test.each(["before-dispatch", "cooldown", "ancestry"] as const)(
  "caller cancellation stops a read and its nested work: %s", async phase => {
    const previous = process.env.DORI_DISCORD_IGNORED_CHANNELS;
    process.env.DORI_DISCORD_IGNORED_CHANNELS = phase === "ancestry" ? "999" : "";
    const controller = new AbortController();
    const reason = new DOMException("Optional context cancelled", "AbortError");
    const first = Promise.withResolvers<void>();
    let calls = 0;
    const sleeping = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      calls++;
      first.resolve();
      if (phase === "ancestry") {
        controller.abort(reason);
        return Response.json({ id: "100", type: 0, parent_id: null });
      }
      return Response.json({ retry_after: 60 }, { status: 429 });
    }, { preconnect: fetch.preconnect }));
    try {
      if (phase === "before-dispatch") controller.abort(reason);
      const options = { method: "GET", signal: controller.signal };
      const result = discordRest("fixture")(phase === "ancestry" ? "/channels/100/messages" : "/users/@me", options)
        .then(() => undefined, (error: unknown) => error);
      if (phase === "cooldown") {
        await first.promise;
        controller.abort(reason);
      }

      expect(await result).toBe(reason);
      expect(calls).toBe(phase === "before-dispatch" ? 0 : 1);
    } finally {
      fetcher.mockRestore(); sleeping.mockRestore();
      if (previous === undefined) delete process.env.DORI_DISCORD_IGNORED_CHANNELS;
      else process.env.DORI_DISCORD_IGNORED_CHANNELS = previous;
    }
  },
);
