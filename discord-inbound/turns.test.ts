import { expect, test } from "bun:test";
import { FakeClock } from "./fixtures/clock.ts";
import { TurnAssembler, type Turn, type TurnMessage } from "./turns.ts";
import { Delivery } from "./delivery.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function message(id: string, overrides: Partial<TurnMessage> = {}) {
  return {
    message_id: id, channel_id: "100", author_id: "99", role: "OWNER_REQUEST",
    scope: "may-request-work", channel_policy: "trusted", sent_at: new Date(0).toISOString(),
    content: `message ${id}`, attachments: [], backlog: false, ...overrides,
  } satisfies TurnMessage & Record<string, unknown>;
}

function setup() {
  const clock = new FakeClock();
  const output: Turn[] = [];
  const assembler = new TurnAssembler((turn) => output.push(turn), { clock });
  return { clock, output, assembler };
}

test("quiet gap emits one turn with the last full payload and original message order", () => {
  const { clock, output, assembler } = setup();
  const first = message("1");
  const last = { ...message("2"), content: "second\nline", extra_evidence: { key: "value" } };
  assembler.push(first);
  clock.advance(2000);
  assembler.push(last);
  clock.advance(2999);
  expect(output).toEqual([]);
  clock.advance(1);
  expect(output).toEqual([{
    ...last, turn: { id: "1", message_ids: ["1", "2"], reply_to: "2", messages: [first, last] },
  }]);
  expect(JSON.stringify(output[0]).split("\n")).toHaveLength(1);
});

test("typing extends only an existing author's buffer through its ten second window", () => {
  const { clock, output, assembler } = setup();
  assembler.typing("100", "99");
  clock.advance(20_000);
  expect(output).toEqual([]);
  assembler.push(message("1"));
  clock.advance(2000);
  assembler.typing("100", "other");
  assembler.typing("other", "99");
  assembler.typing("100", "99");
  clock.advance(9000);
  assembler.typing("100", "99");
  clock.advance(9999);
  expect(output).toEqual([]);
  clock.advance(1);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"]]);
});

test("a send clears typing and requires a new three second quiet gap", () => {
  const { clock, output, assembler } = setup();
  assembler.push(message("1"));
  clock.advance(2000);
  assembler.typing("100", "99");
  clock.advance(1000);
  assembler.push(message("2"));
  clock.advance(2999);
  expect(output).toEqual([]);
  clock.advance(1);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1", "2"]]);
});

test("an ineligible send also clears typing and resets the quiet timer", () => {
  const { clock, output, assembler } = setup();
  assembler.push(message("1"));
  clock.advance(2000);
  assembler.typing("100", "99");
  clock.advance(1000);
  assembler.sent("100", "99");
  clock.advance(2999);
  expect(output).toEqual([]);
  clock.advance(1);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"]]);
});

test("ninety second cap flushes despite continuous typing", () => {
  const { clock, output, assembler } = setup();
  assembler.push(message("1"));
  assembler.typing("100", "99");
  for (let i = 0; i < 9; i++) {
    clock.advance(9000);
    assembler.typing("100", "99");
  }
  clock.advance(8999);
  expect(output).toEqual([]);
  clock.advance(1);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"]]);
});

test("ten messages flush immediately and the next starts a new turn", () => {
  const { clock, output, assembler } = setup();
  for (let i = 1; i <= 10; i++) assembler.push(message(String(i)));
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]]);
  assembler.push(message("11"));
  clock.advance(3000);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], ["11"],
  ]);
});

test.each([
  { author_id: "77" }, { channel_id: "101" },
])("authors and channels keep separate quiet timers: %j", (overrides) => {
  const { clock, output, assembler } = setup();
  assembler.push(message("1"));
  clock.advance(1000);
  assembler.push(message("2", overrides));
  clock.advance(2000);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"]]);
  clock.advance(1000);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"], ["2"]]);
});

test.each([
  { role: "TRUSTED_REQUEST" as const }, { scope: "answer-only" as const }, { channel_policy: "normal" as const },
])("authority and policy changes flush the previous key first: %j", (overrides) => {
  const { clock, output, assembler } = setup();
  assembler.push(message("1"));
  assembler.push(message("2", overrides));
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"]]);
  clock.advance(3000);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"], ["2"]]);
});

test("bot reports emit immediately alone between human turns", () => {
  const { clock, output, assembler } = setup();
  assembler.push(message("1"));
  assembler.push(message("2", { role: "BOT_BUG_REPORT", scope: "evidence-only" }));
  assembler.push(message("3"));
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"], ["2"]]);
  clock.advance(3000);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1"], ["2"], ["3"]]);
});

test("question answers flush their buffered key immediately", () => {
  const { output, assembler } = setup();
  assembler.push(message("1"));
  assembler.push(message("2", { question_id: "question-42" }));
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1", "2"]]);
});

test("queued timer callbacks cannot flush rescheduled or already emitted buffers", () => {
  const clock = new FakeClock();
  const due: Array<() => void> = [];
  const output: Turn[] = [];
  const assembler = new TurnAssembler((turn) => output.push(turn), {
    clock: {
      now: clock.now,
      setTimeout: (callback, delay) => clock.setTimeout(() => due.push(callback), delay),
      clearTimeout: clock.clearTimeout,
    },
  });
  assembler.push(message("1"));
  clock.advance(3000);
  assembler.push(message("2"));
  due.shift()?.();
  expect(output).toEqual([]);
  clock.advance(3000);
  assembler.push(message("3", { question_id: "answer" }));
  due.shift()?.();
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([["1", "2", "3"]]);
});

test("backlog groups adjacent equal keys at sixty second gaps without reordering", () => {
  const { output, assembler } = setup();
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  assembler.replay([
    message("1"), message("2", { sent_at: at(60) }), message("3", { sent_at: at(121) }),
    message("4", { author_id: "77", sent_at: at(122) }), message("5", { sent_at: at(123) }),
    message("6", { sent_at: at(124), question_id: "answer" }), message("7", { sent_at: at(125) }),
    message("8", { role: "BOT_BUG_REPORT", scope: "evidence-only", sent_at: at(126) }),
    message("9", { role: "BOT_BUG_REPORT", scope: "evidence-only", sent_at: at(127) }),
  ]);
  expect(output.map((turn) => turn.turn.message_ids)).toEqual([
    ["1", "2"], ["3"], ["4"], ["5", "6"], ["7"], ["8"], ["9"],
  ]);
});

test("crash before flush leaves individual deliveries pending and restart replays one grouped turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-delivery-"));
  const path = join(directory, "delivery.sqlite");
  const { output, assembler } = setup();
  let delivery = new Delivery(path);
  try {
    for (const id of ["1", "2"]) {
      const payload = message(id);
      delivery.stage("inbound", id, JSON.stringify(payload));
      delivery.refresh(id, JSON.stringify(payload), JSON.stringify(payload));
      assembler.push(payload);
    }
    expect(output).toEqual([]);
    delivery.close();
    delivery = new Delivery(path);
    const replay = setup();
    replay.assembler.replay(delivery.pending("inbound").map((item) => JSON.parse(item.payload)));
    expect(replay.output.map((turn) => turn.turn.message_ids)).toEqual([["1", "2"]]);
    expect(delivery.pending("inbound").map((item) => item.id)).toEqual(["1", "2"]);
  } finally {
    delivery.close();
    await rm(directory, { recursive: true, force: true });
  }
});
