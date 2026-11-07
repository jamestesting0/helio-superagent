import { insideAllowed } from "../intake/filter.ts";
import { policyValues } from "../intake/runtime-policy.ts";

const API = "https://discord.com/api/v10";

export interface ApiChannel {
  id: string;
  type: number;
  name?: string;
  guild_id: string;
  parent_id?: string | null;
}

export const CATEGORY = 4;
export const MESSAGE_CHANNEL_TYPES = new Set([0, 5]);
export const THREAD_PARENT_TYPES = new Set([0, 5, 15]);

export type Rest = <T>(path: string, init?: { method?: string; body?: unknown; retryRateLimit?: boolean }) => Promise<T>;

export class DiscordRestError extends Error {
  constructor(readonly status: number, method: string, path: string, body: string) {
    super(`${method} ${path} -> ${status} ${body}`);
    this.name = "DiscordRestError";
  }
}

export class IgnoredChannelError extends Error {
  constructor(readonly channelId: string) {
    super(`Channel ${channelId} is ignored by current channel policy`);
    this.name = "IgnoredChannelError";
  }
}

/** Within one short-lived command, reuse channel and bot-identity reads; writes and message fetches are never cached. */
export function cachedReads(rest: Rest): Rest {
  const cache = new Map<string, Promise<unknown>>();
  return <T>(path: string, init?: { method?: string; body?: unknown; retryRateLimit?: boolean }): Promise<T> => {
    const cacheable = (init?.method ?? "GET") === "GET" && init?.body === undefined &&
      (path === "/users/@me" || /^\/channels\/[0-9]+$/.test(path));
    if (!cacheable) return rest<T>(path, init);
    let hit = cache.get(path);
    if (!hit) { hit = rest<T>(path); cache.set(path, hit); }
    return hit as Promise<T>;
  };
}

export function discordRest(token: string, options: { readonly allowIgnoredMetadata?: boolean; readonly metadataActor?: string } = {}): Rest {
  const raw: Rest = async <T>(path: string, init: { method?: string; body?: unknown; retryRateLimit?: boolean } = {}): Promise<T> => {
    const method = init.method ?? "GET";
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${API}${path}`, {
        method, signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bot ${token}`, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
        body: init.body instanceof FormData ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (res.status === 429 && init.retryRateLimit !== false) {
        const { retry_after } = (await res.json()) as { retry_after: number };
        if (attempt >= 3 || !Number.isFinite(retry_after) || retry_after < 0) {
          throw new DiscordRestError(429, method, path, "rate limit could not be resolved");
        }
        await Bun.sleep(Math.ceil(retry_after * 1000));
        continue;
      }
      if (!res.ok) throw new DiscordRestError(res.status, method, path, await res.text());
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  };
  return async <T>(path: string, init?: { method?: string; body?: unknown; retryRateLimit?: boolean }): Promise<T> => {
    const ignored = new Set((policyValues().DORI_DISCORD_IGNORED_CHANNELS ?? "").split(",").map(id => id.trim()).filter(Boolean));
    if ([...ignored].some(id => !/^\d+$/.test(id))) throw new TypeError("Invalid DORI_DISCORD_IGNORED_CHANNELS");
    const channel = /^\/channels\/([0-9]+)(?:\/|$)/.exec(path)?.[1];
    const metadata = channel !== undefined && (init?.method ?? "GET") === "GET" && path === `/channels/${channel}`;
    const membership = channel !== undefined && options.metadataActor !== undefined && (init?.method ?? "GET") === "GET" &&
      path === `/channels/${channel}/thread-members/${options.metadataActor}`;
    if (channel && ignored.size && !(options.allowIgnoredMetadata && (metadata || membership))) {
      if (ignored.has(channel)) throw new IgnoredChannelError(channel);
      if (!metadata && await insideAllowed(channel, ignored,
        async id => (await raw<ApiChannel>(`/channels/${id}`)).parent_id ?? undefined)) {
        throw new IgnoredChannelError(channel);
      }
    }
    return raw<T>(path, init);
  };
}

export async function expandChannels(
  rest: Rest,
  ids: Iterable<string>,
  types: ReadonlySet<number>,
  onSkip: (id: string, err: unknown) => void,
): Promise<ApiChannel[]> {
  const out: ApiChannel[] = [];
  for (const id of ids) {
    try {
      const channel = await rest<ApiChannel>(`/channels/${id}`);
      if (channel.type !== CATEGORY) {
        if (types.has(channel.type)) out.push(channel);
        continue;
      }
      for (const child of await rest<ApiChannel[]>(`/guilds/${channel.guild_id}/channels`)) {
        if (child.parent_id === id && types.has(child.type)) out.push(child);
      }
    } catch (err) {
      if (err instanceof IgnoredChannelError) continue;
      onSkip(id, err);
    }
  }
  return out;
}
