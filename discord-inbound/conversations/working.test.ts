import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Conversations } from "./conversations.ts";
import { Delivery } from "../delivery/delivery.ts";
import { describeMessage } from "../messages/reply-context.ts";
import { guardedReply } from "./reply-guard.ts";
import { normal, T0, MIN, idAt, eyesPath, withStores, stage, fakeRest, reply } from "../fixtures/working.ts";

test("a follow-up whose request message is gone is closed once, not re-announced after every restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-followup-gone-"));
  const path = join(dir, "discord-conversations.sqlite");
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  const store = new Conversations(path);
  // The table exactly as scripts/helio-followups.py creates it in this same database.
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS followups (
    repo TEXT NOT NULL, issue INTEGER NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    reply_to TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'announced', 'done')),
    PRIMARY KEY (repo, issue, user_id))`);
  const anchor = idAt(T0), other = idAt(T0, 1);
  db.run("INSERT INTO followups VALUES ('o/r', 3, '66', ?, ?, 'feature', 0, 'announced')", [normal, anchor]);
  db.run("INSERT INTO followups VALUES ('o/r', 4, '67', ?, ?, 'bug', 0, 'open')", [normal, other]);
  const status = (issue: number) => (db.query("SELECT status FROM followups WHERE issue=?").get(issue) as { status: string }).status;
  try {
    const { rest } = fakeRest({ [anchor]: null, [other]: "still here" });
    const first = await reply(delivery, store, rest, anchor, T0).result;
    expect(first.code).toBe(4);
    expect(first.lines).toEqual([expect.stringMatching(/^REPLY_FOLLOWUP_CLOSED issue=3 user=66: /)]);
    expect([status(3), status(4)]).toEqual(["done", "open"]);
    expect((await reply(delivery, store, rest, anchor, T0).result).lines[0]).toStartWith("REPLY_SKIPPED");
  } finally {
    db.close(); delivery.close(); store.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deleted original with no follow-up table keeps the plain skip", async () => {
  await withStores(async (delivery, store) => {
    const gone = idAt(T0);
    const { rest } = fakeRest({ [gone]: null });
    const result = await reply(delivery, store, rest, gone, T0).result;
    expect([result.code, result.lines[0]?.startsWith("REPLY_SKIPPED")]).toEqual([4, true]);
  });
});

test("a clean reply is sent, closes the window and removes the 👀", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0);
    stage(delivery, anchor);
    store.openWorking(normal, "66", anchor, T0);
    store.claimWorking(normal, "66", anchor, T0);
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
    store.claimWorking(normal, "66", anchor, T0);
    store.setReacted(anchor, true);
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
    store.ensureWorking(normal, "66", anchor);
    store.claimWorking(normal, "66", anchor, T0);
    store.setReacted(anchor, true);
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

test("a reply sent without any 👀 shown says so, so the skipped first step is visible", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0);
    stage(delivery, anchor);
    const { rest } = fakeRest({ [anchor]: "help" });
    const { result } = reply(delivery, store, rest, anchor, T0 + 10_000);
    expect((await result).lines).toEqual(["SENT 900", "REPLY_NOTE no claim was recorded for this turn; run ack working first when you pick a turn up"]);
  });
});

test("a reply naming an issue links the conversation, and later discussion keeps the issue due until reviewed", async () => {
  await withStores(async (delivery, store, path) => {
    const reviews = join(dirname(path), "issue-sync.sqlite");
    const url = "https://github.com/o/r/issues/8";
    const due = `ISSUE_REVIEW_DUE issue=${url} read="helio issue show 8"`;
    const first = idAt(T0 - MIN), second = idAt(T0), third = idAt(T0, 1);
    const { rest } = fakeRest({ [first]: "help", [second]: "help", [third]: "help" });
    const send = (target: string, text: string) => guardedReply({
      delivery, store, rest, channel: normal, target, covers: [], seen: [], send: async () => "900",
      cleanup: async () => {}, now: () => T0, warn: () => {}, issues: { text, path: reviews },
    });
    const reviewed = (seconds: number) => {
      const db = new Database(reviews);
      try { db.query("UPDATE reviews SET reviewed_at=?").run(seconds); } finally { db.close(); }
    };
    stage(delivery, first);
    store.open(normal, "66", first, "season rules", T0 - MIN);
    expect((await send(first, `Noted for <${url}>.`)).lines).toContain(due);
    expect(store.get(normal, "66")?.issue).toBe(url);
    reviewed(Math.floor((T0 - MIN / 2) / 1000));
    stage(delivery, second);
    expect((await send(second, "Thanks, confirmed.")).lines).toContain(due);
    reviewed(Math.floor(T0 / 1000) + 1);
    stage(delivery, third);
    expect((await send(third, "Thanks.")).lines).not.toContain(due);
  });
});

test("a reply records Helio's response in each covered conversation before gateway delivery", async () => {
  await withStores(async (delivery, store) => {
    const anchor = idAt(T0), covered = idAt(T0 + 1000);
    stage(delivery, anchor);
    stage(delivery, covered, { author_id: "67" });
    for (const [user, id] of [["66", anchor], ["67", covered]]) {
      if (!user || !id) throw new Error("Missing fixture identity");
      store.open(normal, user, id, "request", T0);
      store.claim(normal, user, describeMessage({
        id, channel_id: normal, author: { id: user, username: user }, content: "help",
        timestamp: new Date(T0).toISOString(),
      }, 1000).entry, T0);
    }
    const { rest } = fakeRest({ [anchor]: "help" });
    const result = await guardedReply({
      delivery, store, rest, channel: normal, target: anchor, covers: [covered], seen: [],
      send: async () => "900", cleanup: async () => {}, now: () => T0 + 2000, warn: () => {},
      replyEntry: { author_id: "88", author: "Helio", bot: true, content: "answer", attachment_count: 0 },
    });
    expect(result.code).toBe(0);
    expect(["66", "67"].map((user) => store.transcript(normal, user).at(-1)?.author_id)).toEqual(["88", "88"]);
    expect(store.list().map((row) => store.state(row))).toEqual(["waiting_on_requester", "waiting_on_requester"]);
  });
});
