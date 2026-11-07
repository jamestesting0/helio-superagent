import { expect, test } from "bun:test";
import { registerCommand } from "./registration.ts";
import { commands } from "./manifest.ts";
import { DiscordTransport } from "./transport.ts";
import { object } from "./protocol.ts";

test("direct DM registration replaces only the legacy prefix and preserves unrelated commands", async () => {
  using transport = new DiscordTransport("fixture");
  const stored = new Map<string, Record<string, unknown>>([
    ["helio", { id: "11111111111111111", name: "helio", type: 1 }],
    ["unrelated", { id: "22222222222222222", name: "unrelated", type: 1 }],
    ["status-context", { id: "33333333333333333", name: "status", type: 2 }],
    ["helio-context", { id: "44444444444444444", name: "helio", type: 2 }],
  ]);
  transport.rest.options.makeRequest = async (url, init) => {
    const path = new URL(String(url)).pathname;
    expect(path).not.toContain("/guilds/");
    if (init.method === "POST") {
      const body = object(JSON.parse(String(init.body)));
      stored.set(String(body.name), { ...body, id: String(body.name) });
      return Response.json({ id: body.name });
    }
    if (init.method === "DELETE") {
      expect(path.endsWith("/11111111111111111")).toBe(true);
      stored.delete("helio");
      return new Response(null, { status: 204 });
    }
    return Response.json([...stored.values()]);
  };
  await registerCommand(transport.rest, { id: "88888888888888888", integration_types_config: { "0": {}, "1": {} } });
  expect([...stored.keys()].sort()).toEqual(["unrelated", "status-context", "helio-context", ...commands.map(command => command.name)].sort());
  for (const command of commands) {
    expect(stored.get(command.name)?.contexts).toEqual([1]);
    expect(stored.get(command.name)?.integration_types).toEqual([0, 1]);
  }
  const channels = stored.get("channels")?.options;
  if (!Array.isArray(channels)) throw new Error("Missing channel commands");
  const show = object(channels.find(value => object(value).name === "show")).options;
  if (!Array.isArray(show)) throw new Error("Missing channel input");
  expect(object(show[0])).toMatchObject({ name: "channel", type: 3, autocomplete: true });
});

test("a failed replacement does not delete the existing prefixed command", async () => {
  using transport = new DiscordTransport("fixture");
  let deleted = false;
  transport.rest.options.makeRequest = async (_url, init) => {
    deleted ||= init.method === "DELETE";
    if (init.method === "GET") return Response.json([{ id: "11111", name: "helio", type: 1 }]);
    return Response.json({ message: "Unavailable" }, { status: 503 });
  };
  await expect(registerCommand(transport.rest, { id: "88888888888888888" })).rejects.toBeInstanceOf(Error);
  expect(deleted).toBe(false);
});

test("an unchanged catalog makes no command writes despite API defaults and generated fields", async () => {
  using transport = new DiscordTransport("fixture");
  let writes = 0;
  const stored = commands.map(command => ({ ...command, id: command.name, version: "123",
    nsfw: false, name_localizations: null, description_localizations: {},
    options: command.options?.map(option => ({ ...option, required: option.required ?? false })) }));
  transport.rest.options.makeRequest = async (_url, init) => {
    if (init.method !== "GET") writes++;
    return Response.json(stored);
  };
  const result = await registerCommand(transport.rest, { id: "88888888888888888" }, { guild: "99999999999999999" });
  expect(writes).toBe(0);
  expect(result).toEqual({ created: 0, updated: 0, removed: 0, unchanged: 9 });
});

test("nested changes and removed optional settings patch only their owning command", async () => {
  using transport = new DiscordTransport("fixture");
  const stored = new Map(commands.map(command => [command.name, { ...command, id: command.name }]));
  const changed = object(stored.get("status"));
  const stale: Record<string, unknown> = { ...changed, nsfw: true, name_localizations: { de: "alt" },
    options: [{ type: 3, name: "dependency", description: "Stale choice", choices: [{ name: "Old", value: "old" }] }] };
  let updates = 0;
  transport.rest.options.makeRequest = async (url, init) => {
    if (init.method === "GET") return Response.json([...stored.values()].map(value => value.name === "status" ? stale : value));
    expect(init.method).toBe("PATCH");
    expect(new URL(String(url)).pathname.endsWith("/status")).toBe(true);
    Object.assign(stale, object(JSON.parse(String(init.body))));
    updates++;
    return Response.json(stale);
  };
  const result = await registerCommand(transport.rest, { id: "88888888888888888" }, { guild: "99999999999999999" });
  expect(updates).toBe(1);
  expect(stale.nsfw).toBe(false);
  expect(stale.name_localizations).toBeNull();
  expect(stale.options).toEqual(commands.find(command => command.name === "status")?.options);
  expect(result).toEqual({ created: 0, updated: 1, removed: 0, unchanged: 8 });
});

test("an incomplete readback cannot report success or remove the retired prefix", async () => {
  using transport = new DiscordTransport("fixture");
  let deleted = false;
  transport.rest.options.makeRequest = async (_url, init) => {
    if (init.method === "GET") return Response.json([{ id: "legacy", type: 1, name: "helio" }, ...commands.slice(1)]);
    deleted ||= init.method === "DELETE";
    return Response.json({ id: "accepted-but-not-observed" });
  };
  await expect(registerCommand(transport.rest, { id: "88888888888888888" }, { guild: "99999999999999999" })).rejects.toThrow();
  expect(deleted).toBe(false);
});
