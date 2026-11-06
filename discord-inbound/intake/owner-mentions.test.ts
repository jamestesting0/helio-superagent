import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizationMetadata, filterConfig, reauthorize } from "./authorization.ts";
import { Conversations } from "../conversations/conversations.ts";
import { Delivery } from "../delivery/delivery.ts";
import { classify, type IncomingMessage } from "./filter.ts";
import type { Rest } from "../discord/rest.ts";
import { TurnAssembler, type Turn, type TurnMessage } from "./turns.ts";
import { guardedReply } from "../conversations/reply-guard.ts";

const OWNER = "653894110884921366";
const BOT = "880000000000000001";
const STAFF = "660000000000000001";
const NORMAL = "1199770187738644652";
const TRUSTED = "1218071208197623880";
const AT = Date.parse("2026-11-04T12:00:00.000Z");
const parentOf = async () => undefined;

function config(values: Record<string, string> = {}, lastOwnerPost?: (channel: string) => number | undefined) {
  const cfg = filterConfig({
    DORI_DISCORD_OWNER_ID: OWNER, DORI_DISCORD_ALLOWED: `${NORMAL},${TRUSTED}`, DORI_DISCORD_NORMAL_CHANNELS: NORMAL,
    DORI_DISCORD_TRUSTED_CHANNELS: TRUSTED, DORI_DISCORD_REPORT_CHANNELS: NORMAL, ...values,
  }, undefined, undefined, lastOwnerPost);
  cfg.botId = BOT;
  return cfg;
}

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "1300000000000000001", type: 0, channel_id: NORMAL, guild_id: "900", author: { id: STAFF, username: "staff" },
    content: `<@${OWNER}> how do I register my base?`, timestamp: new Date(AT).toISOString(),
    mentions: [{ id: OWNER }], ...over,
  };
}

test("a normal-chat message that mentions the owner reaches Helio for review, flagged as for the owner", async () => {
  const out = await classify(message(), config(), parentOf);
  expect([out?.role, out?.scope, out?.attention, out?.for_owner]).toEqual(["STAFF_QUESTION", "may-report-issue", "review", true]);
});

test("a reply-ping to the owner counts; role mentions, the owner's own messages and unrelated chatter do not", async () => {
  const cfg = config();
  const replyPing = message({ content: "is that right?", referenced_message: { author: { id: OWNER } } });
  expect((await classify(replyPing, cfg, parentOf))?.for_owner).toBe(true);
  expect(await classify(message({ content: "<@&123> help", mentions: [] }), cfg, parentOf)).toBeNull();
  expect(await classify(message({ author: { id: OWNER, username: "owner" } }), cfg, parentOf)).toBeNull();
  expect(await classify(message({ content: "hello all", mentions: [] }), cfg, parentOf)).toBeNull();
});

test("a message that also pings or replies to Helio is addressed to Helio, not the owner", async () => {
  const cfg = config();
  const both = await classify(message({ content: `<@${BOT}> <@${OWNER}> help`, mentions: [{ id: BOT }, { id: OWNER }] }), cfg, parentOf);
  expect([both?.attention, both?.for_owner]).toEqual(["direct", undefined]);
  const toHelio = await classify(message({ message_reference: { message_id: "5" }, referenced_message: { author: { id: BOT } } }), cfg, parentOf);
  expect(toHelio?.for_owner).toBeUndefined();
});

test("while the owner is active in the channel, mentions of the owner are left to the owner", async () => {
  const minutesAgo = (minutes: number) => config({}, () => AT - minutes * 60_000);
  expect(await classify(message(), minutesAgo(3), parentOf)).toBeNull();
  expect((await classify(message(), minutesAgo(11), parentOf))?.for_owner).toBe(true);
  expect((await classify(message(), config({ HELIO_OWNER_PRESENT_MINUTES: "2" }, () => AT - 3 * 60_000), parentOf))?.for_owner).toBe(true);
});

test("switching the feature off restores ping-only intake; the trusted chat still flags the mention", async () => {
  expect(await classify(message(), config({ HELIO_ANSWER_FOR_OWNER: "off" }), parentOf)).toBeNull();
  const trusted = await classify(message({ channel_id: TRUSTED }), config(), parentOf);
  expect([trusted?.channel_policy, trusted?.for_owner]).toEqual(["trusted", true]);
  expect(() => config({ HELIO_ANSWER_FOR_OWNER: "maybe" })).toThrow("HELIO_ANSWER_FOR_OWNER");
});

test("a pending owner mention keeps its flag when replayed", async () => {
  const msg = message();
  const first = await classify(msg, config(), parentOf);
  const payload = JSON.stringify({ ...first, preparation_complete: true, discord_origin: authorizationMetadata(msg) });
  const rest = (async () => ({ id: NORMAL, type: 0, guild_id: "900" })) as unknown as Rest;
  const replayed = await reauthorize(payload, config(), rest);
  expect([replayed?.for_owner, replayed?.attention]).toEqual([true, "review"]);
});

test("a message to the owner and a ping to Helio from the same person never share a turn", () => {
  const turns: Turn[] = [];
  const assembler = new TurnAssembler((turn) => turns.push(turn), {
    clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
  });
  const base: TurnMessage = { message_id: "1", channel_id: NORMAL, author_id: STAFF, role: "STAFF_QUESTION",
    scope: "may-report-issue", channel_policy: "normal", sent_at: new Date(AT).toISOString() };
  assembler.push({ ...base, for_owner: true });
  assembler.push({ ...base, message_id: "2" });
  expect(turns.map((turn) => turn.turn.message_ids)).toEqual([["1"]]);
});

async function guard(laterAuthors: string[], forOwner: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "helio-owner-guard-"));
  const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const target = "1300000000000000001";
  try {
    delivery.stage("inbound", target, JSON.stringify({
      channel_id: NORMAL, author_id: STAFF, role: "STAFF_QUESTION", content: "help", attachments: [],
      ...(forOwner ? { for_owner: true } : {}),
    }));
    const rest = (async (path: string) => path.includes("?after=") ?
      laterAuthors.map((id, n) => ({ id: `14${n}`, author: { id } })) : { content: "help" }) as Rest;
    const sent: string[] = [];
    const result = await guardedReply({
      delivery, store, rest, channel: NORMAL, target, covers: [], seen: [], owner: OWNER,
      send: async () => { sent.push("sent"); return "900"; }, cleanup: async () => {}, now: () => AT, warn: () => {},
    });
    return { code: result.code, lines: result.lines, sent };
  } finally {
    delivery.close();
    store.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test("Helio does not answer for the owner once the owner has answered", async () => {
  const skipped = await guard([STAFF, OWNER], true);
  expect([skipped.code, skipped.sent]).toEqual([4, []]);
  expect(skipped.lines[0]).toContain("the owner already answered");
  expect((await guard([STAFF], true)).sent).toEqual(["sent"]);
  expect((await guard([OWNER], false)).sent).toEqual(["sent"]);
});
