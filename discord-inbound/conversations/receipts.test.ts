import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { filterConfig } from "../intake/authorization.ts";
import { classify, type IncomingMessage } from "../intake/filter.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { finishWorking, reactOnArrival, showWorking, sweepWorking, syncReceipts } from "./working.ts";
import { normal, other, T0, MIN, idAt, withStores, stage } from "../fixtures/working.ts";

function wire(status = 204) {
  const calls: string[] = [];
  const rest: Rest = async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (status !== 204) throw new DiscordRestError(status, init?.method ?? "GET", path, "refused");
    return JSON.parse("null");
  };
  return { rest, calls };
}
const message = (id: string) => ({
  message_id: id, channel_id: normal, author_id: "66", role: "STAFF_QUESTION", scope: "answer-only",
});

test.each([403, 429, 500])("claims persist when adding a receipt fails with %s and only 403 is silent", async (status) => {
  await withStores(async (_delivery, store) => {
    const id = idAt(T0);
    const { rest, calls } = wire(status);
    const warnings: string[] = [];
    const result = await showWorking({ store, rest, now: T0, warn: (line) => warnings.push(line) }, message(id));
    expect(store.working(id)?.claimed_at).toBe(T0);
    expect([result, calls.length, warnings.length]).toEqual([status === 403 ? "forbidden" : "failed", 1, status === 403 ? 0 : 1]);
  });
});

test("ack working claims once, shows a receipt and refuses finished claims", async () => {
  await withStores(async (_delivery, store) => {
    const id = idAt(T0);
    const { rest, calls } = wire();
    const o = { store, rest, now: T0, warn: () => {} };
    expect(await showWorking(o, message(id))).toBe("added");
    expect(await showWorking({ ...o, now: T0 + MIN }, message(id))).toBe("already");
    expect(store.working(id)?.claimed_at).toBe(T0);
    await finishWorking({ ...o, now: T0 + 2 * MIN }, [id]);
    expect(await showWorking(o, message(id))).toBe("skipped-already-replied");
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["PUT", "DELETE"]);
  });
});

test("pings admit only later messages by that person in that channel within thirty minutes", async () => {
  await withStores(async (_delivery, store) => {
    const anchor = idAt(T0);
    store.openWorking(normal, "66", anchor, T0);
    const later = idAt(T0 + MIN);
    expect(store.workingAnchor(normal, "66", later)).toBe(anchor);
    expect(store.workingAnchor(normal, "67", later)).toBeUndefined();
    expect(store.workingAnchor(other, "66", later)).toBeUndefined();
    expect(store.workingAnchor(normal, "66", idAt(T0 - 1000))).toBeUndefined();
    expect(store.workingAnchor(normal, "66", idAt(T0 + 31 * MIN))).toBeUndefined();
    expect(store.openWorking(normal, "66", idAt(T0 + 5000), T0 + 5000).message_id).toBe(anchor);
    store.closeWorking([anchor], T0 + 2 * MIN);
    expect(store.workingAnchor(normal, "66", idAt(T0 + 3 * MIN))).toBeUndefined();
    expect(store.workingAnchor(normal, "66", later)).toBe(anchor);
  });
});

test("unclaimed messages and reply guard rows never anchor additions, while a claim starts at decision time", async () => {
  await withStores(async (_delivery, store) => {
    const id = idAt(T0);
    store.ensureWorking(normal, "66", id);
    store.holdReply(normal, "66", id, T0);
    expect(store.workingAnchor(normal, "66", idAt(T0 + MIN))).toBeUndefined();
    store.claimWorking(normal, "66", id, T0 + 2 * MIN);
    expect(store.workingAnchor(normal, "66", idAt(T0 + MIN))).toBeUndefined();
    expect(store.workingAnchor(normal, "66", idAt(T0 + 3 * MIN))).toBe(id);
  });
});

test("a normal-chat addition is admitted for review and names its ping anchor", async () => {
  await withStores(async (_delivery, store) => {
    const cfg = filterConfig({
      DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: normal, DORI_DISCORD_REPORT_CHANNELS: normal,
    }, { workingAnchor: (channel, user, id) => store.workingAnchor(channel, user, id) });
    cfg.botId = "88";
    const anchor = idAt(T0);
    store.openWorking(normal, "66", anchor, T0);
    const msg: IncomingMessage = {
      id: idAt(T0 + MIN), type: 0, channel_id: normal, guild_id: "300", author: { id: "66", username: "staff" },
      content: "also on mobile", timestamp: new Date(T0 + MIN).toISOString(), mentions: [],
    };
    const admitted = await classify(msg, cfg, async () => undefined);
    expect([admitted?.addition_to, admitted?.attention, admitted?.role]).toEqual([anchor, "review", "STAFF_QUESTION"]);
    expect(await classify({ ...msg, author: { id: "67", username: "bystander" } }, cfg, async () => undefined)).toBeNull();
  });
});

test.each([
  { policy: "trusted", pinged: true, role: "OWNER_REQUEST", expected: true },
  { policy: "normal", pinged: true, role: "STAFF_QUESTION", expected: false },
  { policy: "trusted", pinged: false, role: "OWNER_REQUEST", expected: false },
  { policy: "normal", pinged: false, role: "STAFF_QUESTION", expected: false },
  { policy: "trusted", pinged: true, role: "BOT_BUG_REPORT", expected: false },
])("arrival receipt eligibility is policy-backed $policy $pinged $role", async ({ policy, pinged, role, expected }) => {
  await withStores(async (_delivery, store) => {
    const id = idAt(T0);
    store.open(normal, "66", id, "open request", T0);
    const { rest, calls } = wire();
    const shown = await reactOnArrival({ store, rest, now: T0, warn: () => {} },
      { ...message(id), channel_policy: policy, pinged, role });
    expect([shown, calls.length, store.working(id)?.claimed_at ?? null]).toEqual([expected, expected ? 1 : 0, expected ? T0 : null]);
  });
});

test("startup repairs a crash on either side of adding a receipt and clears legacy stray reactions", async () => {
  await withStores(async (delivery, store) => {
    const beforeAdd = idAt(T0), afterAdd = idAt(T0, 1), stray = idAt(T0, 2);
    for (const id of [beforeAdd, afterAdd, stray]) stage(delivery, id);
    store.claimWorking(normal, "66", beforeAdd, T0);
    store.claimWorking(normal, "66", afterAdd, T0);
    store.setReacted(afterAdd, true);
    store.ensureWorking(normal, "66", stray);
    store.setReacted(stray, true);
    const { rest, calls } = wire();
    await syncReceipts({ store, rest, now: T0, warn: () => {} });
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["PUT", "PUT", "DELETE"]);
    expect([store.working(beforeAdd)?.reacted, store.working(afterAdd)?.reacted, store.working(stray)?.reacted]).toEqual([1, 1, 0]);
    expect(delivery.pending("inbound").map((row) => row.id)).toEqual([beforeAdd, afterAdd, stray]);
  });
});

test("Discord reaction calls leave the database available to another writer", async () => {
  await withStores(async (_delivery, store, path) => {
    const db = new Database(path);
    db.exec("CREATE TABLE lock_probe (message_id TEXT)");
    const id = idAt(T0);
    const rest: Rest = async () => {
      db.exec("BEGIN IMMEDIATE");
      db.query("INSERT INTO lock_probe VALUES (?)").run(id);
      db.exec("COMMIT");
      return JSON.parse("null");
    };
    try {
      expect(await showWorking({ store, rest, now: T0, warn: () => {} }, message(id))).toBe("added");
      expect(db.query("SELECT * FROM lock_probe").all()).toEqual([{ message_id: id }]);
    } finally { db.close(); }
  });
});

test("a finish racing an in-flight add leaves a removal for the next reconcile", async () => {
  await withStores(async (_delivery, store) => {
    const id = idAt(T0);
    store.claimWorking(normal, "66", id, T0);
    const calls: string[] = [];
    const rest: Rest = async (_path, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "PUT") {
        store.closeWorking([id], T0 + 1);
        store.setReacted(id, false);
      }
      return JSON.parse("null");
    };
    const o = { store, rest, now: T0 + 2, warn: () => {} };
    await syncReceipts(o);
    expect(store.working(id)?.reacted).toBe(1);
    await syncReceipts(o);
    expect([calls, store.working(id)?.reacted]).toEqual([["PUT", "DELETE"], 0]);
  });
});

test("upkeep cleans handled receipts, warns once, abandons two-hour claims and retries failures", async () => {
  await withStores(async (delivery, store) => {
    const handled = idAt(T0), stale = idAt(T0, 1), flaky = idAt(T0, 2);
    for (const id of [handled, stale, flaky]) {
      stage(delivery, id);
      store.claimWorking(normal, "66", id, T0);
      store.setReacted(id, true);
    }
    delivery.acknowledge("inbound", handled);
    delivery.acknowledge("inbound", flaky);
    const warnings: string[] = [];
    let fail = true;
    const rest: Rest = async (path, init) => {
      if (path.includes(flaky) && init?.method === "DELETE" && fail) {
        fail = false;
        throw new DiscordRestError(500, "DELETE", path, "transient");
      }
      return JSON.parse("null");
    };
    const sweep = (now: number) => sweepWorking({ store, delivery, rest, now, warn: (line) => warnings.push(line) });
    await sweep(T0 + MIN);
    expect([store.working(handled)?.reacted, store.working(flaky)?.reacted]).toEqual([0, 1]);
    await sweep(T0 + 31 * MIN);
    await sweep(T0 + 32 * MIN);
    expect(store.working(flaky)?.reacted).toBe(0);
    expect(warnings.filter((line) => line.includes(stale) && line.includes("30 minutes"))).toHaveLength(1);
    await sweep(T0 + 121 * MIN);
    expect(warnings.filter((line) => line.includes(stale) && line.includes("2 hours"))).toHaveLength(1);
    expect([store.working(stale)?.reacted, store.working(stale)?.closed_at]).toEqual([0, T0 + 121 * MIN]);
    expect(delivery.status("inbound", stale).disposition).toBe("pending");
  });
});
