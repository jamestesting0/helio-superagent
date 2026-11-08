import { onTestFinished, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeQuery } from "../protocol.ts";
const realFetch = globalThis.fetch;

export function fixture() {
  const initial = { HOME: process.env.HOME, DORI_POLICY_DIR: process.env.DORI_POLICY_DIR, DORI_STATE_DIR: process.env.DORI_STATE_DIR, DORI_DISCORD_TOKEN: process.env.DORI_DISCORD_TOKEN, PATH: process.env.PATH };
  const previousFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "helio-admin-runtime-"));
  onTestFinished(() => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(initial)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const state = join(home, "state"), directory = join(home, "policy");
  const scripts = join(home, ".dori/elobot/vendor/dori-mode/scripts");
  mkdirSync(scripts, { recursive: true });
  symlinkSync(new URL("../../../vendor/dori-mode/scripts/src", import.meta.url), join(scripts, "src"), "dir");
  mkdirSync(join(directory, "requests"), { recursive: true });
  process.env.HOME = home;
  process.env.DORI_POLICY_DIR = directory;
  process.env.DORI_STATE_DIR = state;
  process.env.DORI_DISCORD_TOKEN = "offline-fixture";
  const publish = (trusted = "11111", revision = "a".repeat(64), values: Readonly<Record<string, string>> = {}) => writeFileSync(join(directory, "policy.json"), JSON.stringify({
    version: 1, revision, values: {
      DORI_DISCORD_OWNER_ID: "22222", HELIO_ADMIN_GUILD: "99999", HELIO_TRUSTED_USERS: trusted,
      DORI_DISCORD_ALLOWED: "44444,55555", DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "44444,55555",
      DORI_DISCORD_IGNORED_CHANNELS: "", HELIO_REPORT_CHANNELS: "",
      HELIO_CONVERSATION_NUDGE_HOURS: "24", HELIO_CONVERSATION_TIMEOUT_HOURS: "72",
      ...values,
    }, timing: [{ key: "HELIO_CONVERSATION_TIMEOUT_HOURS", label: "Conversation timeout", unit: "hours", minimum: 1, maximum: 99999 }],
  }));
  publish();
  const proof = (query: RuntimeQuery, operation = "operation-one", actor = "11111") => {
    const nonce = "a".repeat(32);
    writeFileSync(join(directory, "requests", `${nonce}.json`), JSON.stringify({
      id: nonce, actor, guild: "99999", operation, policy_revision: "a".repeat(64),
      expires_at: Date.now() + 30_000, query,
    }));
    return nonce;
  };
  return { home, state, directory, publish, proof };
}

export function guildFixture(visible: boolean, privateThreadMember?: boolean): void {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    switch (path) {
      case "/users/33333":
        return Response.json({ id: "33333", username: "Offline fixture user" });
      case "/channels/44444":
        return Response.json({ id: "44444", guild_id: "99999", type: privateThreadMember === undefined ? 0 : 12,
          parent_id: privateThreadMember === undefined ? "88888" : "55555", name: "Incident room",
          permission_overwrites: visible ? [] : [{ id: "99999", type: 0, allow: "0", deny: "66560" }] });
      case "/channels/55555":
        return Response.json({ id: "55555", guild_id: "99999", type: 0, parent_id: "88888" });
      case "/channels/44444/thread-members/11111":
        return privateThreadMember ? Response.json({ user_id: "11111" }) : Response.json({ message: "Unknown member" }, { status: 404 });
      case "/channels/88888":
        return Response.json({ id: "88888", guild_id: "99999", type: 4, name: "Category" });
      case "/guilds/99999/members/11111":
      case "/guilds/99999/members/22222": return Response.json({ roles: [] });
      case "/guilds/99999/roles": return Response.json([{ id: "99999", permissions: "66560" }]);
      case "/guilds/99999": return Response.json({ owner_id: "22222" });
      default: throw new Error(`Unexpected offline request: ${path}`);
    }
  }, { preconnect: realFetch.preconnect }));
}

export function laneFixture(done?: string) {
  const f = fixture();
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  symlinkSync(new URL("../../../vendor/dori-mode/scripts/src/cli.ts", import.meta.url), join(bin, "dori"));
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`;
  writeFileSync(join(f.home, ".dori/elobot/config.json"), JSON.stringify({ stateDir: f.state, defaultCwd: f.home }));
  mkdirSync(join(f.state, "lanes"), { recursive: true });
  const path = join(f.state, "lanes/lane-one.json");
  writeFileSync(path, JSON.stringify({
    key: "lane-one", title: "Disposable lane", thread: "none", source: "discord:44444:66666",
    cwd: f.home, openedAt: new Date().toISOString(), status: "paused",
    done: done ?? `command ${JSON.stringify([process.execPath, "--eval", "process.exit(0)"])}`,
  }));
  guildFixture(true);
  return { ...f, path };
}
