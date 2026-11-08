import { expect, test } from "bun:test";
import { fixture } from "./fixtures/controller.ts";
import { object } from "./protocol.ts";

test.each([{ dm: false, delay: 0 }, { dm: true, delay: 0 }, { dm: true, delay: 1250 }])("autocomplete returns visible choices within its total deadline and honors revocation: %s", async ({ dm, delay }) => {
  const f = await fixture(dm);
  f.delayReads(delay);
  f.setRecords(Array.from({ length: 40 }, (_, index) => ({ id: String(index), title: `Topic ${index}`,
    summary: "Visible topic", revision: "1" })));
  const raw = () => f.event({ name: "conversations", options: [
    { type: 1, name: "show", options: [{ type: 3, name: "topic", value: "", focused: true }] },
  ] }, "11111", 4);
  await f.controller.handle(raw());
  const data = object(f.callbacks.at(-1)?.data);
  expect(Array.isArray(data.choices) && data.choices.length).toBe(25);
  f.revoke();
  await f.controller.handle(raw());
  expect(object(f.callbacks.at(-1)?.data).choices).toEqual([]);
});
