import { expect, test } from "bun:test";
import { fixture } from "./fixtures/controller.ts";
import { object } from "./protocol.ts";

test.each(["command", "selection", "refresh"])("targeted details remain available when an unrelated list read fails: %s", async source => {
  const f = await fixture();
  if (source === "selection") { await f.invoke(); await f.click("next"); }
  if (source === "refresh") await f.invoke("show", [{ type: 3, name: "topic", value: "topic-8" }]);
  f.setUnavailable("list");
  if (source === "command") await f.invoke("show", [{ type: 3, name: "topic", value: "topic-8" }]);
  else await f.click(source === "selection" ? "item" : "refresh", source === "selection" ? ["8"] : []);
  const embeds = f.last().embeds;
  expect(Array.isArray(embeds) && object(embeds[0]).title).toBe("Topic 8");
  expect(f.mutations()).toBe(0);
});

test("switching sections does not depend on the section being left", async () => {
  const f = await fixture();
  await f.invoke();
  f.setUnavailable("conversations");
  await f.click("section", ["lanes"]);
  expect(() => f.custom("item")).not.toThrow();
  expect(f.mutations()).toBe(0);
});
