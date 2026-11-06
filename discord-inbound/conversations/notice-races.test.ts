import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Conversations, DAY_MS } from "./conversations.ts";
import { sweepConversations } from "./conversation-upkeep.ts";
import type { Rest } from "../discord/rest.ts";
import { Delivery } from "../delivery/delivery.ts";
import { newerInputPending } from "./pending-input.ts";

const now = Date.parse("2026-11-06T12:00:00Z");
const botNotice = { message_id: "900", author_id: "88", author: "Helio", bot: true, content: "courtesy",
  sent_at: new Date(now + DAY_MS).toISOString(), attachment_count: 0, reply_to: "10" };

test("two sweepers and Gateway-before-REST produce one nudge without transcript activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-notice-race-"));
  const path = join(dir, "conversations.sqlite");
  const first = new Conversations(path), second = new Conversations(path);
  const posts: string[] = [];
  try {
    const row = first.open("100", "99", "10", "question", now);
    first.applyReply(row, { disposition: "question", waiting_on: "Which server?" }, now);
    const rest: Rest = async (_path, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(JSON.stringify(init.body));
        posts.push(body.nonce);
        expect(first.observeNotice("100", body.nonce, "900", now + DAY_MS)).toBe(true);
        first.append("100", "99", botNotice, now + DAY_MS);
        return JSON.parse('{"id":"900"}');
      }
      return JSON.parse('{"guild_id":"300"}');
    };
    const sweep = (store: Conversations, at: number) => sweepConversations({
      store, rest, now: at, emit: () => {}, canContact: async () => true,
    });
    await Promise.all([sweep(first, now + DAY_MS), sweep(second, now + DAY_MS)]);
    await sweep(second, now + 2 * DAY_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^[a-f0-9]{25}$/);
    expect(first.transcript("100", "99")).toEqual([]);
    expect(first.get("100", "99")).toMatchObject({ last_activity: now, nudged_at: now + DAY_MS });
  } finally { first.dispose(); second.dispose(); await rm(dir, { recursive: true }); }
});

test("an interrupted uncertain send reconciles its nonce after restart without retrying POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-notice-restart-"));
  const path = join(dir, "conversations.sqlite");
  let store = new Conversations(path), nonce: string | undefined, posts = 0, visible = false;
  const rest: Rest = async (path, init) => {
    if (init?.method === "POST") {
      nonce = JSON.parse(JSON.stringify(init.body)).nonce;
      posts++;
      throw new Error("response lost");
    }
    if (path.includes("/messages?")) return JSON.parse(JSON.stringify(visible ? [
      { id: "900", nonce, author: { id: "88" } },
    ] : []));
    if (path === "/users/@me") return JSON.parse('{"id":"88"}');
    return JSON.parse('{"guild_id":"300"}');
  };
  const sweep = () => sweepConversations({ store, rest, now: now + DAY_MS, emit: () => {}, canContact: async () => true });
  try {
    store.applyReply(store.open("100", "99", "10", "question", now),
      { disposition: "question", waiting_on: "Which server?" }, now);
    await sweep();
    await sweep();
    expect(posts).toBe(1);
    expect(store.get("100", "99")?.nudged_at).toBeNull();
    store.dispose();
    store = new Conversations(path);
    visible = true;
    await sweep();
    expect(posts).toBe(1);
    expect(store.isNotice("900")).toBe(true);
    expect(store.get("100", "99")?.nudged_at).toBe(now + DAY_MS);
  } finally { store.dispose(); await rm(dir, { recursive: true }); }
});

test("a human response during a timeout POST stays open and a hold before POST prevents the courtesy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-notice-revision-"));
  const store = new Conversations(join(dir, "conversations.sqlite"));
  let posts = 0;
  try {
    store.applyReply(store.open("100", "99", "10", "question", now),
      { disposition: "question", waiting_on: "Which server?" }, now);
    const rest: Rest = async (_path, init) => {
      if (init?.method === "POST") {
        posts++;
        store.claim("100", "99", { ...botNotice, message_id: "11", author_id: "99", bot: false }, now + 3 * DAY_MS);
        return JSON.parse('{"id":"900"}');
      }
      return JSON.parse('{"guild_id":"300"}');
    };
    await sweepConversations({ store, rest, now: now + 3 * DAY_MS, emit: () => {}, canContact: async () => true });
    expect(posts).toBe(1);
    expect(store.get("100", "99")?.status).toBe("open");
    expect(store.state(store.get("100", "99")!)).toBe("waiting_on_helio");
    const row = store.get("100", "99")!;
    store.applyReply(row, { disposition: "question", waiting_on: "Which server?" }, now + 3 * DAY_MS);
    let checks = 0;
    await sweepConversations({ store, rest, now: now + 4 * DAY_MS, emit: () => {}, canContact: async () => {
      if (++checks === 2) store.hold("100", "99", "Owner decision", "10");
      return true;
    } });
    expect(posts).toBe(1);
    expect(store.get("100", "99")?.status).toBe("on_hold");
  } finally { store.dispose(); await rm(dir, { recursive: true }); }
});

test.each(["post", "final-contact"])("a queued reply during timeout remains open before preparation (%s)", async (stageAt) => {
  const dir = await mkdtemp(join(tmpdir(), "helio-notice-queued-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  let posts = 0;
  let contacts = 0;
  const stage = () => queue.stage("inbound", "11", JSON.stringify({
    channel_id: "100", author_id: "99", reply_to: "10", preparation_complete: false,
  }));
  try {
    store.applyReply(store.open("100", "99", "10", "question", now),
      { disposition: "question", waiting_on: "Which server?" }, now);
    const rest: Rest = async (_path, init) => {
      if (init?.method === "POST") {
        posts++;
        if (stageAt === "post") stage();
        return JSON.parse('{"id":"900"}');
      }
      return JSON.parse('{"guild_id":"300"}');
    };
    const sweep = () => sweepConversations({ store, rest, now: now + 3 * DAY_MS, emit: () => {},
      canContact: async () => {
        if (++contacts === 3 && stageAt === "final-contact") stage();
        return true;
      }, hasNewInput: row =>
        newerInputPending(queue.pending("inbound"), store, row, [row.latest_input_id ?? row.anchor_message_id]) });
    await sweep();
    await sweep();
    expect(posts).toBe(1);
    expect(store.get("100", "99", "10")?.status).toBe("open");
    expect(queue.pending("inbound").map(row => row.id)).toEqual(["11"]);
    expect(store.working("11")).toBeNull();
  } finally { queue.close(); store.dispose(); await rm(dir, { recursive: true }); }
});
