import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "./controller.ts";
import { Panels } from "./panels.ts";
import { object, type AdminPolicy, type AdminRecord } from "./protocol.ts";
import { interaction } from "./interaction.ts";

const original = process.env.HELIO_ADMIN_SOCKET;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (original === undefined) delete process.env.HELIO_ADMIN_SOCKET; else process.env.HELIO_ADMIN_SOCKET = original;
});

test.each(["channel_id", "channel"])("DM identity uses the top-level user and supports %s", channel => {
  const event = interaction({ type: "INTERACTION_CREATE", id: "10000", application_id: "88888", token: "offline",
    user: { id: "11111" }, member: { user: { id: "33333" } },
    ...(channel === "channel_id" ? { channel_id: "44444" } : { channel: { id: "44444", type: 1 } }),
    data: { name: "status", resolved: { users: { "22222": { id: "22222" } } } } });
  expect([event.actor, event.guild, event.channel]).toEqual(["11111", undefined, "44444"]);
});

async function fixture(dm = false) {
  const home = mkdtempSync(join(tmpdir(), "helio-admin-panel-"));
  const path = join(home, "admin.sock");
  process.env.HELIO_ADMIN_SOCKET = path;
  let trusted = "11111";
  let records: AdminRecord[] = Array.from({ length: 19 }, (_, index) => ({
    id: `topic-${index}`, title: `Topic ${index}`, summary: "Waiting on Helio", state: "waiting_on_helio",
    revision: "1", fields: [{ name: "Request", value: `Request ${index}` }],
  }));
  const policy: AdminPolicy = { version: 1, revision: "a".repeat(64),
    values: { DORI_DISCORD_OWNER_ID: "22222", HELIO_TRUSTED_USERS: trusted, HELIO_ADMIN_GUILD: "99999" }, timing: [] };
  let mutations = 0;
  let configurationChanges = 0;
  let readFailure = false;
  let uncertain = false;
  let settled: "done" | "refused" | undefined;
  let refusal = false;
  let malformed = false;
  const submissions: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  let probes = 0;
  let unavailable: "policy" | "runtime" | undefined;
  const server: Server = createServer(socket => {
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (input.length < 4 || input.length < input.readUInt32BE(0) + 4) return;
      const request = object(JSON.parse(input.subarray(4).toString()));
      requests.push(request);
      let response: unknown = { ...policy, values: { ...policy.values, HELIO_TRUSTED_USERS: trusted } };
      if (request.kind === "runtime") {
        const query = object(request.query);
        if (query.kind === "mutate") { mutations += 1; submissions.push(request); response = malformed ? { records: null } : { records: [], notice: "Changed" }; }
        else if (query.kind === "probe") {
          probes += 1;
          response = { records: [{ id: "github", title: "GitHub", summary: "Timestamped observation", revision: String(probes),
            fields: Array.from({ length: 9 }, (_, index) => ({ name: `Evidence ${index}`, value: `Observation ${probes}:${index}` })) }] };
        } else if (query.section === "settings") {
          response = { records: [{ id: "github", title: "GitHub", summary: "Check access", revision: "1",
            fields: [{ name: "Access", value: "Use Check GitHub for a fresh probe" }] }] };
        } else if (query.section === "channels") {
          response = { records: [{ id: "55555", channel: "55555", title: "Server room", state: "normal",
            summary: "Configured channel", revision: "1" }] };
        }
        else response = { records: query.target ? records.filter(row => row.id === query.target) : records, revision: policy.revision };
      }
      if (request.kind === "configure") {
        configurationChanges += 1;
        response = { application: "Saved; consumer application pending" };
      }
      if (request.kind === "operation") response = settled ?
        { status: settled, result: settled === "done" ? { records: [], notice: "Change committed", operation: request.operation } :
          { error: "Target changed before commit" } } :
        { status: "uncertain", result: null };
      const failed = request.kind === "policy" ? unavailable === "policy" :
        request.kind === "runtime" && object(request.query).kind === "read" && (unavailable === "runtime" || readFailure && mutations > 0);
      const lost = uncertain && request.kind === "runtime" && object(request.query).kind === "mutate";
      const refused = refusal && request.kind === "runtime" && object(request.query).kind === "mutate";
      const output = Buffer.from(JSON.stringify(lost ? { ok: false, code: "uncertain", error: "Response lost" } :
        refused ? { ok: false, code: "changed", error: "Target changed before commit" } :
        failed ? { ok: false, code: "unavailable", error: "Runtime inspection unavailable" } :
        { ok: true, result: response }));
      const header = Buffer.alloc(4); header.writeUInt32BE(output.length);
      socket.end(Buffer.concat([header, output]));
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const panels = new Panels(join(home, "panels.sqlite"));
  cleanups.push(async () => {
    panels[Symbol.dispose]();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const messages: Record<string, unknown>[] = [], callbacks: Record<string, unknown>[] = [];
  const controller = new Controller(panels, async (method, path, body) => {
    if (method === "PATCH") { messages.push(object(body)); return { id: "77777" }; }
    if (path.endsWith("/callback")) callbacks.push(object(body));
    return undefined;
  });
  let sequence = 10000;
  const event = (data: unknown, actor = "11111", type = 3) => ({
    id: String(sequence++), application_id: "88888",
    ...(dm ? { user: { id: actor }, channel: { id: "44444", type: 1 } } :
      { guild_id: "99999", channel_id: "44444", member: { user: { id: actor } } }),
    token: "offline-token", type, message: { id: "77777" }, data,
  });
  const invoke = (name = "list", options: readonly unknown[] = []) => controller.handle(event({
    name: "conversations", options: [{ type: 1, name, options }],
  }, "11111", 2));
  const last = () => {
    const message = messages.at(-1);
    if (!message) throw new Error("No panel rendered");
    return message;
  };
  const custom = (verb: string): string => {
    const rows = last().components;
    if (!Array.isArray(rows)) throw new Error("Missing panel rows");
    for (const row of rows) {
      const children = object(row).components;
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        const id = object(child).custom_id;
        if (typeof id === "string" && id.endsWith(`:${verb}`)) return id;
      }
    }
    throw new Error(`Missing ${verb} control`);
  };
  const click = (verb: string, values: readonly string[] = [], actor = "11111") =>
    controller.handle(event({ custom_id: custom(verb), component_type: 3, values }, actor));
  return { controller, panels, event, invoke, click, custom, last, messages, callbacks,
    path: join(home, "panels.sqlite"), failReadsAfterMutation: () => { readFailure = true; },
    setRecords: (value: AdminRecord[]) => { records = value; },
    records: () => records, revoke: () => { trusted = ""; }, mutations: () => mutations,
    configurationChanges: () => configurationChanges,
    loseMutationResponse: (value = true) => { uncertain = value; },
    settleOperation: (status: "done" | "refused" = "done") => { settled = status; }, probes: () => probes,
    refuseMutation: (value: boolean) => { refusal = value; }, submissions: () => submissions,
    corruptMutationResponse: () => { malformed = true; },
    requests: () => requests,
    setUnavailable: (source: "policy" | "runtime" | undefined) => { unavailable = source; } };
}

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
  const clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(1201);
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

test.each([false, true])("autocomplete bounds choices and returns no records after revocation; DM=%s", async dm => {
  const f = await fixture(dm);
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
