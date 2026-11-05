import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSentReply, sendOnce, STALE_SEND_MS, type SendOnce } from "./reply-once.ts";
import { discordRest } from "../discord/rest.ts";

async function withDb(body: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reply-once-"));
  try { await body(join(dir, "reply-sends.sqlite")); } finally { await rm(dir, { recursive: true, force: true }); }
}

const base = (path: string, over: Partial<SendOnce> = {}): SendOnce => ({
  path, target: "500", text: "I could not merge #6.", now: () => 1_000_000, sleep: async () => {},
  send: async () => "900", findSent: async () => undefined, ...over,
});

test("two overlapping sends of the same reply post it once; the second waits and returns the first reply", async () => {
  await withDb(async (path) => {
    let release!: () => void;
    const firstSending = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    const slowSend = async () => { sends++; await firstSending; return "901"; };
    const first = sendOnce(base(path, { send: slowSend }));
    const second = sendOnce(base(path, { send: slowSend, sleep: async () => release() }));
    expect(await Promise.all([first, second])).toEqual([{ id: "901", duplicate: false }, { id: "901", duplicate: true }]);
    expect(sends).toBe(1);
  });
});

test("a repeat of a sent reply returns it without posting; different text is a new reply", async () => {
  await withDb(async (path) => {
    expect(await sendOnce(base(path))).toEqual({ id: "900", duplicate: false });
    let posted = 0;
    const counting = async () => { posted++; return "902"; };
    expect(await sendOnce(base(path, { send: counting }))).toEqual({ id: "900", duplicate: true });
    expect(await sendOnce(base(path, { send: counting, text: "Merged #6." }))).toEqual({ id: "902", duplicate: false });
    expect(posted).toBe(1);
  });
});

test("after a send with an unknown outcome, the next attempt asks Discord before posting again", async () => {
  await withDb(async (path) => {
    await expect(sendOnce(base(path, { send: async () => { throw new Error("socket hang up"); } }))).rejects.toThrow("socket hang up");
    let posted = 0;
    const found = await sendOnce(base(path, { send: async () => { posted++; return "903"; }, findSent: async () => "899" }));
    expect([found, posted]).toEqual([{ id: "899", duplicate: true }, 0]);
  });
  await withDb(async (path) => {
    await expect(sendOnce(base(path, { send: async () => { throw new Error("socket hang up"); } }))).rejects.toThrow();
    expect(await sendOnce(base(path, { send: async () => "904" }))).toEqual({ id: "904", duplicate: false });
  });
});

test("a claim left by a crashed process is taken over only once it is stale", async () => {
  await withDb(async (path) => {
    expect(await sendOnce(base(path))).toEqual({ id: "900", duplicate: false });
    const db = new Database(path);
    db.run("UPDATE reply_sends SET state = 'sending', reply_id = NULL, started_at = ?", [1_000_000]);
    db.close();
    let clock = 1_000_000 + 1_000;
    let waits = 0;
    const result = await sendOnce(base(path, {
      now: () => clock, send: async () => "905",
      sleep: async () => { waits++; clock += STALE_SEND_MS; },
    }));
    expect([result, waits]).toEqual([{ id: "905", duplicate: false }, 1]);
  });
});

test("an uncertain reply on a later history page is recovered without posting a duplicate", async () => {
  await withDb(async (path) => {
    await expect(sendOnce(base(path, { send: async () => { throw new Error("response lost"); } }))).rejects.toThrow();
    const target = { channel_id: "100", message_id: "500" };
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const route = String(input);
      return Response.json(route.endsWith("/users/@me") ? { id: "88" } :
        route.includes("after=500&") ? Array.from({ length: 100 }, (_, i) => ({ id: String(600 + i), content: "other", author: { id: "7" } })) :
        [{ id: "800", content: base(path).text, author: { id: "88" }, message_reference: { message_id: "500" } }]);
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      let sends = 0;
      const result = await sendOnce(base(path, {
        send: async () => { sends++; return "duplicate"; },
        findSent: () => findSentReply(discordRest("fake"), target, base(path).text),
      }));
      expect(result).toEqual({ id: "800", duplicate: true });
      expect(sends).toBe(0);
    } finally { fetch.mockRestore(); }
  });
});

test("an incomplete history check keeps an uncertain reply pending instead of guessing it was not sent", async () => {
  await withDb(async (path) => {
    await expect(sendOnce(base(path, { send: async () => { throw new Error("response lost"); } }))).rejects.toThrow();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) =>
      Response.json(String(input).endsWith("/users/@me") ? { id: "88" } :
        Array.from({ length: 100 }, (_, i) => ({ id: String(600 + i), content: "other", author: { id: "7" } }))),
    { preconnect: globalThis.fetch.preconnect }));
    try {
      let sends = 0;
      await expect(sendOnce(base(path, {
        send: async () => { sends++; return "duplicate"; },
        findSent: () => findSentReply(discordRest("fake"), { channel_id: "100", message_id: "500" }, base(path).text),
      }))).rejects.toThrow("Reply history is incomplete");
      expect(sends).toBe(0);
    } finally { fetch.mockRestore(); }
  });
});

test("a sent reply's receipt still prevents a duplicate 40 days later", async () => {
  await withDb(async (path) => {
    const day = 24 * 60 * 60 * 1000;
    expect(await sendOnce(base(path, { now: () => 1_000, send: async () => "first" }))).toEqual({ id: "first", duplicate: false });
    expect(await sendOnce(base(path, { now: () => 1_000 + 40 * day, send: async () => "second" }))).toEqual({ id: "first", duplicate: true });
  });
});
