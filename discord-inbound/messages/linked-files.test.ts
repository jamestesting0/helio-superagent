import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { reauthorize } from "../intake/authorization.ts";
import type { FilterConfig } from "../intake/filter.ts";
import { prepareMessageBody } from "./forwarded.ts";
import { awaitsPreview, linkedFiles, MAX_LINKED_FILES, Previews, type PreviewEmbed } from "./linked-files.ts";
import type { Rest } from "../discord/rest.ts";

const boundary: { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } = globalThis;
const http = spyOn(boundary, "fetch");
const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#0f0" } }).png().toBuffer();
const cdn = "https://cdn.discordapp.com/attachments/11/22/shot.png?ex=1&is=2&hm=3";
const external = "https://i.example.test/cat.png";
const proxy = "https://media.discordapp.net/external/abc123/https/i.example.test/cat.png";
const preview = { type: "image", url: external, thumbnail: { url: external, proxy_url: proxy } };
const requested: string[] = [];
beforeEach(() => {
  requested.length = 0;
  http.mockReset();
  http.mockImplementation(async (input) => {
    requested.push(String(input));
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
  });
});
afterAll(() => http.mockRestore());

async function prepared(policy: "normal" | "trusted", content: string, embeds: PreviewEmbed[] = []) {
  const root = await mkdtemp(join(tmpdir(), "dori-linked-"));
  try {
    return await prepareMessageBody({ id: "700", content, embeds }, root, false, policy);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("trusted chats read Discord attachment links and previewed images, never contacting the linked host", async () => {
  const body = await prepared("trusted", `bug: ${cdn} and ${external} see https://example.test/page`, [preview]);
  expect(body.content).toBe("bug: [linked: shot.png] and [linked: linked-image-1] see [link omitted]");
  expect(body.attachments.map((file) => [file.name, file.kind, file.source])).toEqual([
    ["shot.png", "image", "link"], ["linked-image-1", "image", "link"],
  ]);
  expect(requested).toEqual([cdn, proxy]);
  expect(requested.some((url) => url.includes("i.example.test/cat.png") && !url.startsWith(proxy))).toBe(false);
});

test("normal chats process no links at all", async () => {
  const body = await prepared("normal", `bug: ${cdn} and ${external}`, [preview]);
  expect(body.content).toBe("bug: [link omitted] and [link omitted]");
  expect(body.attachments).toEqual([]);
  expect(requested).toEqual([]);
});

test("an image link without a preview says so, and other links stay omitted", () => {
  expect(linkedFiles(`<${external}> https://example.test/a`, []).content)
    .toBe("<[image link omitted: no preview]> [link omitted]");
});

test("linked files are capped per message", () => {
  const links = Array.from({ length: MAX_LINKED_FILES + 2 }, (_, i) => cdn.replace("shot", `s${i}`)).join(" ");
  const result = linkedFiles(links, []);
  expect(result.attachments).toHaveLength(MAX_LINKED_FILES);
  expect(result.content.match(/\[link omitted\]/g)).toHaveLength(2);
});

test("a preview whose link Discord normalized is still read", () => {
  const result = linkedFiles("look https://i.example.test/cat.png?x=1", [preview]);
  expect(result.attachments.map((item) => [item.url, item.preview])).toEqual([[proxy, true]]);
});

test("waiting is needed only for unpreviewed external links", () => {
  expect(awaitsPreview(`see ${external}`, [])).toBe(true);
  expect(awaitsPreview(`see ${external}`, [preview])).toBe(false);
  expect(awaitsPreview(`see ${cdn}`, [])).toBe(false);
  expect(awaitsPreview("no links", undefined)).toBe(false);
});

function fakeClock() {
  const timers: (() => void)[] = [];
  return {
    timers,
    clock: { setTimeout: (callback: () => void) => timers.push(callback), clearTimeout: () => undefined },
  };
}

test("a late preview resolves the wait without REST", async () => {
  const { clock } = fakeClock();
  const waiter = new Previews(clock);
  const fetchLatest = async () => { throw new Error("REST must not be used"); };
  const waiting = waiter.wait("1", fetchLatest);
  waiter.update("1", [preview]);
  expect(await waiting).toEqual([preview]);
});

test("a preview that arrived before the wait is used immediately", async () => {
  const waiter = new Previews(fakeClock().clock);
  waiter.update("1", [preview]);
  expect(await waiter.wait("1", async () => undefined)).toEqual([preview]);
});

test("without an update the wait falls back to one REST read when the timer fires", async () => {
  const { clock, timers } = fakeClock();
  const waiter = new Previews(clock);
  let reads = 0;
  const waiting = waiter.wait("1", async () => { reads++; return [preview]; });
  expect(timers).toHaveLength(1);
  timers[0]?.();
  expect(await waiting).toEqual([preview]);
  expect(reads).toBe(1);
});

test("a message replayed after its channel stops being trusted loses its linked files", async () => {
  const cfg: FilterConfig = { ownerId: "1", botId: "9", allowed: new Set(["100"]), normalChannels: new Set(["100"]) };
  const rest = (async () => ({ id: "100", type: 0, guild_id: "5" })) as unknown as Rest;
  const linked = { path: "/p/a.png", kind: "image", name: "shot.png", source: "link" };
  const upload = { path: "/p/b.png", kind: "image", name: "upload.png" };
  const payload = JSON.stringify({
    message_id: "700", channel_id: "100", content: "x", sent_at: new Date().toISOString(), preparation_complete: true,
    attachments: [upload, linked], blocked_attachments: [{ name: "linked-image-1", reason: "r", source: "link" }],
    forwarded: [{ attachments: [linked], blocked_attachments: [] }],
    discord_origin: { version: 1, message_id: "700", channel_id: "100", guild_id: "5", author_id: "1", bot: false,
      webhook_id: null, mention_ids: ["9"], reply_to: null, reply_author_id: null },
  });
  const current = await reauthorize(payload, cfg, rest) as Record<string, unknown> | null;
  expect(current?.channel_policy).toBe("normal");
  expect(current?.attachments).toEqual([upload]);
  expect(current?.blocked_attachments).toEqual([]);
  expect((current?.forwarded as { attachments: unknown[] }[] | undefined)?.[0]?.attachments).toEqual([]);
});
