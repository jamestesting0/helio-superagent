import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterConfig } from "../intake/authorization.ts";
import { classify, type IncomingMessage } from "../intake/filter.ts";
import { Conversations } from "./conversations.ts";
import { conversationSnapshot } from "./conversation-context.ts";

const BOT = "880000000000000001";
const STAFF = "660000000000000001";
const NORMAL = "1199770187738644652";
const AT = Date.parse("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "helio-understanding-"));
  const conversations = new Conversations(join(dir, "c.sqlite"), AT);
  return { conversations, done: async () => { conversations.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

const config = (recentlyTalked: (channel: string, user: string) => boolean) => {
  const cfg = filterConfig({ DORI_DISCORD_OWNER_ID: "1", DORI_DISCORD_ALLOWED: NORMAL, DORI_DISCORD_NORMAL_CHANNELS: NORMAL },
    undefined, undefined, undefined, recentlyTalked);
  cfg.botId = BOT;
  return cfg;
};
const unpinged = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: "1300000000000000001", type: 0, channel_id: NORMAL, guild_id: "900", author: { id: STAFF, username: "staff" },
  content: "that fixed it, thanks", timestamp: new Date(AT).toISOString(), mentions: [], ...over,
});
const replyToHelio = { message_reference: { message_id: "1290000000000000001" }, referenced_message: { author: { id: BOT } } };

test("an unpinged reply to Helio from someone it talked with this week reaches Helio for review", async () => {
  const admitted = await classify(unpinged(replyToHelio), config(() => true), async () => undefined);
  expect([admitted?.role, admitted?.attention]).toEqual(["STAFF_QUESTION", "review"]);
  expect(await classify(unpinged(replyToHelio), config(() => false), async () => undefined)).toBeNull();
  expect(await classify(unpinged(), config(() => true), async () => undefined)).toBeNull();
});

test("structured conversation state is shown first and survives beyond the transcript window", async () => {
  const s = await store();
  try {
    s.conversations.open(NORMAL, STAFF, "1", "base registration", AT);
    s.conversations.setState(NORMAL, STAFF, { request: "Register their base in season 4", decided: "Use the EU server, not NA" });
    for (let i = 0; i < 10; i++) {
      s.conversations.append(NORMAL, STAFF, { message_id: String(100 + i), author_id: BOT, author: "Helio", bot: true,
        sent_at: new Date(AT + i).toISOString(), content: `step ${i}`, attachment_count: 0 }, AT + i);
    }
    const snapshot = conversationSnapshot(s.conversations, NORMAL, STAFF, AT + DAY);
    expect(snapshot && "decided" in snapshot ? snapshot.decided : undefined).toBe("Use the EU server, not NA");
    expect(() => s.conversations.setState(NORMAL, STAFF, { request: "x".repeat(301) })).toThrow("300");
  } finally { await s.done(); }
});

test("a message is marked as a reply into the open conversation or a fresh ping that may be a new topic", async () => {
  const s = await store();
  try {
    s.conversations.open(NORMAL, STAFF, "500", "logs", AT);
    const reply = conversationSnapshot(s.conversations, NORMAL, STAFF, AT, { reply_to: "500", pinged: true });
    const fresh = conversationSnapshot(s.conversations, NORMAL, STAFF, AT, { pinged: true });
    const followup = conversationSnapshot(s.conversations, NORMAL, STAFF, AT, {});
    const relation = (snapshot: ReturnType<typeof conversationSnapshot>) => snapshot && "relation" in snapshot ? snapshot.relation : undefined;
    expect([relation(reply), relation(fresh), relation(followup)]).toEqual(["reply", "new_ping", "follow_up"]);
  } finally { await s.done(); }
});

const said = (id: string, author: string, replyTo?: string) => ({ message_id: id, author_id: author, author: author === BOT ? "Helio" : "staff",
  bot: author === BOT, sent_at: new Date(AT).toISOString(), content: `message ${id}`, attachment_count: 0, ...(replyTo ? { reply_to: replyTo } : {}) });

test("two topics from one person stay separate, and a reply goes to the topic it answers", async () => {
  const s = await store();
  try {
    s.conversations.open(NORMAL, STAFF, "500", "logs", AT);
    s.conversations.open(NORMAL, STAFF, "600", "roles", AT + 1);
    s.conversations.claim(NORMAL, STAFF, said("501", STAFF, "500"), AT + 2);
    s.conversations.claim(NORMAL, STAFF, said("601", STAFF, "600"), AT + 3);
    s.conversations.append(NORMAL, STAFF, said("502", BOT, "501"), AT + 4);
    const topic = (replyTo?: string) => conversationSnapshot(s.conversations, NORMAL, STAFF, AT + 5, { reply_to: replyTo, pinged: true });
    const logs = topic("502"), fresh = topic(undefined);
    expect(logs?.read_more).toBe(`helio conversation show ${NORMAL} ${STAFF} --topic 500`);
    expect(logs && "topic" in logs ? [logs.topic, logs.relation, logs.transcript.map((e) => e.message_id)] : [])
      .toEqual(["logs", "reply", ["501", "502"]]);
    expect(fresh).toBeUndefined();
    s.conversations.setState(NORMAL, STAFF, { request: "Fix role sync" }, "600");
    const roles = topic("601");
    expect(roles && "topic" in roles ? [roles.topic, roles.request, roles.transcript.map((e) => e.message_id)] : [])
      .toEqual(["roles", "Fix role sync", ["601"]]);
  } finally { await s.done(); }
});

test("who owes the next reply follows the structured state, and a new message from the requester always needs reading", async () => {
  const s = await store();
  try {
    s.conversations.open(NORMAL, STAFF, "500", "logs", AT);
    const state = () => s.conversations.state(s.conversations.get(NORMAL, STAFF)!);
    s.conversations.setState(NORMAL, STAFF, { request: "Find why sync fails" });
    s.conversations.append(NORMAL, STAFF, said("502", BOT), AT + 1);
    expect(state()).toBe("waiting_on_helio");
    s.conversations.setState(NORMAL, STAFF, { waiting_on: "Send the error log" });
    expect(state()).toBe("waiting_on_helio");
    s.conversations.applyReply(s.conversations.get(NORMAL, STAFF)!, {
      disposition: "question", waiting_on: "Send the error log",
    }, AT + 1);
    expect(state()).toBe("waiting_on_requester");
    s.conversations.claim(NORMAL, STAFF, said("503", STAFF, "502"), AT + 2);
    expect(state()).toBe("waiting_on_helio");
  } finally { await s.done(); }
});
