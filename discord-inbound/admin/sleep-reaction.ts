import type { DiscordGatewayMessageCreateEvent } from "agent-messenger/discordbot";
import { sleepingReactionRoute } from "../discord/rest.ts";
import { addressingFacts, guildChannelAllowed, requestMessage, type ChannelLookup } from "../intake/filter.ts";
import type { broker } from "./broker.ts";
import { AdminError, object, policy } from "./protocol.ts";
import { CallError, type Call } from "./transport.ts";

export async function reactWhileSleeping(message: DiscordGatewayMessageCreateEvent, botId: string, call: Call,
  request: typeof broker): Promise<void> {
  const { author, guild_id: guild, channel_id: channel, id } = message;
  if (author.bot || author.id === botId || "webhook_id" in message || !requestMessage({ type: message.message_type })) return;
  if (![author.id, channel, id].every(value => /^\d{1,30}$/.test(value))) return;
  if (guild !== undefined && (!message.mentions?.some(user => user.id === botId) ||
    !addressingFacts({ content: message.content }).text_mention_ids.includes(botId))) return;

  try {
    const { values, revision } = policy(await request({ kind: "policy" }, 1000));
    const owner = values.DORI_DISCORD_OWNER_ID;
    const trusted = values.HELIO_TRUSTED_USERS.split(",");
    const ignoredChannels = new Set(values.DORI_DISCORD_IGNORED_CHANNELS.split(",").filter(Boolean));
    if (ignoredChannels.has(channel)) return;
    if (guild === undefined) {
      if (author.id !== owner && !trusted.includes(author.id)) return;
    } else {
      const channels = new Map<string, ReturnType<ChannelLookup>>();
      const lookup: ChannelLookup = id => {
        const cached = channels.get(id);
        if (cached) return cached;
        const pending = (async () => {
          const info = object(await call("GET", `/channels/${id}`));
          if (info.id !== id || info.guild_id !== guild || typeof info.type !== "number" ||
            (info.parent_id != null && (typeof info.parent_id !== "string" || !/^\d{1,30}$/.test(info.parent_id)))) {
            throw new AdminError("invalid", "Discord channel ancestry is unavailable");
          }
          return { type: info.type, parent_id: typeof info.parent_id === "string" ? info.parent_id : null };
        })();
        channels.set(id, pending);
        return pending;
      };
      if (!await guildChannelAllowed(channel, { ownerId: owner, ignoredChannels,
        allowed: new Set(values.DORI_DISCORD_ALLOWED.split(",").filter(Boolean)),
        ...(values.DORI_DISCORD_SCOPE_CATEGORY ? { scopeCategory: values.DORI_DISCORD_SCOPE_CATEGORY } : {}),
      }, lookup)) return;
    }
    if (await request({ kind: "sleep-reaction", author: author.id, revision }, 8000) !== true) return;
    await call("PUT", sleepingReactionRoute(channel, id));
  } catch (error) {
    if (error instanceof CallError && (error.status === 403 || error.status === 404 || error.status === 429)) return;
    throw error;
  }
}
