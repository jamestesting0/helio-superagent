import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { describeMessage } from "../messages/reply-context.ts";
import { fakeRest, idAt, normal, other, stage, T0, withStores } from "../fixtures/working.ts";
import { guardedReply } from "./reply-guard.ts";
import type { Conversation } from "./conversations.ts";

const said = (id: string, author: string, channel = normal, reply_to?: string) => describeMessage({
  id, channel_id: channel, author: { id: author, username: author }, content: "details", timestamp: new Date(T0).toISOString(),
  ...(reply_to ? { message_reference: { message_id: reply_to } } : {}),
}, 12_000).entry;
const here = { channel: normal, audience: "public" } as const;

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
