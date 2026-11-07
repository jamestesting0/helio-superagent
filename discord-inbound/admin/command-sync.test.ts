import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandPublisher } from "./command-sync.ts";
import { readCommandSync } from "./command-sync-state.ts";
import { commands, dmCommands } from "./manifest.ts";
import { DiscordTransport } from "./transport.ts";
import { object } from "./protocol.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const application = { id: "88888888888888888", integration_types_config: { "0": {}, "1": {} } };

test.each(["dm", "guild"] as const)("a %s refusal preserves the other verified scope without command writes", async denied => {
  const home = mkdtempSync(join(tmpdir(), "helio-command-sync-")); homes.push(home);
  using transport = new DiscordTransport("fixture", true);
  let writes = 0;
  transport.rest.options.makeRequest = async (url, init) => {
    if (init.method !== "GET") writes++;
    const guild = new URL(String(url)).pathname.includes("/guilds/");
    return (guild ? denied === "guild" : denied === "dm") ?
      Response.json({ message: "Missing Access", code: 50001 }, { status: 403 }) :
      Response.json((guild ? commands : dmCommands([0, 1])).map(command => ({ ...command, id: command.name })));
  };
  using publisher = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
    guild: async () => "99999999999999999", onEvent: () => {} });
  await publisher.request(application);
  const receipt = readCommandSync(join(home, "commands.json"));
  const healthy = denied === "dm" ? "guild" : "dm";
  expect(receipt?.[healthy].state).toBe("verified");
  expect(receipt?.[healthy].changes?.unchanged).toBe(9);
  expect(receipt?.[denied].state).toBe("denied");
  expect(receipt?.[denied].retryAt).toBeUndefined();
  expect(writes).toBe(0);
});

test("an empty installation registers both catalogs without requiring preexisting commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-command-sync-")); homes.push(home);
  using transport = new DiscordTransport("fixture", true);
  const global = new Map<string, Record<string, unknown>>(), guild = new Map<string, Record<string, unknown>>();
  transport.rest.options.makeRequest = async (url, init) => {
    const store = new URL(String(url)).pathname.includes("/guilds/") ? guild : global;
    if (init.method === "POST") {
      const row = object(JSON.parse(String(init.body)));
      store.set(String(row.name), { ...row, id: String(row.name) });
      return Response.json(row);
    }
    return Response.json([...store.values()]);
  };
  using publisher = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
    guild: async () => "99999999999999999", onEvent: () => {} });
  await publisher.request(application);
  expect([...global.keys()].sort()).toEqual(commands.map(command => command.name).sort());
  expect([...guild.keys()].sort()).toEqual(commands.map(command => command.name).sort());
  expect(readCommandSync(join(home, "commands.json"))?.guild.changes?.created).toBe(9);
});

test("overlapping lifecycle requests coalesce and complete without competing writes", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-command-sync-")); homes.push(home);
  using transport = new DiscordTransport("fixture", true);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let applicationReads = 0, catalogReads = 0;
  transport.rest.options.makeRequest = async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/applications/@me")) { applicationReads++; return Response.json(application); }
    catalogReads++;
    if (catalogReads === 1) { entered.resolve(); await release.promise; }
    return Response.json(path.includes("/guilds/") ? commands : dmCommands([0, 1]));
  };
  using publisher = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
    guild: async () => "99999999999999999", onEvent: () => {} });
  const first = publisher.request(application);
  await entered.promise;
  const pending = Array.from({ length: 20 }, () => publisher.request());
  release.resolve();
  await Promise.all([first, ...pending]);
  expect(catalogReads).toBe(4);
  expect(applicationReads).toBe(1);
  expect(readCommandSync(join(home, "commands.json"))?.dm.state).toBe("verified");
});

test("a partial lost response is recovered from Discord after restart without recreating accepted commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-command-sync-")); homes.push(home);
  using transport = new DiscordTransport("fixture", true);
  const stored = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, number>();
  let interrupt = true;
  transport.rest.options.makeRequest = async (url, init) => {
    if (new URL(String(url)).pathname.includes("/guilds/")) return Response.json(commands);
    if (init.method === "POST") {
      const row = object(JSON.parse(String(init.body)));
      const name = String(row.name);
      attempts.set(name, (attempts.get(name) ?? 0) + 1);
      stored.set(name, { ...row, id: name });
      if (name === "lanes" && interrupt) {
        interrupt = false;
        return Response.json({ message: "Response lost after acceptance" }, { status: 503 });
      }
      return Response.json(row);
    }
    return Response.json([...stored.values()]);
  };
  {
    using first = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
      guild: async () => "99999999999999999", onEvent: () => {} });
    await first.request(application);
  }
  const interrupted = readCommandSync(join(home, "commands.json"));
  expect(interrupted?.dm.state).toBe("retrying");
  expect(interrupted?.dm.changes?.created).toBe(2);
  expect(stored.size).toBe(3);
  const retryAt = interrupted?.dm.retryAt;
  if (retryAt === undefined) throw new Error("Missing recovery deadline");
  const clock = spyOn(Date, "now").mockReturnValue(retryAt + 1);
  try {
    using restarted = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
      guild: async () => "99999999999999999", onEvent: () => {} });
    await restarted.request(application);
    expect(stored.size).toBe(9);
    expect(attempts.get("status")).toBe(1);
    expect(attempts.get("lanes")).toBe(1);
    expect(readCommandSync(join(home, "commands.json"))?.dm.state).toBe("verified");
  } finally { clock.mockRestore(); }
});

test("a global rate limit survives restart and lifecycle requests cannot bypass its deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-command-sync-")); homes.push(home);
  using transport = new DiscordTransport("fixture", true);
  let requests = 0;
  transport.rest.options.makeRequest = async () => {
    requests++;
    return Response.json({ message: "Rate limited", retry_after: 120, global: true }, { status: 429,
      headers: { "retry-after": "120", "x-ratelimit-reset-after": "120", "x-ratelimit-global": "true" } });
  };
  {
    using first = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
      guild: async () => "99999999999999999", onEvent: () => {} });
    await first.request();
  }
  const observed = readCommandSync(join(home, "commands.json"));
  expect(observed?.dm.problem).toBe("rate_limit");
  expect(observed?.globalRetryAt).toBeGreaterThan(Date.now() + 100_000);
  using restarted = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
    guild: async () => "99999999999999999", onEvent: () => {} });
  await restarted.request();
  await restarted.request();
  expect(requests).toBe(1);
});

test("invalid credentials are reported without a scheduled authentication loop", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-command-sync-")); homes.push(home);
  using transport = new DiscordTransport("fixture", true);
  let requests = 0, applications = 0;
  transport.rest.options.makeRequest = async () => {
    requests++;
    return Response.json({ message: "Unauthorized", code: 0 }, { status: 401 });
  };
  using publisher = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
    guild: async () => "99999999999999999", onEvent: event => { if (event.kind === "application") applications++; } });
  await publisher.request();
  const receipt = readCommandSync(join(home, "commands.json"));
  expect(receipt?.dm.problem).toBe("credentials");
  expect(receipt?.guild.problem).toBe("credentials");
  expect(receipt?.dm.retryAt).toBeUndefined();
  expect(applications).toBe(0);
  expect(requests).toBe(1);
});
