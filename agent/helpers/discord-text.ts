// `dori send discord` text hook (config.json `discordTextHook`): links the names intake knows, as reply.ts does.
import { join } from "node:path";
import { discordText } from "./vendor/dori-mode/scripts/src/messenger/discord.ts";

export async function formatDiscordText(text: string): Promise<string> {
  const state = process.env.DORI_STATE_DIR;
  if (!state) return text;
  const [{ Delivery }, { personReferences }] = await Promise.all([
    import("../discord-inbound/delivery/delivery.ts"), import("../discord-inbound/messages/references.ts"),
  ]);
  const delivery = new Delivery(join(state, "discord-delivery.sqlite"));
  try { return personReferences(text, delivery.people.known(), linked => discordText(linked).length <= 2000); }
  finally { delivery.close(); }
}
