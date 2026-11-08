import { expect, test } from "bun:test";
import { fixture } from "./fixtures/controller.ts";
import { object } from "./protocol.ts";

async function openForm(f: Awaited<ReturnType<typeof fixture>>, action: string, owner = false) {
  const actor = owner ? "22222" : "11111";
  if (owner) {
    f.setRecords([{ id: "HELIO_AUTOBLOCK_WINDOW_H", title: "Automatic block window", summary: "1 hours", revision: "a".repeat(64) }]);
    await f.controller.handle(f.event({ name: "timeouts", options: [{ type: 1, name: "show" }] }, actor, 2));
    await f.click("item", ["0"], actor);
  } else await f.invoke("show", [{ type: 3, name: "topic", value: "topic-0" }]);
  await f.click("action", [action], actor);
  const callback = f.callbacks.at(-1);
  expect(callback?.type).toBe(9);
  return object(callback?.data);
}

function submission(data: Record<string, unknown>, values: Readonly<Record<string, string>>) {
  if (!Array.isArray(data.components)) throw new Error("Missing modal inputs");
  return { custom_id: data.custom_id, components: data.components.map(label => {
    const component = object(object(label).component), name = String(component.custom_id);
    return { type: 18, component: { type: component.type, custom_id: name,
      ...(component.type === 3 ? { values: [values[name]] } : { value: values[name] }) } };
  }) };
}

test.each([false, true])("conversation closure can be entered and confirmed entirely in the panel; DM=%s", async dm => {
  const f = await fixture(dm);
  const modal = await openForm(f, "close");

  await f.controller.handle({ ...f.event(submission(modal, { outcome: "answered" }), "11111", 5),
    type: "INTERACTION_CREATE" });

  expect(f.mutations()).toBe(0);
  expect(() => f.custom("commit")).not.toThrow();
  await f.click("commit");
  expect(f.mutations()).toBe(1);
  const query = object(f.submissions()[0]?.query);
  expect([query.action, query.target, object(query.input).outcome]).toEqual(["conversations.close", "topic-0", "answered"]);
});

test.each([false, true])("a hold reason entered in the panel reaches the selected conversation; DM=%s", async dm => {
  const f = await fixture(dm);
  const modal = await openForm(f, "hold");

  await f.controller.handle(f.event(submission(modal, { reason: "Waiting for a named dependency" }), "11111", 5));

  expect(f.mutations()).toBe(1);
  const query = object(f.submissions()[0]?.query);
  expect([query.action, query.target, object(query.input).reason]).toEqual(["conversations.hold", "topic-0", "Waiting for a named dependency"]);
});

test.each([false, true])("the owner sets a bounded timing value entirely in the panel; DM=%s", async dm => {
  const f = await fixture(dm);
  const modal = await openForm(f, "set", true);

  await f.controller.handle(f.event(submission(modal, { value: "12" }), "22222", 5));

  expect(f.configurationChanges()).toBe(1);
  const request = f.requests().find(request => request.kind === "configure");
  expect([request?.action, request?.target, request?.value]).toEqual(["timeout.set", "HELIO_AUTOBLOCK_WINDOW_H", "12"]);
});

test.each([
  { action: "close", values: { outcome: "invented" }, owner: false },
  { action: "hold", values: { reason: "   " }, owner: false },
  { action: "set", values: { value: "25" }, owner: true },
  { action: "set", values: { value: "1.5" }, owner: true },
  { action: "set", values: { value: "-1" }, owner: true },
])("invalid panel input is refused without a change: $action $values", async ({ action, values, owner }) => {
  const f = await fixture();
  const modal = await openForm(f, action, owner);

  await f.controller.handle(f.event(submission(modal, values), owner ? "22222" : "11111", 5));

  expect([f.mutations(), f.configurationChanges()]).toEqual([0, 0]);
  expect(() => f.custom("commit")).toThrow();
});

test.each(["actor", "channel", "guild", "application", "message", "revoked", "expired"])(
  "modal submissions retain their original authorization and binding: %s", async boundary => {
    const f = await fixture();
    const modal = await openForm(f, "hold");
    const raw = f.event(submission(modal, { reason: "Awaiting evidence" }), boundary === "actor" ? "33333" : "11111", 5);
    const event = { ...raw,
      ...(boundary === "channel" ? { channel_id: "55555" } : {}),
      ...(boundary === "guild" ? { guild_id: "55555" } : {}),
      ...(boundary === "application" ? { application_id: "55555" } : {}),
      ...(boundary === "message" ? { message: { id: "55555" } } : {}),
    };
    if (boundary === "revoked") f.revoke();
    if (boundary === "expired") f.panels.remove(String(modal.custom_id).split(":")[1] ?? "");

    await f.controller.handle(event);

    expect(f.mutations()).toBe(0);
    expect(f.configurationChanges()).toBe(0);
    expect(f.callbacks.at(-1)?.type).toBe(boundary === "revoked" ? 6 : 4);
  });

test.each(["revision", "removed", "navigation"])("a form cannot act on a changed selection: %s", async change => {
  const f = await fixture();
  const modal = await openForm(f, "close");
  if (change === "navigation") await f.click("back");
  else f.setRecords(change === "removed" ? [] : f.records().map(record =>
    record.id === "topic-0" ? { ...record, revision: "2" } : record));

  await f.controller.handle(f.event(submission(modal, { outcome: "answered" }), "11111", 5));

  expect(f.mutations()).toBe(0);
  expect(() => f.custom("commit")).toThrow();
});

test("a duplicated form submission cannot repeat a completed action", async () => {
  const f = await fixture();
  const modal = await openForm(f, "hold");
  const data = submission(modal, { reason: "Awaiting evidence" });
  await f.controller.handle(f.event(data, "11111", 5));

  await f.controller.handle(f.event(data, "11111", 5));

  expect(f.mutations()).toBe(1);
});

test("contributors cannot open owner-only timing forms", async () => {
  const f = await fixture();
  f.setRecords([{ id: "HELIO_AUTOBLOCK_WINDOW_H", title: "Automatic block window", summary: "1 hours", revision: "a".repeat(64) }]);
  await f.controller.handle(f.event({ name: "timeouts", options: [{ type: 1, name: "show" }] }, "11111", 2));
  await f.click("item", ["0"]);
  const panelId = f.custom("refresh").split(":")[1] ?? "";
  const panel = f.panels.get(panelId, Date.now());

  await f.controller.handle(f.event({ custom_id: `ha1:${panel.id}:${panel.revision}:action`, component_type: 3, values: ["set"] }));

  expect(f.callbacks.at(-1)?.type).toBe(4);
  expect(f.configurationChanges()).toBe(0);
});

test("a timing form cannot overwrite configuration changed while it was open", async () => {
  const f = await fixture();
  const modal = await openForm(f, "set", true);
  f.revisePolicy();

  await f.controller.handle(f.event(submission(modal, { value: "12" }), "22222", 5));

  expect(f.configurationChanges()).toBe(0);
});

test("an unsubmitted or superseded form cannot perform a change", async () => {
  const f = await fixture();
  const first = await openForm(f, "hold");
  expect(f.mutations()).toBe(0);
  await f.click("action", ["close"]);

  await f.controller.handle(f.event(submission(first, { reason: "Old input" }), "11111", 5));

  expect(f.mutations()).toBe(0);
  expect(() => f.custom("commit")).toThrow();
});

test("DM requester and channel filters can be entered and applied without a command", async () => {
  const f = await fixture(true);
  f.setRecords([
    { id: "one", user: "33333", channel: "44444", title: "Matching", summary: "Visible", revision: "1" },
    { id: "two", user: "11111", channel: "44444", title: "Other requester", summary: "Hidden", revision: "1" },
    { id: "three", user: "33333", channel: "55555", title: "Other channel", summary: "Hidden", revision: "1" },
  ]);
  await f.invoke();
  await f.click("filters");
  await f.click("filter-ids");
  expect(f.callbacks.at(-1)?.type).toBe(9);
  const modal = object(f.callbacks.at(-1)?.data);

  await f.controller.handle(f.event(submission(modal, { user: "33333", channel: "44444" }), "11111", 5));
  await f.click("apply-filters");

  const embeds = f.last().embeds;
  if (!Array.isArray(embeds)) throw new Error("Missing filtered list");
  const fields = object(embeds[0]).fields;
  if (!Array.isArray(fields)) throw new Error("Missing filtered conversations");
  expect(fields.map(field => object(field).name)).toEqual(["Matching"]);
  expect(f.mutations()).toBe(0);
});

test("DM audit actor filters can be edited and cleared without a command", async () => {
  const f = await fixture(true);
  await f.controller.handle(f.event({ name: "audit", options: [{ type: 1, name: "list",
    options: [{ type: 6, name: "actor", value: "33333" }] }] }, "11111", 2));
  await f.click("filters");
  await f.click("filter-ids");
  expect(f.callbacks.at(-1)?.type).toBe(9);
  const modal = object(f.callbacks.at(-1)?.data);

  await f.controller.handle(f.event(submission(modal, { user: "" }), "11111", 5));
  await f.click("apply-filters");

  const reads = f.requests().filter(request => request.kind === "runtime");
  expect(object(object(reads.at(-1)?.query).filters).user).toBeUndefined();
  expect(f.mutations()).toBe(0);
});
