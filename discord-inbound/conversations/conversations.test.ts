import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations, DAY_MS } from "./conversations.ts";
import { describeMessage } from "../messages/reply-context.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const entry = (id: string, author = "99") => describeMessage({
  id, channel_id: "100", author: { id: author, username: author, bot: author === "88" },
  content: "private request", timestamp: new Date(NOW).toISOString(),
}, 12_000).entry;

async function withStore(run: (store: Conversations, db: Database) => void) {
  const dir = await mkdtemp(join(tmpdir(), "conversations-"));
  const path = join(dir, "discord-conversations.sqlite");
  const store = new Conversations(path, NOW);
  const db = new Database(path);
  try {
    run(store, db);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { store.dispose(); db.close(); await rm(dir, { recursive: true, force: true }); }
}

test("open limits include holds across channels, so a third topic is refused", async () => {
  await withStore((store) => {
    store.open("100", "99", "10", "first", NOW);
    store.open("101", "99", "11", "second", NOW);
    store.hold("101", "99", "waiting for owner");
    expect(() => store.open("100", "99", "12", "changed", NOW + 1)).toThrow("User already has 2 open conversations");
    expect(store.get("100", "99")?.topic).toBe("first");
    expect(() => store.open("102", "99", "12", "third", NOW + 1)).toThrow("2 open");
    expect(store.open("100", "77", "13", "other person", NOW + 1).status).toBe("open");
  });
});

test("only claims and Helio replies join the transcript and reset activity and derived state", async () => {
  await withStore((store) => {
    const opened = store.open("100", "99", "9", "question", NOW);
    store.append("100", "99", entry("10"), NOW + 1);
    expect(store.transcript("100", "99")).toEqual([]);
    expect(store.get("100", "99")?.last_activity).toBe(NOW);
    expect(store.state(opened)).toBe("waiting_on_helio");
    store.claim("100", "99", entry("11"), NOW + 2);
    const claimed = store.get("100", "99");
    if (!claimed) throw new Error("Conversation disappeared");
    expect([store.state(claimed), claimed.last_activity]).toEqual(["waiting_on_helio", NOW + 2]);
    store.claim("100", "99", entry("11"), NOW + 3);
    expect(store.get("100", "99")?.last_activity).toBe(NOW + 2);
    store.append("100", "99", entry("12", "88"), NOW + 4);
    const answered = store.get("100", "99");
    if (!answered) throw new Error("Conversation disappeared");
    expect([store.state(answered), answered.last_activity]).toEqual(["waiting_on_helio", NOW + 4]);
    expect(store.transcript("100", "99").map((row) => row.message_id)).toEqual(["11", "12"]);
  });
});

test("resolution removes transcript text and keeps summary, outcome, issue and unrelated tables", async () => {
  await withStore((store, db) => {
    db.exec("CREATE TABLE other_tool (value TEXT); INSERT INTO other_tool VALUES ('preserved')");
    store.open("100", "99", "9", "question", NOW);
    store.claim("100", "99", entry("10"), NOW);
    store.note("100", "99", "Confirmed queue failure");
    const closed = store.close("100", "99", "issue", NOW + 1000, "https://github.com/o/r/issues/3");
    expect([closed.status, closed.summary, closed.outcome, closed.issue])
      .toEqual(["resolved", "Confirmed queue failure", "issue", "https://github.com/o/r/issues/3"]);
    // Text goes at resolution; message IDs stay so a later reply still finds the topic.
    expect(db.query("SELECT message_id,entry FROM transcript").all()).toEqual([{ message_id: "10", entry: null }]);
    expect(db.query("SELECT * FROM other_tool").all()).toEqual([{ value: "preserved" }]);
    // Closing with an issue records it on the topic; only linking it (setState/applyReply) subscribes.
    expect(db.query("SELECT count(*) AS n FROM followups").get()).toEqual({ n: 0 });
  });
});

test("a claim supplies recent resolution context but only an explicit reopen restores the request", async () => {
  await withStore((store) => {
    store.open("100", "99", "9", "question", NOW);
    store.close("100", "99", "answered", NOW + 1);
    store.claim("100", "99", entry("10"), NOW + 2);
    expect(store.get("100", "99")).toBeNull();
    expect(store.recentlyResolved("100", "99", NOW + 2)?.summary).toBe("question");
    const reopened = store.reopen("100", "99", NOW + 3);
    expect([reopened.status, reopened.summary, reopened.outcome]).toEqual(["open", "question", null]);
    store.close("100", "99", "answered", NOW + 4);
    expect(() => store.reopen("100", "99", NOW + 4 + 7 * DAY_MS)).toThrow("7 days");
    expect(store.open("100", "99", "11", "new request", NOW + 4 + 7 * DAY_MS).topic).toBe("new request");
  });
});

test("administration reopens the selected topic rather than the person's most recent resolution", async () => {
  await withStore(store => {
    const first = store.open("100", "99", "9", "selected topic", NOW);
    store.close("100", "99", "answered", NOW + 1, undefined, "9");
    store.open("100", "99", "10", "newer topic", NOW + 2);
    store.close("100", "99", "answered", NOW + 3, undefined, "10");
    const selected = store.byAnchor("100", "99", "9");
    if (!selected) throw new Error("Selected topic disappeared");
    store.administer("reopen-selected", "77", selected, { kind: "reopen" }, NOW + 4);
    expect(store.get("100", "99")?.opened_at).toBe(first.opened_at);
    expect(store.byAnchor("100", "99", "10")?.status).toBe("resolved");
  });
});

test("a changed conversation rejects an old administration preview without erasing newer input", async () => {
  await withStore(store => {
    const preview = store.open("100", "99", "9", "question", NOW);
    store.claim("100", "99", entry("10"), NOW + 1);
    expect(() => store.administer("old-preview", "77", preview, { kind: "close", outcome: "answered" }, NOW + 2))
      .toThrow("Conversation changed");
    expect(store.transcript("100", "99").map(item => item.message_id)).toEqual(["10"]);
    expect(store.get("100", "99")?.status).toBe("open");
  });
});

test("replayed administration returns its receipt and cannot repeat a state change", async () => {
  await withStore(store => {
    const row = store.open("100", "99", "9", "question", NOW);
    const held = store.administer("hold-once", "77", row, { kind: "hold", reason: "Beta dependency" }, NOW + 1);
    const repeat = store.administer("hold-once", "77", row, { kind: "hold", reason: "Beta dependency" }, NOW + 2);
    expect(repeat.revision).toBe(held.revision);
    expect(store.get("100", "99")?.revision).toBe(held.revision);
    expect(() => store.administer("hold-once", "77", row, { kind: "close", outcome: "answered" }, NOW + 3))
      .toThrow("already used");
  });
});

test("resolved rows archive at seven days and are deleted thirty days after resolving, even when upkeep was absent", async () => {
  await withStore((store) => {
    store.open("100", "99", "9", "retention", NOW);
    store.close("100", "99", "answered", NOW);
    store.retain(NOW + 7 * DAY_MS - 1);
    expect(store.latest("100", "99")?.status).toBe("resolved");
    store.retain(NOW + 7 * DAY_MS);
    expect([store.latest("100", "99")?.status, store.latest("100", "99")?.archived_at])
      .toEqual(["archived", NOW + 7 * DAY_MS]);
    store.retain(NOW + 30 * DAY_MS - 1);
    expect(store.latest("100", "99")?.status).toBe("archived");
    store.retain(NOW + 30 * DAY_MS);
    expect(store.latest("100", "99")).toBeNull();
  });
});

test("holds have a reason and resume preserves the time of the last real activity", async () => {
  await withStore((store) => {
    store.open("100", "99", "9", "hold", NOW);
    store.hold("100", "99", "beta test");
    const held = store.get("100", "99");
    if (!held) throw new Error("Missing hold");
    expect([store.state(held), held.hold_reason]).toEqual(["on_hold", "beta test"]);
    store.claim("100", "99", entry("10"), NOW + 5 * DAY_MS);
    expect([store.get("100", "99")?.status, store.get("100", "99")?.hold_reason]).toEqual(["on_hold", "beta test"]);
    store.resume("100", "99");
    expect([store.get("100", "99")?.status, store.get("100", "99")?.hold_reason]).toEqual(["open", null]);
    store.hold("100", "99", "owner decision");
    store.resume("100", "99");
    expect(store.get("100", "99")?.last_activity).toBe(NOW + 5 * DAY_MS);
  });
});
