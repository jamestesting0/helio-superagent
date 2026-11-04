import { expect, onTestFinished, spyOn, test } from "bun:test";
import { ArchivedPaginationError, discoverArchivedThreads, type ArchivedThread } from "./archived-threads.ts";
import { discordRest, DiscordRestError, type ApiChannel } from "../discord/rest.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const CUTOFF = NOW - 72 * 60 * 60 * 1000;
const PARENT: ApiChannel = { id: "100", guild_id: "300", type: 0 };
const PUBLIC = "/channels/100/threads/archived/public";
const PRIVATE = "/channels/100/users/@me/threads/archived/private";

function thread(id: string, timestamp = NOW, type = 11): ArchivedThread {
  return {
    id, guild_id: "300", parent_id: "100", type,
    thread_metadata: { archived: true, archive_timestamp: new Date(timestamp).toISOString() },
  };
}

function api(handler: (url: URL) => Response) {
  const requests: URL[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    url.pathname = url.pathname.replace(/^\/api\/v10/, "");
    requests.push(url);
    return handler(url);
  }, { preconnect: fetch.preconnect }));
  onTestFinished(() => fetchSpy.mockRestore());
  const errors: { parentId: string; path: string; error: Error }[] = [];
  return {
    rest: discordRest("unit-test-token"),
    requests,
    errors,
    recovery: {
      now: NOW,
      onError: (parentId: string, path: string, error: Error) => { errors.push({ parentId, path, error }); },
    },
  };
}

const page = (threads: readonly ArchivedThread[], has_more = false) => Response.json({ threads, has_more });

test("public pagination retains the exact 72h boundary and stops before older pages", async () => {
  const fixture = api((url) => {
    if (url.pathname === PRIVATE) return page([]);
    const before = url.searchParams.get("before");
    if (before === null) return page([thread("9"), thread("8", CUTOFF)], true);
    if (before === new Date(CUTOFF).toISOString()) return page([thread("7", CUTOFF - 1)], true);
    throw new Error("Walked beyond the age boundary");
  });

  const result = await discoverArchivedThreads(fixture.rest, [PARENT], fixture.recovery);

  expect(result.map((entry) => entry.id)).toEqual(["9", "8"]);
  expect(fixture.errors).toEqual([]);
  expect(fixture.requests.filter((url) => url.pathname === PUBLIC)).toHaveLength(2);
});

test("joined-private pagination uses snowflakes and continues past old archive timestamps", async () => {
  const fixture = api((url) => {
    if (url.pathname === PUBLIC) return page([]);
    if (url.searchParams.get("before") === null) return page([thread("1000", CUTOFF - 1, 12)], true);
    if (url.searchParams.get("before") === "1000") return page([thread("999", CUTOFF, 12)]);
    throw new Error("Wrong private pagination cursor");
  });

  const result = await discoverArchivedThreads(fixture.rest, [PARENT], fixture.recovery);

  expect(result.map((entry) => entry.id)).toEqual(["999"]);
  expect(fixture.errors).toEqual([]);
});

test("preserves submillisecond public archive cursors across pages", async () => {
  const newer = "2026-11-02T11:00:00.000900+00:00";
  const older = "2026-11-02T11:00:00.000800+00:00";
  const fixture = api((url) => {
    if (url.pathname === PRIVATE) return page([]);
    const before = url.searchParams.get("before");
    if (before === null) return page([{ ...thread("9"), thread_metadata: { archived: true, archive_timestamp: newer } }], true);
    if (before === newer) return page([{ ...thread("8"), thread_metadata: { archived: true, archive_timestamp: older } }], true);
    if (before === older) return page([thread("7", NOW - 2 * 60 * 60 * 1000)]);
    throw new Error("Archive timestamp lost precision");
  });

  const result = await discoverArchivedThreads(fixture.rest, [PARENT], fixture.recovery);

  expect(result.map((entry) => entry.id)).toEqual(["9", "8", "7"]);
  expect(fixture.errors).toEqual([]);
});

test("deduplicates repeated parents and overlapping pages retaining the first thread", async () => {
  const original = { ...thread("9"), name: "first" };
  const fixture = api((url) => {
    if (url.pathname === PRIVATE) return page([]);
    return url.searchParams.has("before")
      ? page([{ ...original, name: "duplicate" }, thread("7", NOW - 2)])
      : page([original, thread("8", NOW - 1)], true);
  });

  const result = await discoverArchivedThreads(fixture.rest, [PARENT, PARENT], fixture.recovery);

  expect(result.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "9", name: "first" }, { id: "8", name: undefined }, { id: "7", name: undefined },
  ]);
  expect(fixture.requests).toHaveLength(3);
});

test.each([403, 404, 500])("reports REST %i failures and continues other endpoints and parents", async (status) => {
  const fixture = api((url) => {
    if (url.pathname === PUBLIC) return new Response("failure", { status });
    if (url.pathname === PRIVATE) return page([thread("8", NOW, 12)]);
    return page([{ ...thread("7", NOW, 10), parent_id: "200" }]);
  });

  const result = await discoverArchivedThreads(fixture.rest, [PARENT, { ...PARENT, id: "200", type: 5 }], fixture.recovery);

  expect(result.map((entry) => entry.id)).toEqual(["8", "7"]);
  expect(fixture.errors).toHaveLength(1);
  expect(fixture.errors[0]?.parentId).toBe("100");
  expect(fixture.errors[0]?.path).toBe(`${PUBLIC}?limit=100`);
  expect(fixture.errors[0]?.error).toBeInstanceOf(DiscordRestError);
});

test("surfaces transport failures through the callback", async () => {
  const failure = new TypeError("offline");
  const fixture = api((url) => {
    if (url.pathname === PUBLIC) throw failure;
    return page([]);
  });

  await discoverArchivedThreads(fixture.rest, [PARENT], fixture.recovery);

  expect(fixture.errors.map(({ error }) => error)).toEqual([failure]);
});

test("propagates callback failures instead of swallowing them", async () => {
  const fixture = api(() => new Response("denied", { status: 403 }));
  const failure = new Error("callback failed");

  await expect(discoverArchivedThreads(fixture.rest, [PARENT], {
    now: NOW, onError: () => { throw failure; },
  })).rejects.toBe(failure);
});

test.each(["empty", "public", "private"])("reports %s non-advancing pagination instead of looping", async (kind) => {
  const fixture = api((url) => {
    if (kind === "empty") return page([], true);
    if ((kind === "public") !== (url.pathname === PUBLIC)) return page([]);
    return page([thread("9", NOW, kind === "private" ? 12 : 11)], true);
  });

  await discoverArchivedThreads(fixture.rest, [PARENT], fixture.recovery);

  expect(fixture.errors).toHaveLength(kind === "empty" ? 2 : 1);
  expect(fixture.errors.every(({ error }) => error instanceof ArchivedPaginationError)).toBe(true);
});

test("never expands categories or scans parents outside the authorized message-channel inputs", async () => {
  const fixture = api((url) => {
    if (![PUBLIC, PRIVATE].includes(url.pathname)) throw new Error("Unauthorized request");
    return page([
      thread("9", NOW, url.pathname === PRIVATE ? 12 : 11),
      { ...thread("8"), parent_id: "unauthorized" },
      { ...thread("7"), guild_id: "other-guild" },
      { ...thread("6"), thread_metadata: { archived: false, archive_timestamp: new Date(NOW).toISOString() } },
      thread("5", NOW, 0),
    ]);
  });

  const result = await discoverArchivedThreads(fixture.rest, [
    PARENT, ...[4, 15, 16, 2, 12].map((type) => ({ ...PARENT, id: String(type), type })),
  ], fixture.recovery);

  expect(result.map((entry) => entry.id)).toEqual(["9"]);
  expect(fixture.errors).toEqual([]);
  expect(fixture.requests.map((url) => url.pathname)).toEqual([PUBLIC, PRIVATE]);
});
