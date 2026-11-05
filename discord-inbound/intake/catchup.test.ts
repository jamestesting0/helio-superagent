import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBacklog, PAGE_SIZE, skippedThrough, type FetchPage, type RestMessage } from "./catchup.ts";
import { LastSeen } from "./lastseen.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CAPS = { maxAgeMs: 72 * HOUR, maxPerChannel: 100 };

function message(id: number, hoursAgo: number): RestMessage {
  return {
    id: String(id),
    channel_id: "c1",
    author: { id: "u1", username: "u1" },
    content: `m${id}`,
    timestamp: new Date(NOW - hoursAgo * HOUR).toISOString(),
  };
}

function channel(messages: RestMessage[]): { fetchPage: FetchPage; calls: (string | undefined)[] } {
  const newestFirst = [...messages].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
  const calls: (string | undefined)[] = [];
  const fetchPage: FetchPage = async (_channelId, before) => {
    calls.push(before);
    const older = before === undefined ? newestFirst : newestFirst.filter((m) => BigInt(m.id) < BigInt(before));
    return older.slice(0, PAGE_SIZE);
  };
  return { fetchPage, calls };
}

const ids = (messages: RestMessage[]) => messages.map((m) => Number(m.id));

describe("fetchBacklog", () => {
  test("returns only messages after the last seen one, oldest first", async () => {
    const { fetchPage } = channel([1, 2, 3, 4, 5].map((id) => message(id, 1)));
    const { messages, truncated } = await fetchBacklog(fetchPage, "c1", "2", NOW, CAPS);
    expect(ids(messages)).toEqual([3, 4, 5]);
    expect(truncated).toBe(false);
  });

  test("pages back across the page size", async () => {
    const all = Array.from({ length: 250 }, (_, i) => message(i + 1, 1));
    const { fetchPage, calls } = channel(all);
    const { messages } = await fetchBacklog(fetchPage, "c1", "20", NOW, { ...CAPS, maxPerChannel: 1000 });
    expect(ids(messages)).toEqual(Array.from({ length: 230 }, (_, i) => i + 21));
    expect(calls).toEqual([undefined, "151", "51"]);
  });

  test("keeps the newest messages when the count cap is hit", async () => {
    const { fetchPage } = channel(Array.from({ length: 10 }, (_, i) => message(i + 1, 1)));
    const { messages, truncated } = await fetchBacklog(fetchPage, "c1", undefined, NOW, { ...CAPS, maxPerChannel: 3 });
    expect(ids(messages)).toEqual([8, 9, 10]);
    expect(truncated).toBe(true);
  });

  test("a channel with only stale messages is reported cut off once, then starts clean", async () => {
    const { fetchPage } = channel([message(1, 100), message(2, 80)]);
    const first = await fetchBacklog(fetchPage, "c1", undefined, NOW, CAPS);
    expect(first).toEqual({ messages: [], truncated: true, reason: "age" });
    const cursor = await skippedThrough(fetchPage, "c1", first);
    expect(cursor).toBe("2");
    const next = await fetchBacklog(fetchPage, "c1", cursor, NOW, CAPS);
    expect([next, await skippedThrough(fetchPage, "c1", next)]).toEqual([{ messages: [], truncated: false }, undefined]);
  });

  test("a cut-off that kept messages leaves the cursor to delivery", async () => {
    const { fetchPage, calls } = channel([message(1, 100), message(2, 1)]);
    const backlog = await fetchBacklog(fetchPage, "c1", undefined, NOW, CAPS);
    const before = calls.length;
    expect([backlog.truncated, await skippedThrough(fetchPage, "c1", backlog), calls.length]).toEqual([true, undefined, before]);
  });

  test("stops at the age cap", async () => {
    const { fetchPage } = channel([message(1, 100), message(2, 80), message(3, 10), message(4, 1)]);
    const { messages, truncated } = await fetchBacklog(fetchPage, "c1", undefined, NOW, CAPS);
    expect(ids(messages)).toEqual([3, 4]);
    expect(truncated).toBe(true);
  });

  test("includes exactly 72h old messages but excludes one millisecond older", async () => {
    const older = { ...message(1, 72), timestamp: new Date(NOW - 72 * HOUR - 1).toISOString() };
    const { fetchPage } = channel([older, message(2, 72), message(3, 1)]);

    const result = await fetchBacklog(fetchPage, "c1", undefined, NOW, CAPS);

    expect(ids(result.messages)).toEqual([2, 3]);
    expect(result.truncated).toBe(true);
  });

  test.each([100, 101])("keeps the newest 100 raw messages from %i regardless of later bot filtering", async (count) => {
    const raw = Array.from({ length: count }, (_, i) => ({
      ...message(i + 1, 1),
      author: { id: "bot", username: "bot", bot: i + 1 > count - 100 },
    }));
    const { fetchPage, calls } = channel(raw);

    const result = await fetchBacklog(fetchPage, "c1", undefined, NOW, CAPS);

    expect(ids(result.messages)).toEqual(Array.from({ length: 100 }, (_, i) => count - 99 + i));
    expect(result.messages.filter((entry) => !entry.author.bot)).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(calls).toEqual([undefined]);
  });

  test("minKeep keeps the newest messages past the age cap, then stops at it", async () => {
    const { fetchPage } = channel([message(1, 100), message(2, 80), message(3, 10)]);
    expect(await fetchBacklog(fetchPage, "c1", undefined, NOW, { ...CAPS, minKeep: 3 }))
      .toMatchObject({ truncated: false });
    expect(ids((await fetchBacklog(fetchPage, "c1", undefined, NOW, { ...CAPS, minKeep: 3 })).messages)).toEqual([1, 2, 3]);
    const sampled = await fetchBacklog(fetchPage, "c1", undefined, NOW, { ...CAPS, minKeep: 2 });
    expect([ids(sampled.messages), sampled.truncated]).toEqual([[2, 3], true]);
  });

  test("nothing new returns an empty, untruncated backlog", async () => {
    const { fetchPage } = channel([message(1, 1), message(2, 1)]);
    expect(await fetchBacklog(fetchPage, "c1", "2", NOW, CAPS)).toEqual({ messages: [], truncated: false });
  });

  test("compares IDs numerically, not as text", async () => {
    const { fetchPage } = channel([message(9, 1), message(10, 1), message(11, 1)]);
    const { messages } = await fetchBacklog(fetchPage, "c1", "9", NOW, CAPS);
    expect(ids(messages)).toEqual([10, 11]);
  });
});

describe("LastSeen", () => {
  test("is a first run until saved, then persists the newest ID per channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lastseen-"));
    try {
      const path = join(dir, "discord-inbound.json");
      const first = await LastSeen.load(path);
      expect(first.firstRun).toBe(true);

      await first.advance("c1", "10");
      await first.advance("c1", "9");
      await first.advance("c2", "5");

      const reloaded = await LastSeen.load(path);
      expect(reloaded.firstRun).toBe(false);
      expect(reloaded.get("c1")).toBe("10");
      expect(reloaded.get("c2")).toBe("5");
      expect(reloaded.get("c3")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt state file fails loudly instead of resetting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lastseen-"));
    try {
      const path = join(dir, "discord-inbound.json");
      await Bun.write(path, "{not json");
      await expect(LastSeen.load(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
