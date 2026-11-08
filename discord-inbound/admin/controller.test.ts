import { expect, spyOn, test } from "bun:test";
import { Panels } from "./panels.ts";
import { object } from "./protocol.ts";
import { interaction } from "./interaction.ts";
import { fixture } from "./fixtures/controller.ts";

test.each(["channel_id", "channel"])("DM identity uses the top-level user and supports %s", channel => {
  const event = interaction({ type: "INTERACTION_CREATE", id: "10000", application_id: "88888", token: "offline",
    user: { id: "11111" }, member: { user: { id: "33333" } },
    ...(channel === "channel_id" ? { channel_id: "44444" } : { channel: { id: "44444", type: 1 } }),
    data: { name: "status", resolved: { users: { "22222": { id: "22222" } } } } });
  expect([event.actor, event.guild, event.channel]).toEqual(["11111", undefined, "44444"]);
});

test("DM navigation and writes stay scoped to the configured server and original DM message", async () => {
  const f = await fixture(true);
  await f.invoke();
  await f.click("next");
  await f.click("item", ["8"]);
  expect(JSON.stringify(f.last())).toContain("Topic 8");
  const refresh = f.custom("refresh"), rendered = f.messages.length;
  await f.controller.handle({ ...f.event({ custom_id: refresh, component_type: 2 }), guild_id: "99999",
    member: { user: { id: "11111" } } });
  expect(f.messages.length).toBe(rendered);
  await f.invoke("hold", [{ type: 3, name: "topic", value: "topic-8" }, { type: 3, name: "reason", value: "DM administration" }]);
  expect(f.mutations()).toBe(1);
  const runtime = f.requests().filter(request => request.kind === "runtime");
  expect(runtime.every(request => request.guild === "99999" && request.actor === "11111")).toBe(true);
  const identity = f.custom("refresh").split(":")[1] ?? "";
  expect(f.panels.get(identity, Date.now()).guild).toBeUndefined();
});

test("a DM owner can preview and confirm configuration while an unknown caller is denied", async () => {
  const f = await fixture(true);
  const command = { name: "trusted", options: [
    { type: 1, name: "add", options: [{ type: 6, name: "user", value: "33333" }] },
  ] };
  await f.controller.handle(f.event(command, "33333", 2));
  expect(f.configurationChanges()).toBe(0);
  expect(f.last().components).toEqual([]);
  await f.controller.handle(f.event(command, "22222", 2));
  expect(f.configurationChanges()).toBe(0);
  await f.click("commit", [], "22222");
  expect(f.configurationChanges()).toBe(1);
  expect(JSON.stringify(f.last())).toContain("Trust granted");
});

test.each([
  { action: "pause", screen: "detail", writes: 1 },
  { action: "abandon", screen: "confirm", writes: 0 },
])("the lane %s control completes its action flow instead of sending the owner to another command", async ({ action, screen, writes }) => {
  const f = await fixture();
  f.setRecords([{ id: "lane-one", title: "Work lane", summary: "Working", state: "working", revision: "1" }]);
  await f.controller.handle(f.event({ name: "lanes", options: [
    { type: 1, name: "show", options: [{ type: 3, name: "lane", value: "lane-one" }] },
  ] }, "22222", 2));

  await f.click("action", [action], "22222");

  const identity = f.custom(screen === "confirm" ? "commit" : "refresh").split(":")[1];
  if (!identity) throw new Error("Missing panel identity");
  expect(f.panels.get(identity, Date.now()).screen).toBe(screen);
  expect(f.mutations()).toBe(writes);
});

test("DM channel autocomplete uses the server channel catalog and rechecks access", async () => {
  const f = await fixture(true);
  const data = { name: "channels", options: [
    { type: 1, name: "show", options: [{ type: 3, name: "channel", value: "Server", focused: true }] },
  ] };
  await f.controller.handle(f.event(data, "11111", 4));
  const choices = object(f.callbacks.at(-1)?.data).choices;
  if (!Array.isArray(choices)) throw new Error("Missing channel suggestions");
  expect(choices.map(choice => object(choice).value)).toEqual(["55555"]);
  expect(object(choices[0]).name).toContain("Server room");
  expect(f.requests().filter(request => request.kind === "runtime").every(request => request.guild === "99999")).toBe(true);
  f.revoke();
  await f.controller.handle(f.event(data, "11111", 4));
  expect(object(f.callbacks.at(-1)?.data).choices).toEqual([]);
});

test("DM autocomplete does not dispatch runtime work after its shared request budget expires", async () => {
  const f = await fixture(true);
  const clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(1601);
  try {
    await f.controller.handle(f.event({ name: "conversations", options: [
      { type: 1, name: "show", options: [{ type: 3, name: "topic", value: "", focused: true }] },
    ] }, "11111", 4));
    expect(object(f.callbacks.at(-1)?.data).choices).toEqual([]);
    expect(f.requests().filter(request => request.kind === "runtime")).toEqual([]);
  } finally { clock.mockRestore(); }
});

test.each([
  { section: "trusted", verb: "add", command: "/trusted add" },
  { section: "channels", verb: "choose-channel", command: "/channels show" },
  { section: "conversations", verb: "filters", command: "/conversations list" },
])("DM inputs provide usable commands instead of guild-only pickers: %s", async ({ section, verb, command }) => {
  const f = await fixture(true);
  await f.controller.handle(f.event({ name: section, options: [{ type: 1, name: "list" }] }, "22222", 2));
  await f.click(verb, [], "22222");
  expect(JSON.stringify(f.last())).toContain(command);
  const rows = f.last().components;
  if (!Array.isArray(rows)) throw new Error("Missing DM controls");
  const types = rows.flatMap(row => {
    const children = object(row).components;
    return Array.isArray(children) ? children.map(child => object(child).type) : [];
  });
  expect(types.some(type => type === 5 || type === 8)).toBe(false);
});

test("navigation keeps the selected identity when an earlier snapshot record disappears", async () => {
  const f = await fixture();
  await f.invoke();
  await f.click("next");
  f.setRecords(f.records().filter(record => record.id !== "topic-0"));
  await f.click("item", ["8"]);
  const embeds = f.last().embeds;
  expect(Array.isArray(embeds) && object(embeds[0]).title).toBe("Topic 8");
  expect(f.mutations()).toBe(0);
});

test.each([false, true])("foreign actors and revoked trust cannot inspect a panel; DM=%s", async dm => {
  const f = await fixture(dm);
  await f.invoke();
  const rendered = f.messages.length;
  await f.click("next", [], "33333");
  expect(f.messages.length).toBe(rendered);
  expect(f.callbacks.at(-1)?.type).toBe(4);
  f.revoke();
  await f.click("next");
  expect(f.last().components).toEqual([]);
  expect(JSON.stringify(f.last())).not.toContain("Topic 0");
  expect(f.mutations()).toBe(0);
});

test("a close confirmation cannot commit after the selected topic revision changes", async () => {
  const f = await fixture();
  await f.invoke("close", [{ type: 3, name: "topic", value: "topic-0" }, { type: 3, name: "outcome", value: "completed" }]);
  const commit = f.custom("commit");
  f.setRecords(f.records().map(record => record.id === "topic-0" ? { ...record, revision: "2" } : record));
  await f.controller.handle(f.event({ custom_id: commit, component_type: 2 }));
  expect(f.mutations()).toBe(0);
  expect(JSON.stringify(f.last())).toContain("target changed");
  expect(JSON.stringify(f.last())).toContain("completed");
  await f.click("refresh");
  expect(f.mutations()).toBe(0);
  await f.click("commit");
  expect(f.mutations()).toBe(1);
});

test.each([
  { source: "direct", reason: "Wait for named evidence" },
  { source: "reconciled", reason: "Wait for named evidence" },
  { source: "direct", reason: "topic-0" },
])("a refusal retains distinct input roles and requires a new decision on the refreshed target: %s", async ({ source, reason }) => {
  const f = await fixture();
  if (source === "direct") f.refuseMutation(true); else f.loseMutationResponse();
  await f.invoke("hold", [{ type: 3, name: "topic", value: "topic-0" },
    { type: 3, name: "reason", value: reason }]);
  if (source === "reconciled") { f.settleOperation("refused"); await f.click("refresh"); }
  const embeds = f.last().embeds;
  if (!Array.isArray(embeds)) throw new Error("Missing refused proposal");
  const fields = object(embeds[0]).fields;
  if (!Array.isArray(fields)) throw new Error("Missing proposed values");
  expect(fields.some(field => object(field).name === "reason" && object(field).value === reason)).toBe(true);
  expect(JSON.stringify(f.last())).not.toContain(":commit");
  f.refuseMutation(false);
  f.loseMutationResponse(false);
  f.setRecords(f.records().map(record => record.id === "topic-0" ?
    { ...record, revision: "2", summary: "Changed target state" } : record));
  await f.click("refresh");
  expect(f.mutations()).toBe(1);
  expect(JSON.stringify(f.last())).toContain("Changed target state");
  expect(JSON.stringify(f.last())).toContain(reason);
  await f.click("commit");
  expect(f.mutations()).toBe(2);
  expect(f.submissions()[0]?.operation).not.toBe(f.submissions()[1]?.operation);
  expect(object(f.submissions()[1]?.query).expected).toBe("2");
  expect(object(object(f.submissions()[1]?.query).input).reason).toBe(reason);
  expect(JSON.stringify(f.last())).toContain("Changed");
});

test("rapid confirmation clicks commit only once and restart invalidates the old controls", async () => {
  const f = await fixture();
  await f.invoke("close", [{ type: 3, name: "topic", value: "topic-0" }, { type: 3, name: "outcome", value: "answered" }]);
  const commit = f.custom("commit");
  await Promise.all([1, 2].map(() => f.controller.handle(f.event({ custom_id: commit, component_type: 2 }))));
  expect(f.mutations()).toBe(1);
  const refresh = f.custom("refresh");
  using restarted = new Panels(f.path);
  await f.controller.handle(f.event({ custom_id: refresh, component_type: 2 }));
  expect(f.callbacks.at(-1)?.type).toBe(4);
  expect(JSON.stringify(f.callbacks.at(-1))).toContain("Panel expired");
  expect(f.mutations()).toBe(1);
});

test("a completed change stays reported when reloading its details fails", async () => {
  const f = await fixture();
  await f.invoke("show", [{ type: 3, name: "topic", value: "topic-0" }]);
  f.failReadsAfterMutation();
  await f.invoke("hold", [{ type: 3, name: "topic", value: "topic-0" }, { type: 3, name: "reason", value: "Awaiting beta" }]);
  expect(f.mutations()).toBe(1);
  expect(JSON.stringify(f.last())).toContain("Changed");
  expect(JSON.stringify(f.last())).toContain("details are unavailable");
});

test.each(["lost", "malformed"])("an uncertain %s response retains read-only recovery controls across restart without submitting again", async response => {
  const f = await fixture();
  if (response === "lost") f.loseMutationResponse(); else f.corruptMutationResponse();
  await f.invoke("hold", [{ type: 3, name: "topic", value: "topic-0" }, { type: 3, name: "reason", value: "Awaiting evidence" }]);
  expect(JSON.stringify(f.last())).toContain("Checking change");
  expect(JSON.stringify(f.last())).not.toContain(":action");
  expect(f.mutations()).toBe(1);
  using restarted = new Panels(f.path);
  await f.click("refresh");
  expect(JSON.stringify(f.last())).toContain("Checking change");
  f.settleOperation();
  await f.click("refresh");
  expect(JSON.stringify(f.last())).toContain("Change committed");
  expect(f.mutations()).toBe(1);
});

test("expiring a panel removes its controls without changing domain state", async () => {
  const f = await fixture();
  await f.invoke();
  const identity = f.custom("next").split(":")[1] ?? "";
  const panel = f.panels.get(identity, Date.now());
  panel.expires = 0;
  f.panels.save(panel, false);
  await f.controller.expire();
  expect(f.last().components).toEqual([]);
  expect(JSON.stringify(f.last())).toContain("Panel expired");
  expect(f.mutations()).toBe(0);
});

test("native user selection previews an owner grant and preserves pending application feedback", async () => {
  const f = await fixture();
  await f.controller.handle(f.event({ name: "trusted", options: [{ type: 1, name: "list" }] }, "22222", 2));
  await f.click("add", [], "22222");
  await f.click("entity-user", ["33333"], "22222");
  expect(f.configurationChanges()).toBe(0);
  expect(JSON.stringify(f.last())).toContain("Grant trust");
  await f.click("commit", [], "22222");
  expect(f.configurationChanges()).toBe(1);
  expect(JSON.stringify(f.last())).toContain("consumer application pending");
  expect(JSON.stringify(f.last())).not.toContain(":commit");
});

test("trusted command callers cannot reach any owner-only mutation", async () => {
  const f = await fixture();
  const cases = [
    ["trusted", "add", "user"], ["trusted", "remove", "entry"], ["channels", "set", "channel"],
    ["timeouts", "set", "setting"], ["lanes", "abandon", "lane"],
  ];
  for (const [group, name, parameter] of cases) {
    await f.controller.handle(f.event({ name: group, options: [
      { type: 1, name, options: [{ type: parameter === "user" ? 6 : 3, name: parameter, value: "33333" }] },
    ] }, "11111", 2));
    expect(JSON.stringify(f.last())).toContain("Only the owner");
  }
  expect(f.configurationChanges()).toBe(0);
  expect(f.mutations()).toBe(0);
});

test("GitHub observations survive paging and refresh until an explicit new probe", async () => {
  const f = await fixture();
  await f.controller.handle(f.event({ name: "status", options: [{ type: 3, name: "dependency", value: "github" }] }, "11111", 2));
  await f.click("content-next");
  expect(JSON.stringify(f.last())).toContain("Observation 1:8");
  await f.click("refresh");
  expect(JSON.stringify(f.last())).toContain("Observation 1:8");
  expect(f.probes()).toBe(1);
  await f.click("action", ["check"]);
  expect(JSON.stringify(f.last())).toContain("Observation 2:0");
  expect(f.probes()).toBe(2);
});

test.each(["policy", "runtime"] as const)("a %s outage leaves a usable Refresh control without offering mutations", async source => {
  const f = await fixture();
  f.setUnavailable(source);
  await f.invoke();
  const refresh = f.custom("refresh");
  expect(JSON.stringify(f.last())).not.toContain(":action");
  f.setUnavailable(undefined);
  await f.controller.handle(f.event({ custom_id: refresh, component_type: 2 }));
  expect(JSON.stringify(f.last())).toContain("Topic 0");
  expect(f.mutations()).toBe(0);
});
