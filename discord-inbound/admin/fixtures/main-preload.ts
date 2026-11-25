import { mock } from "bun:test";
import { mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { BrokerRefusal } from "../broker.ts";
import { DiscordTransport as ActualTransport } from "../transport.ts";

const directory = process.env.HELIO_ADMIN_STATE_DIR;
const invalidCredentials = process.env.HELIO_ADMIN_FIXTURE_MODE === "invalid-credentials";
const sleeping = process.env.HELIO_ADMIN_FIXTURE_MODE === "sleeping";
if (!directory) throw new Error("Missing fixture directory");
mkdirSync(directory, { recursive: true });
let interaction: ((value: unknown) => void) | undefined;
let connected: ((value: unknown) => void) | undefined;
let messageCreate: ((value: unknown) => void) | undefined;
let sent = false;
const deadline = setTimeout(() => { console.error("Callback did not bypass the metadata rate limit"); process.exit(1); }, 5000);
const observer = watch(directory, (_event, name) => {
  if (name !== "commands.json" || sent) return;
  const receipt = JSON.parse(readFileSync(join(directory, "commands.json"), "utf8"));
  if (receipt.dm.problem !== "rate_limit") return;
  sent = true;
  if (sleeping) {
    connected?.({ user: { id: "88888888888888888" } });
    messageCreate?.({ id: "55555", type: "MESSAGE_CREATE", message_type: 0, channel_id: "33333",
      author: { id: "11111", username: "trusted" }, content: "Hi Helio", timestamp: "2026-11-25T12:00:00Z" });
    return;
  }
  interaction?.({ type: 3, id: "12345", application_id: "88888888888888888", token: "fixture-interaction",
    channel_id: "33333", user: { id: "11111" }, message: { id: "44444" },
    data: { custom_id: "ha1:aaaaaaaaaaaaaaaaaaaaaaaa:1:close", component_type: 2 } });
});

mock.module("agent-messenger/discordbot", () => ({
  DiscordIntent: { Guilds: 1, GuildMessages: 512, DirectMessages: 4096, MessageContent: 32768 },
  DiscordBotClient: class {
    async login() {
      if (invalidCredentials) throw new Error("Invalid credentials must stop before Gateway login");
      return this;
    }
  },
  DiscordBotListener: class {
    constructor(_client: unknown, options: { intents: number }) {
      if (sleeping && (options.intents & 4096) === 0) throw new Error("DM message intent is missing");
    }
    on(event: string, callback: (value: unknown) => void) {
      if (event === "interaction_create") interaction = callback;
      if (event === "connected") connected = callback;
      if (event === "message_create") messageCreate = callback;
    }
    async start() {}
    stop() {}
  },
}));

if (sleeping) mock.module(join(import.meta.dir, "../broker.ts"), () => ({
  BrokerRefusal,
  broker: async (request: { kind: string }) => {
    if (request.kind === "policy") return { version: 1, revision: "a".repeat(64), timing: [], values: {
      HELIO_ADMIN_GUILD: "22222", DORI_DISCORD_OWNER_ID: "44444", HELIO_TRUSTED_USERS: "11111", DORI_DISCORD_IGNORED_CHANNELS: "",
    } };
    if (request.kind === "sleep-reaction") return true;
    throw new Error("Unexpected broker request");
  },
}));

mock.module(join(import.meta.dir, "../transport.ts"), () => ({
  DiscordTransport: class extends ActualTransport {
    constructor(token: string, metadata = false) {
      super(token, metadata);
      this.rest.options.makeRequest = async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/applications/@me")) {
          if (invalidCredentials) return Response.json({ message: "Unauthorized" }, { status: 401 });
          return Response.json({ id: "88888888888888888", integration_types_config: { "0": {}, "1": {} } });
        }
        if (path.includes("/interactions/")) {
          const body = JSON.parse(String(options.body));
          if (body.type !== 4 || body.data?.flags !== 64) throw new Error("Invalid private interaction response");
          console.log("RESPONSIVE_CALLBACK " + JSON.stringify(body));
          clearTimeout(deadline);
          observer.close();
          process.exit(0);
        }
        if (sleeping && options.method === "PUT" && decodeURIComponent(path).endsWith("/channels/33333/messages/55555/reactions/😴/@me")) {
          console.log("SLEEP_REACTION_SENT");
          clearTimeout(deadline);
          observer.close();
          process.exit(0);
        }
        return Response.json({ message: "Rate limited", retry_after: 120, global: true }, { status: 429,
          headers: { "retry-after": "120", "x-ratelimit-reset-after": "120", "x-ratelimit-global": "true" } });
      };
    }
  },
}));
