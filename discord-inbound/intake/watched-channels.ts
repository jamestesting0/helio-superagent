import { discoverArchivedThreads } from "./archived-threads.ts";
import type { FilterConfig } from "./filter.ts";
import { expandChannels, MESSAGE_CHANNEL_TYPES, THREAD_PARENT_TYPES, type ApiChannel, type Rest } from "../discord/rest.ts";

interface Watched {
  readonly id: string;
  readonly guildId?: string;
}

export async function watchedChannels(
  cfg: FilterConfig, rest: Rest, warn: (message: string) => void,
): Promise<Watched[]> {
  const parentsByGuild = new Map<string, Map<string, number>>();
  const skip = (id: string, err: unknown) => warn(`channel ${id} skipped for catch-up: ${String(err)}`);
  const authorizedParents = await expandChannels(rest, cfg.allowed, new Set([...THREAD_PARENT_TYPES, 10, 11, 12]), skip);
  for (const channel of authorizedParents) {
    let parents = parentsByGuild.get(channel.guild_id);
    if (!parents) {
      parents = new Map();
      parentsByGuild.set(channel.guild_id, parents);
    }
    parents.set(channel.id, channel.type);
  }
  const watched: Watched[] = [];
  for (const [guildId, parents] of parentsByGuild) {
    for (const [id, type] of parents) {
      if (MESSAGE_CHANNEL_TYPES.has(type) || type === 10 || type === 11 || type === 12) watched.push({ id, guildId });
    }
    try {
      const { threads } = await rest<{ threads: ApiChannel[] }>(`/guilds/${guildId}/threads/active`);
      for (const thread of threads) {
        if (thread.parent_id && parents.has(thread.parent_id)) watched.push({ id: thread.id, guildId });
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      warn(`active threads in server ${guildId} skipped for catch-up: ${error.message}`);
    }
  }
  for (const thread of await discoverArchivedThreads(rest, authorizedParents, {
    now: Date.now(),
    onError: (parentId, path, error) => warn(`archived threads skipped parent=${parentId} path=${path}: ${error.message}`),
  })) {
    watched.push({ id: thread.id, guildId: thread.guild_id });
  }
  for (const userId of new Set([cfg.ownerId, ...(cfg.trustedIds ?? [])])) {
    try {
      const dm = await rest<{ id: string }>("/users/@me/channels", { method: "POST", body: { recipient_id: userId } });
      watched.push({ id: dm.id });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      warn(`DM catch-up skipped for ${userId}: ${error.message}`);
    }
  }
  return [...new Map(watched.map((channel) => [channel.id, channel])).values()];
}
