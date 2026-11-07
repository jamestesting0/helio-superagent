import { DiscordBotClient, DiscordBotListener, DiscordIntent } from "agent-messenger/discordbot";
import { join } from "node:path";
import { broker } from "./broker.ts";
import { CommandPublisher } from "./command-sync.ts";
import { Controller } from "./controller.ts";
import { Panels } from "./panels.ts";
import { AdminError, policy } from "./protocol.ts";
import { DiscordTransport } from "./transport.ts";

if (process.argv[2] !== "serve") throw new AdminError("invalid", "Use admin/main.ts serve; lifecycle hooks own synchronization");
const token = process.env.DORI_DISCORD_TOKEN;
if (!token) { console.error("ADMIN_CONFIGURATION_ERROR missing_credentials"); process.exit(78); }
const state = process.env.HELIO_ADMIN_STATE_DIR ?? join(process.env.HOME ?? "", ".local/state/helio-admin");
using transport = new DiscordTransport(token);
using metadata = new DiscordTransport(token, true);
using panels = new Panels(join(state, "panels.sqlite"));
const controller = new Controller(panels, transport.call);
let listener: DiscordBotListener | undefined;
let expiring = false;

function fatal(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  console.error(`ADMIN_ERROR command_sync ${error.name}`);
  process.exit(error instanceof AdminError && error.code === "invalid" ? 78 : 1);
}

using publisher = new CommandPublisher({ rest: metadata.rest, stateDirectory: state,
  guild: async () => policy(await broker({ kind: "policy" }, 1000)).values.HELIO_ADMIN_GUILD,
  onEvent: async event => {
    switch (event.kind) {
      case "application": {
        if (event.application.interactions_endpoint_url) {
          console.error("ADMIN_CONFIGURATION_ERROR interactions_endpoint_configured");
          process.exit(78);
        }
        if (listener) return;
        const client = await new DiscordBotClient().login({ token });
        listener = new DiscordBotListener(client, { intents: DiscordIntent.Guilds });
        listener.on("interaction_create", raw => {
          void controller.handle(raw).catch(error => {
            if (!(error instanceof Error)) throw error;
            console.error(`ADMIN_ERROR ${error.name}`);
          });
        });
        listener.on("error", () => { console.error("ADMIN_ERROR gateway"); process.exit(1); });
        await listener.start();
        console.log("ADMIN_CONTROLLER_READY");
        return;
      }
      case "result":
        console.log(`ADMIN_COMMAND_SYNC ${JSON.stringify(event.receipt)}`);
        if (event.receipt.dm.problem === "credentials" || event.receipt.guild.problem === "credentials") process.exit(78);
        return;
      case "error":
        return fatal(event.error);
      default: {
        const unexpected: never = event;
        throw unexpected;
      }
    }
  } });

const synchronize = () => { void publisher.request().catch(fatal); };
process.on("SIGHUP", synchronize);
synchronize();
const timer = setInterval(() => {
  if (!listener || expiring) return;
  expiring = true;
  void controller.expire().catch(error => {
    if (!(error instanceof Error)) throw error;
    console.error(`ADMIN_ERROR expiry ${error.name}`);
  }).finally(() => { expiring = false; });
}, 15_000);
try { await new Promise<never>(() => {}); }
finally { clearInterval(timer); process.off("SIGHUP", synchronize); listener?.stop(); }
