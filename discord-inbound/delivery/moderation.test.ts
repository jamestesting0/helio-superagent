import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";
import { reactPendingBlocks, strikeLinks } from "./moderation-effects.ts";
import { discordRest } from "../discord/rest.ts";
import { Database } from "bun:sqlite";

const START = Date.parse("2026-11-05T00:00:00Z");
const MINUTE = 60_000;
let now = START;
let restoreClock = () => {};
let dir = "";
let delivery: Delivery;
let next = 100;
beforeEach(async () => {
  now = START;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  dir = await mkdtemp(join(tmpdir(), "helio-moderation-"));
  delivery = new Delivery(join(dir, "delivery.sqlite"));
});
afterEach(async () => {
  delivery.close();
  restoreClock();
  await rm(dir, { recursive: true, force: true });
});

function ping(minutes: number, overrides: Record<string, unknown> = {}): string {
  const id = String(next++);
  now = Math.max(now, START + minutes * MINUTE);
  delivery.stage("inbound", id, JSON.stringify({
    role: "STAFF_QUESTION", scope: "answer-only", channel_policy: "normal", attention: "direct", pinged: true,
    author_id: "500", channel_id: "700", message_id: id, content: "hey",
    sent_at: new Date(START + minutes * MINUTE).toISOString(), ...overrides,
  }));
  return id;
}
const dismiss = (id: string) => delivery.irrelevant(id, "Unrelated chatter");

test("the fifth irrelevant ping commits a block whose pending reaction is repaired after reopening the database", async () => {
  const results = [0, 10, 20, 30, 40].map((minutes) => dismiss(ping(minutes)));
  expect(results.slice(0, 4).every((result) => result.blocked === undefined)).toBe(true);
  expect(results[4]?.blocked).toMatchObject({ user_id: "500", source: "auto", evidence_message_id: "104" });
  expect(delivery.moderation.isBlocked("500")).toBe(true);
  expect(delivery.moderation.pendingReactions()).toEqual([{ user_id: "500", channel_id: "700", message_id: "104" }]);
  delivery.close();
  delivery = new Delivery(join(dir, "delivery.sqlite"));
  const requests: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));
    return new Response(null, { status: 204 });
  }, { preconnect: fetch.preconnect }));
  try {
    await reactPendingBlocks(delivery, discordRest("fixture"), (warning) => { throw new Error(warning); });
  } finally { fetcher.mockRestore(); }
  expect(requests.map((url) => new URL(url).pathname))
    .toEqual(["/api/v10/channels/700/messages/104/reactions/%F0%9F%9A%AB/@me"]);
  expect(delivery.moderation.pendingReactions()).toEqual([]);
});

test("four strikes, or strikes spread beyond 12 hours, do not block", () => {
  for (const minutes of [0, 10, 20, 30]) dismiss(ping(minutes));
  expect(delivery.moderation.isBlocked("500")).toBe(false);
  expect(dismiss(ping(13 * 60)).blocked).toBeUndefined();
  expect(delivery.moderation.isBlocked("500")).toBe(false);
});

test("one burst of pings counts as a single strike", () => {
  for (const seconds of [0, 15, 30, 45, 60, 90]) dismiss(ping(seconds / 60));
  expect(delivery.moderation.strikeCount("500", now)).toBe(1);
  expect(delivery.moderation.isBlocked("500")).toBe(false);
});

test("trusted channels, owner, trusted users and unpinged messages never strike", () => {
  const exempt: Record<string, unknown>[] = [
    { channel_policy: "trusted", attention: "review" }, { role: "OWNER_REQUEST", attention: "review" },
    { role: "TRUSTED_REQUEST", attention: "review" }, { pinged: undefined, attention: "review" },
  ];
  for (const [index, overrides] of exempt.entries()) dismiss(ping(index * 10, overrides));
  expect(delivery.moderation.strikeCount("500", now)).toBe(0);
});

test("a replayed dismissal never counts twice", () => {
  const id = ping(0);
  dismiss(id);
  dismiss(id);
  expect(delivery.moderation.strikeCount("500", now)).toBe(1);
});

test("blocking dismisses the sender's other unaccepted messages without new strikes", () => {
  const waiting = ping(1);
  const accepted = ping(2);
  delivery.accept(accepted);
  const other = ping(3, { author_id: "501" });
  const result = delivery.block("500", { source: "owner", reason: "spam", by: "1" }, new Set(["1"]));
  expect(result.dismissed).toEqual([waiting]);
  expect(delivery.status("inbound", waiting)).toMatchObject({ disposition: "irrelevant", reason: "Sender is blacklisted" });
  expect(delivery.status("inbound", accepted).disposition).toBe("accepted");
  expect(delivery.status("inbound", other).disposition).toBe("pending");
  expect(delivery.moderation.strikeCount("500", now)).toBe(0);
});

test("owner and trusted users cannot be blocked, and unblocking clears strikes", () => {
  expect(() => delivery.block("1", { source: "owner", reason: "x", by: "1" }, new Set(["1", "2"]))).toThrow("cannot be blacklisted");
  for (const minutes of [0, 10]) dismiss(ping(minutes));
  delivery.block("500", { source: "owner", reason: "spam", by: "1" }, new Set(["1"]));
  expect(delivery.moderation.unblock("500")).toBe(true);
  expect(delivery.moderation.isBlocked("500")).toBe(false);
  expect(delivery.moderation.strikeCount("500", now)).toBe(0);
});

test("the 21st ping in an hour is throttled with one notice, and the next hour admits again", () => {
  const at = (minutes: number) => START + minutes * MINUTE;
  const admitted = Array.from({ length: 20 }, (_, i) => delivery.moderation.admitPing("500", `m${i}`, at(i)).admitted);
  expect(admitted.every(Boolean)).toBe(true);
  expect(delivery.moderation.admitPing("500", "m20", at(21))).toEqual({ admitted: false, notify: true });
  expect(delivery.moderation.admitPing("500", "m21", at(22))).toEqual({ admitted: false, notify: false });
  expect(delivery.moderation.admitPing("500", "m0", at(23)).admitted).toBe(true);
  expect(delivery.moderation.admitPing("500", "m22", at(61)).admitted).toBe(true);
});

test("an automatic block keeps its counted strikes and their reasons after the strikes themselves are pruned", () => {
  const minutes = [0, 10, 20, 30, 40];
  const ids = minutes.map((m, i) => { const id = ping(m); delivery.irrelevant(id, `Off topic ${i}`); return id; });
  const expected = ids.map((id, i) => ({ message_id: id, channel_id: "700", at: START + minutes[i]! * MINUTE, reason: `Off topic ${i}` }));
  expect(delivery.moderation.strikeEvidence("500")).toEqual(expected);
  const db = new Database(join(dir, "delivery.sqlite"));
  try { db.run("DELETE FROM strikes"); } finally { db.close(); }
  expect(delivery.moderation.strikeEvidence("500")).toEqual(expected);
});

test("strike evidence renders as message links, falling back to IDs when a channel cannot be looked up", async () => {
  const evidence = [{ message_id: "1", channel_id: "700", at: 0, reason: "a" }, { message_id: "2", channel_id: "701", at: 0, reason: "b" }];
  const guildOf = async (channel: string) => { if (channel === "701") throw new Error("Missing access"); return "900"; };
  expect(await strikeLinks(evidence, guildOf)).toEqual([
    { link: "https://discord.com/channels/900/700/1", reason: "a" },
    { link: "channel 701 message 2", reason: "b" },
  ]);
});
