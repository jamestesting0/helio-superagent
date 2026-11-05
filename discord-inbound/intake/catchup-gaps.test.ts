import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchBacklog, PAGE_SIZE, type RestMessage } from "./catchup.ts";
import { Delivery } from "../delivery/delivery.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const message = (n: number, content: string): RestMessage => ({
  id: String(10_000 - n), channel_id: "c", content, timestamp: new Date(NOW - n * 1000).toISOString(),
  author: { id: "u", username: "u" }, attachments: [],
});
const history = (size: number, pinged: (n: number) => boolean) =>
  Array.from({ length: size }, (_, n) => message(n, pinged(n) ? "<@88> help" : "chatter"));
const pager = (all: RestMessage[]) => async (_channel: string, before?: string) => {
  const start = before ? all.findIndex((msg) => msg.id === before) + 1 : 0;
  return all.slice(start, start + PAGE_SIZE);
};
const addressed = (msg: RestMessage) => msg.content.includes("<@88>");

test("the cap counts only messages addressed to Helio, so chatter cannot push a request out", async () => {
  const all = history(450, (n) => n === 420);
  const backlog = await fetchBacklog(pager(all), "c", "1", NOW, { maxAgeMs: 72 * 3_600_000, maxPerChannel: 100, counts: addressed, maxPages: 20 });
  expect(backlog.truncated).toBe(false);
  expect(backlog.messages.some((msg) => msg.content.includes("<@88>"))).toBe(true);
});

test("hitting the eligible cap or the page ceiling reports why the backlog was cut", async () => {
  const pings = await fetchBacklog(pager(history(300, () => true)), "c", "1", NOW, { maxAgeMs: 72 * 3_600_000, maxPerChannel: 100, counts: addressed });
  expect([pings.truncated, pings.reason, pings.messages.length]).toEqual([true, "cap", 100]);
  const pages = await fetchBacklog(pager(history(500, () => false)), "c", "1", NOW, { maxAgeMs: 72 * 3_600_000, maxPerChannel: 100, counts: addressed, maxPages: 2 });
  expect([pages.truncated, pages.reason, pages.messages.length]).toEqual([true, "pages", 200]);
});

test("a gap is recorded once, listed until acknowledged, then cleared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-gaps-"));
  const delivery = new Delivery(join(dir, "delivery.sqlite"));
  try {
    const gap = { stream: "inbound" as const, channel: "c", after: "100", before: "200", reason: "cap" };
    const first = delivery.recordGap(gap);
    expect(first).toBeDefined();
    expect(delivery.recordGap(gap)).toBeUndefined();
    expect(delivery.gaps().map((row) => [row.channel_id, row.after_id, row.before_id, row.reason])).toEqual([["c", "100", "200", "cap"]]);
    expect(delivery.acknowledgeGap(first as number)).toBe(true);
    expect(delivery.gaps()).toEqual([]);
  } finally {
    delivery.close();
    await rm(dir, { recursive: true, force: true });
  }
});
