import { mock } from "bun:test";
import { mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { DiscordTransport as ActualTransport } from "../transport.ts";

const directory = process.env.HELIO_ADMIN_STATE_DIR;
const invalidCredentials = process.env.HELIO_ADMIN_FIXTURE_MODE === "invalid-credentials";
if (!directory) throw new Error("Missing fixture directory");
mkdirSync(directory, { recursive: true });
let interaction: ((value: unknown) => void) | undefined;
let sent = false;
const deadline = setTimeout(() => { console.error("Callback did not bypass the metadata rate limit"); process.exit(1); }, 5000);
const observer = watch(directory, (_event, name) => {
  if (name !== "commands.json" || sent) return;
  const receipt = JSON.parse(readFileSync(join(directory, "commands.json"), "utf8"));
  if (receipt.dm.problem !== "rate_limit") return;
  sent = true;
  interaction?.({ type: 3, id: "12345", application_id: "88888888888888888", token: "fixture-interaction",
    channel_id: "33333", user: { id: "11111" }, message: { id: "44444" },
    data: { custom_id: "ha1:aaaaaaaaaaaaaaaaaaaaaaaa:1:close", component_type: 2 } });
});

mock.module("agent-messenger/discordbot", () => ({
  DiscordIntent: { Guilds: 1 },
  DiscordBotClient: class {
    async login() {
      if (invalidCredentials) throw new Error("Invalid credentials must stop before Gateway login");
      return this;
    }
  },
  DiscordBotListener: class {
    on(event: string, callback: (value: unknown) => void) { if (event === "interaction_create") interaction = callback; }
    async start() {}
    stop() {}
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
        return Response.json({ message: "Rate limited", retry_after: 120, global: true }, { status: 429,
          headers: { "retry-after": "120", "x-ratelimit-reset-after": "120", "x-ratelimit-global": "true" } });
      };
    }
  },
}));
