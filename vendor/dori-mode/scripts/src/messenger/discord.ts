import type { Clock } from "../run.ts";
import { DEFAULT_RETRY, guardText, type Http, MessengerError, UnsafeMessageError, withBackoff } from "./http.ts";


/** Label GitHub references without previews; existing links and code remain intact. */
export function discordText(text: string): string {
  const safe = guardText(text);
  return safe.replace(/```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|^[ \t]*>>>[\s\S]*$|^[ \t]*>[^\n]*(?:\n|$)|\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)|<?https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*(?![\w-])(?:[/?#][^\s<>)]+)?>?/gim,
    token => {
      const url = token.replace(/^<|>$/g, "");
      const github = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/([1-9]\d*)/i.exec(url);
      if (!github || url.length > 500) return token;
      const suffix = /[.,!?;:]+$/.exec(url)?.[0] ?? "";
      const core = suffix ? url.slice(0, -suffix.length) : url;
      return `[${github[1]?.toLowerCase() === "pull" ? "PR" : "Issue"} #${github[2]}](<${core}>)${suffix}`;
    });
}

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>): Promise<T> {
    // A server error after a write can mean the message exists; only retry read-only requests automatically.
    const policy = method === "GET" ? DEFAULT_RETRY : { ...DEFAULT_RETRY, retryServerErrors: false };
    const res = await withBackoff(this.http, this.clock, { method, url: `${this.base}${path}`, timeoutMs: 30_000, headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, policy, retryAfter);
    if (res.status >= 300) throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  async openDm(userId: string): Promise<string> {
    return (await this.call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId })).id;
  }

  async send(channelId: string, content: string, ping: readonly string[] = []): Promise<string> {
    if (ping.some(id => !/^\d{1,30}$/.test(id)) || ping.length > 100) throw new UnsafeMessageError("Invalid Discord ping recipients");
    return (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, { content: discordText(content), allowed_mentions: { parse: [], ...(ping.length ? { users: [...new Set(ping)] } : {}) } })).id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: discordText(content) });
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    return (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, { name: guardText(name).slice(0, 100) })).id;
  }

  async setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void> {
    await this.call("PATCH", `/channels/${threadId}`, { ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
  }
}

export type GatewaySocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void };

export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;

export const discordPresence = (open: () => GatewaySocket, token: string, clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void }) => {
  const ws = open();
  let seq: number | null = null;
  let beat: unknown;
  ws.onMessage((raw) => {
    const m = JSON.parse(raw) as { op: number; s?: number | null; d?: { heartbeat_interval?: number } };
    if (typeof m.s === "number") seq = m.s;
    if (m.op === 10 && m.d?.heartbeat_interval) {
      beat = clock.setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token, intents: DISCORD_INTENTS_GUILD_MESSAGES, properties: { os: process.platform, browser: "dori", device: "dori" }, presence: { status: "online", since: null, activities: [], afk: false } } }));
    }
  });
  return {
    close() {
      if (beat !== undefined) clock.clearInterval(beat);
      ws.close();
    },
  };
};
