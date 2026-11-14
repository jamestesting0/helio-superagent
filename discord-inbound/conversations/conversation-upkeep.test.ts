import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversations, DAY_MS } from "./conversations.ts";
import { sweepConversations } from "./conversation-upkeep.ts";
import { describeMessage } from "../messages/reply-context.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const entry = (author: string, id: string) => describeMessage({
  id, channel_id: "100", author: { id: author, username: author, bot: author === "88" }, content: "details",
  timestamp: new Date(NOW).toISOString(),
}, 12_000).entry;

async function scenario(run: (store: Conversations, sweep: (now: number) => Promise<void>, lines: string[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "conversation-upkeep-"));
  const store = new Conversations(join(dir, "db.sqlite"), NOW);
  const lines: string[] = [];
  const sweep = (now: number) => sweepConversations({ store, now, emit: (line) => lines.push(line) });
  try { await run(store, sweep, lines); }
  finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
}

test("an unanswered question is never chased and stays open until the timeout", async () => {
  await scenario(async (store, sweep, lines) => {
    store.open("100", "99", "10", "request", NOW);
    store.claim("100", "99", entry("99", "11"), NOW);
    store.applyReply(store.get("100", "99")!, { disposition: "question", waiting_on: "Which error?" }, NOW);
    await sweep(NOW + DAY_MS);
    await sweep(NOW + 2 * DAY_MS);
    expect(store.get("100", "99")?.status).toBe("open");
    expect(lines).toEqual([]);
  });
});

test.each(["waiting_on_requester", "waiting_on_helio", "on_hold"])("seventy-two hour closure only applies while waiting on requester (%s)", async (state) => {
  await scenario(async (store, sweep, lines) => {
    const row = store.open("100", "99", "10", "request", NOW);
    if (state === "waiting_on_requester") store.applyReply(row, { disposition: "question", waiting_on: "Which error?" }, NOW);
    if (state === "waiting_on_helio") store.claim("100", "99", entry("99", "11"), NOW);
    if (state === "on_hold") store.hold("100", "99", "beta test");
    await sweep(NOW + 3 * DAY_MS);
    if (state === "waiting_on_requester") {
      expect([store.latest("100", "99")?.status, store.latest("100", "99")?.outcome]).toEqual(["resolved", "timed_out"]);
      expect(lines).toEqual([]);
    } else {
      expect(store.get("100", "99")?.status).toBe(state === "on_hold" ? "on_hold" : "open");
    }
  });
});

test("a question settled late (recovery) times out 72 hours after Discord showed it", async () => {
  // Gate review 2026-11-13: the requester clock started at settlement time, keeping a 09:00 question open past its deadline.
  await scenario(async (store, sweep) => {
    store.open("100", "99", "10", "request", NOW);
    store.applyReply(store.get("100", "99")!, { disposition: "question", waiting_on: "Which error?" }, NOW + 3_600_000, undefined, NOW);
    expect(store.get("100", "99")?.question_started_at).toBe(NOW);
    await sweep(NOW + 3 * DAY_MS);
    expect([store.latest("100", "99")?.status, store.latest("100", "99")?.outcome]).toEqual(["resolved", "timed_out"]);
  });
});

test("waiting on Helio is listed once per UTC day and remains open after long silence", async () => {
  await scenario(async (store, sweep, lines) => {
    store.open("100", "99", "10", "request", NOW);
    store.claim("100", "99", entry("99", "11"), NOW);
    await sweep(NOW + DAY_MS);
    await sweep(NOW + DAY_MS + 1000);
    await sweep(NOW + 2 * DAY_MS);
    expect(lines.filter((line) => line.startsWith("INBOUND_CONVERSATION_WAITING "))).toHaveLength(2);
    expect(store.get("100", "99")?.status).toBe("open");
  });
});
