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

export type Rest = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export class DiscordRestError extends Error {
  constructor(readonly status: number, method: string, path: string, body: string) {
    super(`${method} ${path} -> ${status} ${body}`);
    this.name = "DiscordRestError";
  }
}

/** Within one short-lived command, reuse channel and bot-identity reads; writes and message fetches are never cached. */
export function cachedReads(rest: Rest): Rest {
  const cache = new Map<string, Promise<unknown>>();
  return <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const cacheable = (init?.method ?? "GET") === "GET" && init?.body === undefined &&
      (path === "/users/@me" || /^\/channels\/[0-9]+$/.test(path));
    if (!cacheable) return rest<T>(path, init);
    let hit = cache.get(path);
    if (!hit) { hit = rest<T>(path); cache.set(path, hit); }
    return hit as Promise<T>;
  };
}

export function discordRest(token: string): Rest {
  return async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const method = init.method ?? "GET";
    for (;;) {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (res.status === 429) {
        const { retry_after } = (await res.json()) as { retry_after: number };
        await Bun.sleep(Math.ceil(retry_after * 1000));
        continue;
      }
      if (!res.ok) throw new DiscordRestError(res.status, method, path, await res.text());
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
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
      onSkip(id, err);
    }
  }
  return out;
}
