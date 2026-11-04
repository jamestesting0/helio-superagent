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
  id, channel_id: "100", author: { id: author, username: author }, content: "details",
  timestamp: new Date(NOW).toISOString(),
}, 12_000).entry;

async function scenario(run: (store: Conversations, sweep: (now: number) => Promise<void>, lines: string[], posts: string[]) => Promise<void>,
  missing = false) {
  const dir = await mkdtemp(join(tmpdir(), "conversation-upkeep-"));
  const store = new Conversations(join(dir, "db.sqlite"), NOW);
  const lines: string[] = [], posts: string[] = [];
  const rest: Rest = async (path, init) => {
    if (missing && /\/messages\/10$/.test(path)) throw new DiscordRestError(404, "GET", path, "gone");
    if (init?.method === "POST") posts.push(JSON.stringify(init.body));
    return JSON.parse(`{"id":"${900 + posts.length}","guild_id":"300"}`);
  };
  const sweep = (now: number) => sweepConversations({ store, rest, now,
    emit: (line) => lines.push(line), canContact: async () => true });
  try { await run(store, sweep, lines, posts); }
  finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
}

test("one nudge at twenty-four hours resets after a claimed response and housekeeping never enters the transcript", async () => {
  await scenario(async (store, sweep, lines, posts) => {
    store.open("100", "99", "10", "request", NOW);
    store.claim("100", "99", entry("99", "11"), NOW);
    store.append("100", "99", entry("88", "12"), NOW);
    await sweep(NOW + DAY_MS - 1);
    expect(posts).toEqual([]);
    await sweep(NOW + DAY_MS);
    await sweep(NOW + DAY_MS + 1);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0] ?? "{}").message_reference.message_id).toBe("11");
    expect(store.isNotice("901")).toBe(true);
    expect(store.transcript("100", "99").map((row) => row.message_id)).toEqual(["11", "12"]);
    store.claim("100", "99", entry("99", "13"), NOW + DAY_MS + 2);
    expect(store.get("100", "99")?.nudged_at).toBeNull();
    store.append("100", "99", entry("88", "14"), NOW + DAY_MS + 3);
    await sweep(NOW + 2 * DAY_MS + 3);
    expect(posts).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("INBOUND_CONVERSATION_NUDGE "))).toHaveLength(2);
  });
});

test.each(["waiting_on_requester", "waiting_on_helio", "on_hold"])("seventy-two hour closure only applies while waiting on requester (%s)", async (state) => {
  await scenario(async (store, sweep, lines, posts) => {
    store.open("100", "99", "10", "request", NOW);
    if (state === "waiting_on_helio") store.claim("100", "99", entry("99", "11"), NOW);
    if (state === "on_hold") store.hold("100", "99", "beta test");
    await sweep(NOW + 3 * DAY_MS);
    if (state === "waiting_on_requester") {
      expect([store.latest("100", "99")?.status, store.latest("100", "99")?.outcome]).toEqual(["resolved", "timed_out"]);
      expect(posts).toHaveLength(1);
      expect(lines[0]).toStartWith("INBOUND_CONVERSATION_TIMEOUT ");
    } else {
      expect(store.get("100", "99")?.status).toBe(state === "on_hold" ? "on_hold" : "open");
      expect(posts).toEqual([]);
    }
  });
});

test("a missing anchor resolves silently with other and sends no courtesy messages", async () => {
  await scenario(async (store, sweep, lines, posts) => {
    store.open("100", "99", "10", "request", NOW);
    await sweep(NOW + DAY_MS);
    expect(store.latest("100", "99")?.outcome).toBe("other");
    expect([lines, posts]).toEqual([[], []]);
  }, true);
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
