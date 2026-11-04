import { expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations, snowflakeTime } from "../conversations/conversations.ts";
import { Delivery } from "../delivery/delivery.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { guardedReply } from "../conversations/reply-guard.ts";

export const normal = "1199770187738644652";
export const other = "1220331873079922810";
export const T0 = Date.parse("2026-11-04T12:00:00Z");
export const MIN = 60_000;
export const idAt = (ms: number, n = 0) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
export const eyesPath = (id: string) => `DELETE /channels/${normal}/messages/${id}/reactions/%F0%9F%91%80/@me`;

export async function withStores(run: (delivery: Delivery, store: Conversations, path: string) => Promise<void>) {
  const clock = spyOn(Date, "now").mockReturnValue(T0);
  const dir = await mkdtemp(join(tmpdir(), "helio-working-"));
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  try { await run(delivery, store, join(dir, "discord-conversations.sqlite")); }
  finally { delivery.close(); store.dispose(); clock.mockRestore(); await rm(dir, { recursive: true, force: true }); }
}

export function stage(delivery: Delivery, id: string, extra: Record<string, unknown> = {}) {
  delivery.stage("inbound", id, JSON.stringify({
    channel_id: normal, author_id: "66", author: "staff", role: "STAFF_QUESTION", scope: "may-report-issue",
    attention: "direct", channel_policy: "normal", content: "help", attachments: [],
    sent_at: new Date(snowflakeTime(id)).toISOString(), ...extra,
  }));
}

export function fakeRest(messages: Record<string, string | null>, failOnce: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const failed = new Set<string>();
  const rest: Rest = (async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const read = /^\/channels\/\d+\/messages\/(\d+)$/.exec(path)?.[1];
    if (read && method === "GET") {
      const content = messages[read];
      if (content == null) throw new DiscordRestError(404, method, path, '{"code":10008}');
      return JSON.parse(JSON.stringify({ content }));
    }
    if (method === "DELETE") {
      const target = /^\/channels\/\d+\/messages\/(\d+)\//.exec(path)?.[1];
      if (target && failOnce.has(target) && !failed.has(target)) {
        failed.add(target);
        throw new DiscordRestError(500, method, path, "boom");
      }
    }
    return JSON.parse("null");
  });
  return { rest, calls };
}

export function reply(delivery: Delivery, store: Conversations, rest: Rest, target: string, now: number,
  lists: { covers?: string[]; seen?: string[] } = {}) {
  const sent: (readonly string[])[] = [];
  const result = guardedReply({
    delivery, store, rest, channel: normal, target, covers: lists.covers ?? [], seen: lists.seen ?? [],
    send: async (mentions) => { sent.push(mentions); return "900"; },
    cleanup: async () => {}, now: () => now, warn: () => {},
  });
  return { result, sent };
}
