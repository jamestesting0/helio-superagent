import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterConfig } from "./authorization.ts";
import { classify, type IncomingMessage } from "./filter.ts";
import { Conversations, snowflakeTime } from "./conversations.ts";
import { Delivery } from "./delivery.ts";
import { DiscordRestError, type Rest } from "./rest.ts";
import { guardedReply, sweepWorking } from "./working.ts";

const normal = "1199770187738644652";
const other = "1220331873079922810";
const T0 = Date.now();
const MIN = 60_000;
const idAt = (ms: number, n = 0) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
const eyesPath = (id: string) => `DELETE /channels/${normal}/messages/${id}/reactions/%F0%9F%91%80/@me`;

async function withStores(run: (delivery: Delivery, store: Conversations) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "helio-working-"));
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try { await run(delivery, store); }
  finally { delivery.close(); store.dispose(); await rm(dir, { recursive: true, force: true }); }
}

function stage(delivery: Delivery, id: string, extra: Record<string, unknown> = {}) {
  delivery.stage("inbound", id, JSON.stringify({
    channel_id: normal, author_id: "66", author: "staff", role: "STAFF_QUESTION", scope: "may-report-issue",
    attention: "direct", channel_policy: "normal", content: "help", attachments: [],
    sent_at: new Date(snowflakeTime(id)).toISOString(), ...extra,
  }));
}

function fakeRest(messages: Record<string, string | null>, failOnce: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const failed = new Set<string>();
  const rest = (async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const read = /^\/channels\/\d+\/messages\/(\d+)$/.exec(path);
    if (read && method === "GET") {
      const content = messages[read[1]!];
      if (content == null) throw new DiscordRestError(404, method, path, '{"code":10008}');
      return { content };
    }
    if (method === "DELETE") {
      const target = /^\/channels\/\d+\/messages\/(\d+)\//.exec(path)?.[1];
      if (target && failOnce.has(target) && !failed.has(target)) {
        failed.add(target);
        throw new DiscordRestError(500, method, path, "boom");
      }
    }
    return undefined;
  }) as Rest;
  return { rest, calls };
}

function reply(delivery: Delivery, store: Conversations, rest: Rest, target: string, now: number,
  lists: { covers?: string[]; seen?: string[] } = {}) {
  const sent: (readonly string[])[] = [];
  const result = guardedReply({
    delivery, store, rest, channel: normal, target, covers: lists.covers ?? [], seen: lists.seen ?? [],
    send: async (mentions) => { sent.push(mentions); return "900"; },
    cleanup: async () => {}, now: () => now, warn: () => {},
  });
  return { result, sent };
}

test("a ping's working window admits only its sender's later messages in that channel, judged by message time", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0);
    store.openWorking(normal, "66", anchor, T0);
    const later = idAt(T0 + MIN);
    expect(store.workingAnchor(normal, "66", later)).toBe(anchor);
    expect(store.workingAnchor(normal, "67", later)).toBeUndefined();
    expect(store.workingAnchor(other, "66", later)).toBeUndefined();
    expect(store.workingAnchor(normal, "66", idAt(T0 - 1000))).toBeUndefined();
    expect(store.workingAnchor(normal, "66", idAt(T0 + 31 * MIN))).toBeUndefined();
    expect(store.openWorking(normal, "66", idAt(T0 + 5000), T0 + 5000).message_id).toBe(anchor);

    store.closeWorking([anchor], T0 + 2 * MIN);
    expect(store.workingAnchor(normal, "66", idAt(T0 + 3 * MIN))).toBeUndefined();
    expect(store.workingAnchor(normal, "66", later)).toBe(anchor);
  });
});

test("in a normal chat an un-pinged addition is admitted for review and names the message it adds to", async () => {
  await withStores(async (_delivery, store) => {
    const cfg = filterConfig({
      DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: normal, DORI_DISCORD_REPORT_CHANNELS: normal,
    }, undefined, (channel, user, id) => store.workingAnchor(channel, user, id));
    cfg.botId = "88";
    const anchor = idAt(T0);
    store.openWorking(normal, "66", anchor, T0);
    const msg: IncomingMessage = {
      id: idAt(T0 + MIN), channel_id: normal, guild_id: "300", author: { id: "66", username: "staff" },
      content: "also on mobile", timestamp: new Date(T0 + MIN).toISOString(), mentions: [],
    };
    const admitted = await classify(msg, cfg, async () => undefined);
    expect([admitted?.addition_to, admitted?.attention, admitted?.role]).toEqual([anchor, "review", "STAFF_QUESTION"]);
    expect(await classify({ ...msg, author: { id: "67", username: "bystander" } }, cfg, async () => undefined)).toBeNull();
  });
});

test("a clean reply is sent, closes the window and removes the 👀", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0);
    stage(delivery, anchor);
    store.openWorking(normal, "66", anchor, T0);
    store.setReacted(anchor, true);
    const { rest, calls } = fakeRest({ [anchor]: "help" });
    const { result, sent } = reply(delivery, store, rest, anchor, T0 + 10_000);
    expect(await result).toEqual({ code: 0, lines: ["SENT 900"] });
    expect(sent).toEqual([[]]);
    expect(calls).toContain(eyesPath(anchor));
    expect([store.working(anchor)?.reacted, store.working(anchor)?.closed_at]).toEqual([0, T0 + 10_000]);
    expect(store.workingAnchor(normal, "66", idAt(T0 + 20_000))).toBeUndefined();
  });
});

test("a newer message holds the reply; covering it sends one reply and marks it handled", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0), addition = idAt(T0 + 5000);
    stage(delivery, anchor);
    stage(delivery, addition, { content: "also on mobile", attention: "review", addition_to: anchor });
    store.openWorking(normal, "66", anchor, T0);
    const { rest } = fakeRest({ [anchor]: "help" });

    const held = reply(delivery, store, rest, anchor, T0 + 10_000);
    const first = await held.result;
    expect(first.code).toBe(3);
    expect(first.lines[0]!.startsWith("REPLY_HELD ")).toBe(true);
    const report = JSON.parse(first.lines[0]!.slice("REPLY_HELD ".length));
    expect(report.newer.map((m: { message_id: string; addition_to: string }) => [m.message_id, m.addition_to])).toEqual([[addition, anchor]]);
    expect(held.sent).toEqual([]);

    const covered = reply(delivery, store, rest, anchor, T0 + 20_000, { covers: [addition] });
    expect(await covered.result).toEqual({ code: 0, lines: ["SENT 900", `REPLY_COVERED ${addition}`] });
    expect(covered.sent).toEqual([[]]);
    expect(delivery.status("inbound", addition).disposition).toBe("done");
    expect(delivery.status("inbound", anchor).disposition).toBe("pending");
  });
});

test("covering another person's related message lets the reply ping them, and nobody else", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0), sameForMe = idAt(T0 + 5000);
    stage(delivery, anchor);
    stage(delivery, sameForMe, { author_id: "67", content: "<@88> same for me" });
    const { rest } = fakeRest({ [anchor]: "help" });
    const { result, sent } = reply(delivery, store, rest, anchor, T0 + 10_000, { covers: [sameForMe] });
    expect((await result).code).toBe(0);
    expect(sent).toEqual([["67"]]);
  });
});

test("holding stops after two holds, then the reply goes out and names what was left", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0), next = idAt(T0 + 5000);
    stage(delivery, anchor);
    stage(delivery, next, { author_id: "67", content: "<@88> different question" });
    const { rest } = fakeRest({ [anchor]: "help" });
    expect((await reply(delivery, store, rest, anchor, T0 + 10_000).result).code).toBe(3);
    expect((await reply(delivery, store, rest, anchor, T0 + 20_000).result).code).toBe(3);
    expect(await reply(delivery, store, rest, anchor, T0 + 30_000).result).toEqual({
      code: 0, lines: ["SENT 900", `REPLY_NOTE newer messages left as their own turns: ${next}`],
    });
    expect(delivery.status("inbound", next).disposition).toBe("pending");
  });
});

test("a hold older than two minutes no longer holds", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0), next = idAt(T0 + 5000);
    stage(delivery, anchor);
    stage(delivery, next, { author_id: "67" });
    const { rest } = fakeRest({ [anchor]: "help" });
    expect((await reply(delivery, store, rest, anchor, T0 + 10_000).result).code).toBe(3);
    expect((await reply(delivery, store, rest, anchor, T0 + 10_000 + 2 * MIN).result).code).toBe(0);
  });
});

test("a deleted original is skipped without sending; an edit holds once until it is acknowledged", async () => {
  await withStores(async (delivery, store) => {
    const deleted = idAt(T0), edited = idAt(T0, 1);
    stage(delivery, deleted);
    stage(delivery, edited);
    store.openWorking(normal, "66", deleted, T0);
    const { rest } = fakeRest({ [deleted]: null, [edited]: "help, it is the queue button" });

    const skip = reply(delivery, store, rest, deleted, T0 + 10_000);
    expect((await skip.result).code).toBe(4);
    expect(skip.sent).toEqual([]);
    expect(store.working(deleted)?.closed_at).toBe(T0 + 10_000);

    const held = await reply(delivery, store, rest, edited, T0 + 10_000).result;
    expect(held.code).toBe(3);
    expect(JSON.parse(held.lines[0]!.slice("REPLY_HELD ".length)).edited_content).toBe("help, it is the queue button");
    expect((await reply(delivery, store, rest, edited, T0 + 20_000, { seen: [edited] }).result).code).toBe(0);
  });
});

test("upkeep clears 👀 left on handled messages, warns once at 30 minutes, gives up at 2 hours, and retries failed removals", async () => {
  await withStores(async (delivery, store) => {
    const handled = idAt(T0), stale = idAt(T0, 1), flaky = idAt(T0, 2);
    for (const id of [handled, stale, flaky]) {
      stage(delivery, id);
      store.ensureWorking(normal, "66", id);
      store.setReacted(id, true);
    }
    delivery.acknowledge("inbound", handled);
    delivery.acknowledge("inbound", flaky);
    const warnings: string[] = [];
    const { rest, calls } = fakeRest({}, new Set([flaky]));
    const sweep = (now: number) => sweepWorking(store, delivery, rest, now, (message) => warnings.push(message));

    await sweep(T0 + MIN);
    expect(store.working(handled)?.reacted).toBe(0);
    expect(store.working(flaky)?.reacted).toBe(1);
    expect(store.working(stale)?.closed_at).toBeNull();

    await sweep(T0 + 31 * MIN);
    await sweep(T0 + 32 * MIN);
    expect(store.working(flaky)?.reacted).toBe(0);
    expect(warnings.filter((w) => w.includes(stale) && w.includes("30 minutes"))).toHaveLength(1);

    await sweep(T0 + 121 * MIN);
    expect(warnings.filter((w) => w.includes(stale) && w.includes("2 hours"))).toHaveLength(1);
    expect([store.working(stale)?.reacted, store.working(stale)?.closed_at]).toEqual([0, T0 + 121 * MIN]);
    expect(calls.filter((call) => call === eyesPath(stale))).toHaveLength(1);
  });
});
