import { CommandPublisher } from "../../discord-inbound/admin/command-sync.ts";
import { commands, dmCommands } from "../../discord-inbound/admin/manifest.ts";
import { DiscordTransport } from "../../discord-inbound/admin/transport.ts";

const home = process.env.HELIO_ADMIN_STATE_DIR;
if (!home) throw new Error("Missing fixture state directory");
using transport = new DiscordTransport("fixture", true);
transport.rest.options.makeRequest = async url => Response.json(new URL(String(url)).pathname.includes("/guilds/") ?
  commands : dmCommands([0, 1]));
using publisher = new CommandPublisher({ rest: transport.rest, stateDirectory: home,
  guild: async () => "99999999999999999", onEvent: event => {
    if (event.kind === "result") console.log("SYNC_DONE");
  } });
const application = { id: "88888888888888888", integration_types_config: { "0": {}, "1": {} } };
process.on("SIGHUP", () => { void publisher.request(application); });
await publisher.request(application);
await new Promise<never>(() => {});
