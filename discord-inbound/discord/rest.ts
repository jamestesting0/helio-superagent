import { insideAllowed } from "../intake/filter.ts";
import { policyValues, runtimePolicy } from "../intake/runtime-policy.ts";
import { setTimeout as sleep } from "node:timers/promises";

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

export interface RestInit {
  readonly method?: string;
  readonly body?: unknown;
  readonly retryRateLimit?: boolean;
  readonly signal?: AbortSignal;
}
export type Rest = <T>(path: string, init?: RestInit) => Promise<T>;

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) { await Bun.sleep(milliseconds); return; }
  try { await sleep(milliseconds, undefined, { signal }); }
  catch (error) { signal.throwIfAborted(); throw error; }
}

export class DiscordRestError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, method: string, path: string, body: string) {
    super(`${method} ${path} -> ${status} ${body}`);
    this.name = "DiscordRestError";
    this.retryable = [429, 500, 502, 503, 504].includes(status);
  }
}

export class DiscordTransportError extends Error {
  constructor(readonly code: string, method: string, path: string, cause: Error) {
    super(`${method} ${path} -> transport ${code}`, { cause });
    this.name = "DiscordTransportError";
  }
}

export class IgnoredChannelError extends Error {
  constructor(readonly channelId: string) {
    super(`Channel ${channelId} is ignored by current channel policy`);
    this.name = "IgnoredChannelError";
  }
}

export class PolicyChangedError extends RangeError {
  constructor(channelId: string) {
    super(`Privacy policy changed while reading channel ${channelId}; retained pending`);
    this.name = "PolicyChangedError";
  }
}

/** Within one short-lived command, reuse channel and bot-identity reads; writes and message fetches are never cached. */
export function cachedReads(rest: Rest): Rest {
  const cache = new Map<string, Promise<unknown>>();
  return <T>(path: string, init?: RestInit): Promise<T> => {
    init?.signal?.throwIfAborted();
    const cacheable = (init?.method ?? "GET") === "GET" && init?.body === undefined &&
      (path === "/users/@me" || /^\/channels\/[0-9]+$/.test(path));
    if (!cacheable) return rest<T>(path, init);
    let hit = cache.get(path);
    if (!hit) { hit = rest<T>(path, init); cache.set(path, hit); }
    return hit as Promise<T>;
  };
}

export function discordRest(token: string, options: { readonly allowIgnoredMetadata?: boolean; readonly metadataActor?: string } = {}): Rest {
  const raw: Rest = async <T>(path: string, init: RestInit = {}): Promise<T> => {
    const method = init.method ?? "GET";
    const revision = runtimePolicy()?.revision;
    let deadline = Date.now() + 15_000;
    for (let attempt = 1; ; attempt++) {
      init.signal?.throwIfAborted();
      const ignored = new Set((policyValues().DORI_DISCORD_IGNORED_CHANNELS ?? "").split(",").map(id => id.trim()).filter(Boolean));
      if ([...ignored].some(id => !/^\d+$/.test(id))) throw new TypeError("Invalid DORI_DISCORD_IGNORED_CHANNELS");
      const channel = /^\/channels\/([0-9]+)(?:\/|$)/.exec(path)?.[1];
      const metadata = channel !== undefined && method === "GET" && path === `/channels/${channel}`;
      const membership = channel !== undefined && options.metadataActor !== undefined && method === "GET" &&
        path === `/channels/${channel}/thread-members/${options.metadataActor}`;
      if (channel && ignored.size && !(options.allowIgnoredMetadata && (metadata || membership))) {
        if (ignored.has(channel)) throw new IgnoredChannelError(channel);
        if (!metadata && await insideAllowed(channel, ignored,
          async id => (await raw<ApiChannel>(`/channels/${id}`, { signal: init.signal })).parent_id ?? undefined)) {
          throw new IgnoredChannelError(channel);
        }
      }
      init.signal?.throwIfAborted();
      if (method === "GET" && channel && runtimePolicy()?.revision !== revision) {
        throw new PolicyChangedError(channel);
      }
      try {
        const timeout = AbortSignal.timeout(method === "GET" ? Math.max(1, deadline - Date.now()) : 15_000);
        const res = await fetch(`${API}${path}`, {
          method, signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
          headers: { Authorization: `Bot ${token}`, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
          body: init.body instanceof FormData ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        if (res.status === 429 && init.retryRateLimit !== false) {
          const { retry_after } = (await res.json()) as { retry_after: number };
          if (attempt >= 3 || !Number.isFinite(retry_after) || retry_after < 0) {
            throw new DiscordRestError(429, method, path, "rate limit could not be resolved");
          }
          const paused = Date.now();
          await wait(Math.ceil(retry_after * 1000), init.signal);
          deadline += Date.now() - paused;
          continue;
        }
        if (!res.ok) throw new DiscordRestError(res.status, method, path, await res.text());
        if (res.status === 204) return undefined as T;
        const result = (await res.json()) as T;
        init.signal?.throwIfAborted();
        if (method === "GET" && channel && runtimePolicy()?.revision !== revision) {
          throw new PolicyChangedError(channel);
        }
        return result;
      } catch (error) {
        init.signal?.throwIfAborted();
        if (method !== "GET" || !(error instanceof Error)) throw error;
        let failure: DiscordRestError | DiscordTransportError;
        if (error instanceof DiscordRestError && error.status !== 429 && error.retryable) {
          failure = error;
        } else {
          const detail = "code" in error ? error : error.cause instanceof Error ? error.cause : error;
          const code = "code" in detail && typeof detail.code === "string" ? detail.code : error.name;
          if (!["EAI_AGAIN", "DNS_EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
            "ConnectionRefused", "ConnectionClosed", "TimeoutError"].includes(code)) throw error;
          failure = new DiscordTransportError(code, method, path, error);
        }
        const delay = 250 * 4 ** (attempt - 1);
        if (attempt >= 3 || Date.now() + delay >= deadline) throw failure;
        await wait(delay, init.signal);
      }
    }
  };
  return raw;
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
