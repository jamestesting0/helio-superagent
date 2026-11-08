import { expect, test } from "bun:test";
import { fixture } from "./fixtures/controller.ts";
import { object } from "./protocol.ts";
import { Controller } from "./controller.ts";
import { DiscordTransport } from "./transport.ts";

test.each([false, true])("a lost defer response ends private thinking without executing the command; DM=%s", async dm => {
  const f = await fixture(dm);
  using transport = new DiscordTransport("offline-secret");
  let callbacks = 0;
  let callback: Record<string, unknown> = {};
  let loading = false;
  let message: Record<string, unknown> = {};
  transport.rest.options.makeRequest = async (url, options) => {
    if (String(url).endsWith("/callback")) {
      callbacks += 1;
      callback = object(JSON.parse(String(options.body)));
      loading = callback.type === 5;
      throw new TypeError("Discord accepted the defer but its response was lost");
    }
    expect(options.method).toBe("PATCH");
    message = object(JSON.parse(String(options.body)));
    loading = false;
    return Response.json({ id: "77777" });
  };
  const controller = new Controller(f.panels, transport.call);

  await controller.handle(f.event({ name: "conversations", options: [{ type: 1, name: "list" }] }, "11111", 2));

  expect(loading).toBe(false);
  const embeds = message.embeds;
  expect(Array.isArray(embeds) && object(embeds[0]).description).toContain("Administration is unavailable");
  expect(callbacks).toBe(1);
  expect(callback.type).toBe(5);
  expect(object(callback.data).flags).toBe(64);
  expect(f.requests()).toEqual([]);
  expect(f.mutations()).toBe(0);
});

test.each([400, 404, 429])("a refused defer does not edit an existing reply or execute the command: %s", async status => {
  const f = await fixture();
  using transport = new DiscordTransport("offline-secret");
  const methods: string[] = [];
  transport.rest.options.makeRequest = async (_url, options) => {
    methods.push(String(options.method));
    if (options.method === "PATCH") return Response.json({ id: "77777" });
    return Response.json({ message: "Rejected", code: 40060, retry_after: 0, global: false }, { status });
  };
  const controller = new Controller(f.panels, transport.call);

  await expect(controller.handle(f.event({
    name: "conversations", options: [{ type: 1, name: "list" }],
  }, "11111", 2))).rejects.toMatchObject({ status });

  expect(methods).toEqual(["POST"]);
  expect(f.requests()).toEqual([]);
});

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

test.each([
  { section: "trusted", confirm: true, dm: false },
  { section: "trusted", confirm: true, dm: true },
  { section: "blocks", confirm: false, dm: false },
  { section: "blocks", confirm: false, dm: true },
])("returning after $section add shows existing users and the new user; DM=$dm", async ({ section, confirm, dm }) => {
  const f = await fixture(dm);
  const existing = [
    { id: "11111", user: "11111", title: "First user", summary: "Existing", revision: "1" },
    { id: "44444", user: "44444", title: "Second user", summary: "Existing", revision: "1" },
  ];
  f.setRecords(existing);
  await f.controller.handle(f.event({ name: section, options: [{ type: 1, name: "add", options: [
    { type: 6, name: "user", value: "33333" }, { type: 3, name: "reason", value: "Requested change" },
  ] }] }, "22222", 2));
  f.setRecords([...existing, { id: "33333", user: "33333", title: "New user", summary: "Added", revision: "1" }]);
  if (confirm) await f.click("commit", [], "22222");

  await f.click("back", [], "22222");

  const embeds = f.last().embeds;
  if (!Array.isArray(embeds)) throw new Error("Missing list");
  const fields = object(embeds[0]).fields;
  if (!Array.isArray(fields)) throw new Error("Missing users");
  expect(fields.map(field => object(field).name)).toEqual(["First user", "Second user", "New user"]);
  expect(confirm ? f.configurationChanges() : f.mutations()).toBe(1);
});

test.each([false, true])("explicit list filters survive opening an item and returning; DM=%s", async dm => {
  const f = await fixture(dm);
  f.setRecords([
    { id: "one", user: "33333", channel: "44444", title: "Matching", summary: "Visible", revision: "1" },
    { id: "two", user: "11111", channel: "44444", title: "Other user", summary: "Hidden", revision: "1" },
    { id: "three", user: "33333", channel: "55555", title: "Other channel", summary: "Hidden", revision: "1" },
  ]);
  await f.invoke("list", [{ type: 6, name: "user", value: "33333" }, { type: 7, name: "channel", value: "44444" }]);
  await f.click("item", ["0"]);

  await f.click("back");

  const embeds = f.last().embeds;
  if (!Array.isArray(embeds)) throw new Error("Missing list");
  const fields = object(embeds[0]).fields;
  if (!Array.isArray(fields)) throw new Error("Missing topics");
  expect(fields.map(field => object(field).name)).toEqual(["Matching"]);
  expect(f.mutations()).toBe(0);
});
