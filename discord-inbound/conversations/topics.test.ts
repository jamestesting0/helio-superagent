import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { describeMessage } from "../messages/reply-context.ts";
import { fakeRest, idAt, normal, other, stage, T0, withStores } from "../fixtures/working.ts";
import { guardedReply } from "./reply-guard.ts";
import { conversationSnapshot } from "./conversation-context.ts";
import { renderTurn } from "../delivery/context-render.ts";
import type { Conversation } from "./conversations.ts";
import { closureNotes } from "./closure.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { filterConfig } from "../intake/authorization.ts";

const said = (id: string, author: string, channel = normal, reply_to?: string) => describeMessage({
  id, channel_id: channel, author: { id: author, username: author }, content: "details", timestamp: new Date(T0).toISOString(),
  ...(reply_to ? { message_reference: { message_id: reply_to } } : {}),
}, 12_000).entry;
const here = { channel: normal, audience: "public" } as const;
const turnOf = (text: string) => JSON.parse(text.slice(text.indexOf("{")));

test("a meaningless message joins nothing; a topic reply adds the people it answers or covers", async () => {
  await withStores(async (delivery, store, path) => {
    const anchor = idAt(T0), lol = idAt(T0, 1), same = idAt(T0, 2), also = idAt(T0, 3);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.append(normal, "79", said(lol, "79", normal, anchor), T0, here);
    expect([store.isParticipant(anchor, "79"), store.transcriptOf(store.topic(anchor)!).length]).toEqual([false, 0]);
    stage(delivery, same, { author_id: "77", reply_to: anchor, content: "same here, queue stuck" });
    stage(delivery, also, { author_id: "78", reply_to: anchor, content: "me too since noon" });
    const { rest } = fakeRest({ [same]: "same here, queue stuck", [also]: "me too since noon" });
    const result = await guardedReply({
      delivery, store, rest, channel: normal, target: same, covers: [also], seen: [], text: "Looking into it.",
      send: async () => "900", cleanup: async () => {}, now: () => T0 + 1000, warn: () => {},
      settlement: { path: join(dirname(path), "reply-sends.sqlite"), event: "progress:1", meaning: { disposition: "progress" } },
    });
    expect(result.code).toBe(0);
    expect(store.participants(anchor).map(person => [person.user_id, person.via]))
      .toEqual([["66", "opened"], ["77", "answered"], ["78", "covered"]]);
  });
});

test("a final reply mentions participants in its channel and sends one closing note to each other channel", async () => {
  await withStores(async (delivery, store, path) => {
    const anchor = idAt(T0), second = idAt(T0, 1), far = idAt(T0, 2), target = idAt(T0, 3);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "77", "answered", normal, second, T0);
    store.join(anchor, "55", "answered", other, far, T0);
    stage(delivery, target, { author_id: "66", reply_to: anchor, content: "any news?" });
    const { rest } = fakeRest({ [target]: "any news?" });
    const sent: { mentions: readonly string[]; lead: string }[] = [];
    const notes: { row: Conversation; groups: unknown }[] = [];
    const result = await guardedReply({
      delivery, store, rest, channel: normal, target, covers: [], seen: [], text: "Fixed in the latest release.",
      send: async (mentions, lead) => { sent.push({ mentions, lead }); return "900"; },
      notifyOthers: async (row, groups) => { notes.push({ row, groups }); return ["REPLY_CLOSURE_SENT"]; },
      cleanup: async () => {}, now: () => T0 + 1000, warn: () => {},
      settlement: { path: join(dirname(path), "reply-sends.sqlite"), event: "final:1", meaning: { disposition: "final" } },
    });
    expect(result.code).toBe(0);
    // The person replied to is pinged by the reply itself; the other participant here is mentioned.
    expect(sent).toEqual([{ mentions: ["77"], lead: "<@77>" }]);
    expect(notes.map(note => note.groups)).toEqual([[{ channel: other, users: ["55"], target: far }]]);
    expect(result.lines).toContain("REPLY_CLOSURE_SENT");
    expect(store.topic(anchor)?.status).toBe("resolved");
  });
});

test("a participant continues a topic from another channel, and their topics are listed wherever they are", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0), far = idAt(T0, 1);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "55", "answered", other, far, T0);
    expect(store.forReply(other, "55")?.anchor_message_id).toBe(anchor);
    expect(store.forReply(other, "66")).toBeNull();
    expect(store.topicsFor("55").map(row => row.anchor_message_id)).toEqual([anchor]);
  });
});

test("merging moves people, history and the issue subscription, and the old anchor still finds the topic", async () => {
  await withStores(async (_delivery, store, path) => {
    const older = idAt(T0), newer = idAt(T0, 1), entry = idAt(T0, 2);
    store.open(normal, "66", older, "Queue stuck", T0);
    store.open(other, "55", newer, "Queue broken", T0 + 1);
    store.claim(other, "55", said(entry, "55", other, newer), T0 + 2, { channel: other, audience: "public" });
    store.setState(other, "55", { issue: "https://github.com/o/r/issues/7" }, newer, T0 + 3);
    store.setState(normal, "66", { issue: "https://github.com/o/r/issues/7" }, older, T0 + 4);
    const merged = store.topic(newer)!;
    expect(merged.anchor_message_id).toBe(older);
    expect(store.participants(older).map(person => person.user_id)).toEqual(["66", "55"]);
    expect(store.transcriptOf(merged).map(row => row.message_id)).toEqual([entry]);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT anchor_message_id FROM followups").all()).toEqual([{ anchor_message_id: older }]);
      expect(db.query("SELECT outcome,merged_into FROM conversations WHERE anchor_message_id=?").get(newer))
        .toEqual({ outcome: "duplicate", merged_into: older });
    } finally { db.close(); }
  });
});

test("a topic shows each place only what its audience may see", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0), staff = idAt(T0, 1), dm = idAt(T0, 2);
    const row = store.open(normal, "66", anchor, "Queue stuck", T0);
    store.claim(normal, "66", said(anchor, "66"), T0, here);
    store.join(anchor, "66", "answered", other, staff, T0);
    store.claim(other, "66", said(staff, "66", other, anchor), T0 + 1, { channel: other, audience: "staff" });
    store.claim("dm1", "66", said(dm, "66", "dm1", anchor), T0 + 2, { channel: "dm1", audience: "dm" });
    const seen = (viewer: Parameters<typeof store.transcriptOf>[1]) => store.transcriptOf(row, viewer).map(entry => entry.message_id);
    expect(seen(here)).toEqual([anchor]);
    expect(seen({ channel: other, audience: "staff" })).toEqual([anchor, staff]);
    expect(seen({ channel: "dm1", audience: "dm" })).toEqual([anchor, staff, dm]);
    expect(seen({ channel: "dm2", audience: "dm" })).toEqual([anchor, staff]);
  });
});

const guard = (delivery: Parameters<typeof guardedReply>[0]["delivery"], store: Parameters<typeof guardedReply>[0]["store"], path: string,
  target: string, channel: string, meaning: { disposition: "final" | "progress" | "question"; waiting_on?: string },
  send: () => Promise<string> = async () => "900") => guardedReply({
  delivery, store, rest: fakeRest({ [target]: String(JSON.parse(delivery.pending("inbound").find(item => item.id === target)!.payload).content) }).rest, channel, target, covers: [], seen: [], text: "reply",
  send, cleanup: async () => {}, now: () => T0 + 1000, warn: () => {},
  settlement: { path: join(dirname(path), "reply-sends.sqlite"), event: `${meaning.disposition}:${target}`, meaning },
});

test("a question answered in another channel waits on that person there", async () => {
  await withStores(async (delivery, store, path) => {
    const anchor = idAt(T0), far = idAt(T0, 1), asked = idAt(T0, 2);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "77", "answered", other, far, T0);
    // An unthreaded continuation by a participant in the channel where they last spoke.
    stage(delivery, asked, { author_id: "77", channel_id: other, content: "still stuck for me" });
    expect((await guard(delivery, store, path, asked, other, { disposition: "question", waiting_on: "Which queue?" })).code).toBe(0);
    const row = store.topic(anchor)!;
    expect([row.waiting_on_user, row.question_channel_id, row.question_message_id]).toEqual(["77", other, asked]);
    expect([store.awaitingAnswer(other, "77"), store.awaitingAnswer(normal, "66")]).toEqual([true, false]);
  });
});

test("a failed send adds nobody and records nothing", async () => {
  await withStores(async (delivery, store, path) => {
    const anchor = idAt(T0), newcomer = idAt(T0, 1);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    stage(delivery, newcomer, { author_id: "77", reply_to: anchor, content: "same here" });
    await expect(guard(delivery, store, path, newcomer, normal, { disposition: "progress" },
      async () => { throw new Error("Discord rejected the reply"); })).rejects.toThrow("rejected");
    expect(store.participants(anchor).map(person => person.user_id)).toEqual(["66"]);
    expect(store.belongs(store.topic(anchor)!, newcomer)).toBe(false);
  });
});

test("linking an issue in a reply merges into the older topic that already tracks it", async () => {
  await withStores(async (_delivery, store) => {
    const older = idAt(T0), newer = idAt(T0, 1), issue = "https://github.com/o/r/issues/2";
    store.applyReply(store.open(normal, "66", older, "Queue stuck", T0), { disposition: "progress", issue }, T0 + 1);
    store.applyReply(store.open(other, "55", newer, "Queue broken", T0 + 2), { disposition: "progress", issue }, T0 + 3);
    expect(store.topic(newer)?.anchor_message_id).toBe(older);
    expect(store.participants(older).map(person => person.user_id)).toEqual(["66", "55"]);
  });
});

test("the lead's turn carries topic identity, people, places and readable answers", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0), far = idAt(T0, 1);
    const row = store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "77", "answered", other, far, T0);
    for (let i = 0; i < 6; i++) {
      store.append(normal, "66", { message_id: idAt(T0, 10 + i), author_id: "1199770187738644999", author: "Helio", bot: true,
        content: `Answer ${i}: restart the queue worker and check the match log.`, attachment_count: 0, reply_to: anchor,
        sent_at: new Date(T0).toISOString() }, T0, here);
    }
    // 77 pings from the other channel without a reply: the topic is offered as one of theirs.
    const elsewhere = conversationSnapshot(store, "999", "77", T0 + 1, { pinged: true }, { channel: "999", audience: "public" })!;
    const rendered = turnOf(renderTurn([{ message_id: idAt(T0, 30), channel_id: "999", author_id: "77", author: "other",
      content: "any news?", channel_policy: "normal", conversation: elsewhere }])).conversation;
    expect(rendered.other_topics.map((topic: { topic_id: string }) => topic.topic_id)).toEqual([anchor]);
    const own = conversationSnapshot(store, normal, "66", T0 + 1, { pinged: true }, here)!;
    const turn = turnOf(renderTurn([{ message_id: idAt(T0, 31), channel_id: normal, author_id: "66", author: "staff",
      content: "and now?", channel_policy: "normal", conversation: own }])).conversation;
    expect([turn.topic_id, turn.participants, turn.places]).toEqual([anchor, ["66", "77"], [normal, other]]);
    expect(turn.transcript.every((entry: { content: string }) => entry.content.startsWith("Answer"))).toBe(true);
    expect(row.anchor_message_id).toBe(anchor);
  });
});

test("a Discord link or issue link names an existing topic; a reply into a resolved one stays readable", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0), closed = idAt(T0, 1);
    store.setState(normal, "66", { issue: "https://github.com/o/r/issues/2" }, store.open(normal, "66", anchor, "Queue stuck", T0).anchor_message_id, T0);
    store.close(other, "55", "answered", T0 + 2, undefined, store.open(other, "55", closed, "Roles", T0 + 1).anchor_message_id);
    const snap = (content: string, reply_to?: string): Record<string, unknown> | undefined => conversationSnapshot(store, "999", "77", T0 + 3,
      { pinged: true, content, ...(reply_to ? { reply_to } : {}) }, { channel: "999", audience: "public" });
    expect([snap(`see https://discord.com/channels/300/${normal}/${anchor}`)?.topic_id, snap("x")?.topic_id]).toEqual([anchor, undefined]);
    expect(snap("any update on https://github.com/o/r/issues/2")).toMatchObject({ topic_id: anchor, topic_binding: "candidate" });
    expect(snap("thanks", closed)).toMatchObject({ topic_id: closed, state: "resolved", topic_binding: "explicit" });
  });
});

test("closing-note groups are fixed when first computed, so a retry never posts to a newer message", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0), far = idAt(T0, 1), later = idAt(T0, 2);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "55", "answered", other, far, T0);
    const first = store.closureGroups(anchor, normal);
    store.join(anchor, "55", "answered", other, later, T0 + 1);
    expect(store.closureGroups(anchor, normal)).toEqual(first);
    expect(first).toEqual([{ channel: other, target: far, users: ["55"] }]);
    store.leave(anchor, "55");
    expect(store.closureGroups(anchor, normal)).toEqual([{ channel: other, target: far, users: [] }]);
  });
});

test("a closing note Discord refused is sent once permission returns", async () => {
  await withStores(async (_delivery, store, path) => {
    const anchor = idAt(T0), far = idAt(T0, 1);
    const row = store.open(normal, "66", anchor, "Queue stuck", T0);
    let refuse = true, posts = 0;
    const rest: Rest = async <T>(route: string, init?: Parameters<Rest>[1]) => {
      if (route === `/channels/${other}`) return { id: other, type: 0, guild_id: "300" } as T;
      if (route.endsWith(`/messages/${far}`)) return { id: far, author: { id: "55" } } as T;
      if (init?.method === "POST") {
        posts++;
        if (refuse) throw new DiscordRestError(403, "POST", route, "missing permission");
        return { id: "9901" } as T;
      }
      if (route.includes("/messages?")) return [] as T;
      throw new Error(`Unexpected ${route}`);
    };
    const send = () => closureNotes({ state: dirname(path), rest, row, groups: [{ channel: other, target: far, users: ["55"] }],
      config: () => filterConfig({ DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: other, DORI_DISCORD_NORMAL_CHANNELS: other }),
      now: () => T0 + 1000 });
    await expect(send()).rejects.toThrow("missing permission");
    refuse = false;
    expect(await send()).toEqual([`REPLY_CLOSURE_SENT topic=${anchor} channel=${other} message=9901`]);
    expect(await send()).toEqual([`REPLY_CLOSURE_SENT topic=${anchor} channel=${other} message=9901`]);
    expect(posts).toBe(2);
  });
});
