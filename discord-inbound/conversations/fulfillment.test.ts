import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Conversations } from "./conversations.ts";
import { ReplySettlements } from "./reply-settlement.ts";
import { Delivery } from "../delivery/delivery.ts";

const now = Date.parse("2026-11-06T12:00:00Z");
const human = (id: string, replyTo?: string) => ({
  message_id: id, author_id: "99", author: "owner", bot: false,
  content: "request", attachment_count: 0, sent_at: new Date(now).toISOString(),
  ...(replyTo ? { reply_to: replyTo } : {}),
});

test("explicit unknown and resolved replies never fall into another active topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-topic-routing-"));
  const store = new Conversations(join(dir, "conversations.sqlite"));
  try {
    store.open("100", "99", "10", "first", now);
    store.claim("100", "99", human("11", "10"), now);
    store.close("100", "99", "answered", now + 1, undefined, "10");
    const second = store.open("100", "99", "20", "second", now + 2);
    expect(store.forReply("100", "99", "11")).toBeNull();
    expect(store.forReply("100", "99", "999")).toBeNull();
    expect(store.forReply("100", "99")?.anchor_message_id).toBe(second.anchor_message_id);
    store.open("100", "99", "30", "third", now + 3);
    expect(store.forReply("100", "99")).toBeNull();
    expect(store.forReply("100", "99", "20")?.anchor_message_id).toBe("20");
  } finally { store.dispose(); await rm(dir, { recursive: true }); }
});

test("durable final settlement survives restart without erasing a newer claimed message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-topic-final-"));
  const store = new Conversations(join(dir, "conversations.sqlite"));
  const path = join(dir, "reply-sends.sqlite");
  try {
    const first = store.open("100", "99", "10", "request", now);
    expect(store.state(first)).toBe("waiting_on_helio");
    const receipts = new ReplySettlements(path);
    const final = receipts.prepare("100:10:completion", [first], { disposition: "final", job: "issue-8" });
    store.claim("100", "99", human("11", "10"), now + 1);
    receipts.delivered(final.key);
    receipts.close();
    const reopened = new ReplySettlements(path);
    expect(reopened.settle(final.key, store, now + 2)).toEqual(["newer-input"]);
    expect(store.get("100", "99", "10")?.status).toBe("open");
    const current = store.get("100", "99", "10")!;
    const next = reopened.prepare("100:11:completion", [current], { disposition: "final", job: "issue-8" });
    expect(reopened.settle(next.key, store, now + 3)).toEqual([]);
    expect(store.get("100", "99", "10")).not.toBeNull();
    reopened.delivered(next.key);
    expect(reopened.settle(next.key, store, now + 4)).toEqual(["applied"]);
    expect(store.byAnchor("100", "99", "10")).toMatchObject({ status: "resolved", outcome: "answered", job: "issue-8" });
    expect(reopened.settle(next.key, store, now + 5)).toEqual(["applied"]);
    reopened.close();
  } finally { store.dispose(); await rm(dir, { recursive: true }); }
});

test("only an explicit delivered question starts a requester clock; progress and legacy replies do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-topic-question-"));
  const store = new Conversations(join(dir, "conversations.sqlite"));
  try {
    let row = store.open("100", "99", "10", "question", now);
    store.append("100", "99", { ...human("11"), author_id: "88", bot: true }, now + 1);
    row = store.get("100", "99")!;
    expect(store.state(row)).toBe("waiting_on_helio");
    expect(store.applyReply(row, { disposition: "question", waiting_on: "Which server?" }, now + 2)).toBe("applied");
    row = store.get("100", "99")!;
    expect(store.state(row)).toBe("waiting_on_requester");
    expect(row.question_started_at).toBe(now + 2);
    store.claim("100", "99", human("12", "10"), now + 3);
    row = store.get("100", "99")!;
    expect(store.state(row)).toBe("waiting_on_helio");
    expect(row.question_started_at).toBeNull();
    expect(store.applyReply(row, { disposition: "progress" }, now + 4)).toBe("applied");
    expect(store.state(store.get("100", "99")!)).toBe("waiting_on_helio");
  } finally { store.dispose(); await rm(dir, { recursive: true }); }
});

test("queued unclaimed input protects the open topic before evidence preparation or claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-queued-final-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const receipts = new ReplySettlements(join(dir, "reply-sends.sqlite"));
  try {
    const row = store.open("100", "99", "10", "request", now);
    receipts.prepare("100:10:completion", [{ ...row, covered: ["10"] }], { disposition: "final" });
    queue.stage("inbound", "11", JSON.stringify({ channel_id: "100", author_id: "99",
      reply_to: "10", preparation_complete: false }));
    receipts.delivered("100:10:completion");
    expect(receipts.settle("100:10:completion", store, now + 1)).toEqual(["newer-input"]);
    expect(store.get("100", "99", "10")?.status).toBe("open");
    expect(queue.pending("inbound").map(row => row.id)).toEqual(["11"]);
    expect(store.working("11")).toBeNull();
    store.observeInput("100", "99", "11", now + 2, "10");
    const observed = store.get("100", "99", "10")!;
    store.observeInput("100", "99", "11", now + 3, "10");
    expect(store.get("100", "99", "10")?.revision).toBe(observed.revision);
    expect(store.state(observed)).toBe("waiting_on_helio");
  } finally { receipts.close(); queue.close(); store.dispose(); await rm(dir, { recursive: true }); }
});
