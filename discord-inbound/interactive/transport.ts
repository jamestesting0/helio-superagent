import type { PromptStore, QuestionStore } from "./store.ts";
import { referenceLink } from "../messages/references.ts";
const API = "https://discord.com/api/v10";
const CUSTOM_ID = /^h1:(c|p|q|d|qm|pm):([0-9a-f]{20}):([a-z0-9]+)$/;
const VERBS: Record<string, readonly string[]> = {
  c: ["confirm", "cancel"], p: ["approve", "cancel", "suggest"], q: ["o0", "o1", "o2", "o3", "o4", "pick", "other"], d: ["submit", "cancel"], qm: ["other"], pm: ["suggest"],
};
const SNOWFLAKE = /^[0-9]{1,30}$/;
const RETRY_FAILED_EDIT_MS = 10 * 60_000;
const MESSAGE = 4, EPHEMERAL = 64;

export class CallError extends Error {
  /** `status` is undefined when Discord's answer is unknown (timeout or network failure). */
  constructor(readonly status: number | undefined, message: string) { super(message); this.name = "CallError"; }
}
export type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

export function discordCall(token: string, timeoutMs = 2800): Call {
  return async (method, path, body) => {
    const safePath = path.replace(/(\/(?:interactions|webhooks)\/[^/]+\/)[^/?]+/, "$1[redacted]");
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${API}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch {
      // Response headers alone cannot prove whether Discord accepted a callback.
      throw new CallError(undefined, `${method} ${safePath}: response unavailable`);
    }
    if (!res.ok) throw new CallError(res.status, `${method} ${safePath} -> ${res.status}`);
    try { return text ? JSON.parse(text) : undefined; }
    catch { throw new CallError(undefined, `${method} ${safePath}: invalid response`); }
  };
}

export interface Click {
  readonly id: string; readonly token: string; readonly appId: string; readonly type: 3 | 5;
  readonly kind: string; readonly ref: string; readonly verb: string;
  readonly channelId: string; readonly messageId: string | undefined;
  readonly userId: string;
  readonly userName?: string;
}

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const id = (value: unknown): string | undefined => typeof value === "string" && SNOWFLAKE.test(value) ? value : undefined;

export function parseInteraction(raw: unknown): Click | undefined {
  const event = record(raw), data = record(event?.data);
  if (!event || !data) return undefined;
  // agent-messenger overwrites the payload's numeric type with "INTERACTION_CREATE"; the data shape tells them apart.
  const type = typeof event.type === "number" ? event.type : typeof data.component_type === "number" ? 3 :
    Array.isArray(data.components) ? 5 : undefined;
  if (type !== 3 && type !== 5) return undefined;
  const user = record(record(event.member)?.user) ?? record(event.user);
  const name = record(event.member)?.nick || user?.global_name || user?.username;
  const [interactionId, appId, channelId, userId] = [id(event.id), id(event.application_id), id(event.channel_id), id(user?.id)];
  const match = typeof data.custom_id === "string" ? CUSTOM_ID.exec(data.custom_id) : null;
  if (!interactionId || !appId || !channelId || !userId || typeof event.token !== "string" || !event.token || !match) return undefined;
  const [, kind, ref, verb] = match;
  if (!kind || !ref || !verb || !VERBS[kind]?.includes(verb) || (type === 5) !== (kind === "qm" || kind === "pm")) return undefined;
  return {
    id: interactionId, token: event.token, appId, type, kind, ref, verb,
    channelId,
    messageId: id(record(event.message)?.id), userId,
    ...(typeof name === "string" && name ? { userName: name.slice(0, 100) } : {}),
  };
}

export interface Deps {
  readonly prompts: PromptStore;
  readonly questions: () => QuestionStore | undefined;
  readonly ownerId: string;
  readonly trusted: () => ReadonlySet<string>;
  readonly call: Call;
  readonly now: () => number;
  readonly emit: (line: string) => void;
  readonly warn: (text: string) => void;
  readonly userNames?: Map<string, Promise<string>>;
}

export async function userReference(deps: Deps, user: string, knownName?: string): Promise<string> {
  let name = deps.userNames?.get(user);
  if (knownName) {
    name = Promise.resolve(knownName);
    deps.userNames?.set(user, name);
  } else if (!name) {
    name = deps.call("GET", `/users/${user}`).then(value => {
      const named = record(value), label = named?.global_name || named?.username;
      if (typeof label !== "string") throw new CallError(undefined, "User display name is unavailable");
      return label;
    }).catch(error => {
      if (error instanceof CallError && error.status === 404) return "Unavailable user";
      throw error;
    });
    deps.userNames?.set(user, name);
  }
  return referenceLink({ kind: "user", id: user, label: await name });
}

export const callback = (deps: Deps, click: Click, type: number, data?: unknown) =>
  deps.call("POST", `/interactions/${click.id}/${click.token}/callback?with_response=true`, { type, ...(data ? { data } : {}) });
export const notice = (deps: Deps, click: Click, content: string) =>
  callback(deps, click, MESSAGE, { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } });
/**
 * After an ambiguous callback, Discord's stored original response settles what users actually saw:
 * a message, null when Discord says there is none, or undefined when that is still unknown.
 */
export async function original(deps: Deps, appId: string, token: string): Promise<Record<string, unknown> | null | undefined> {
  try { return record(await deps.call("GET", `/webhooks/${appId}/${token}/messages/@original`)) ?? null; }
  catch (error) {
    if (!(error instanceof CallError)) throw error;
    return error.status === 404 ? null : undefined;
  }
}

export const TOKEN_LIFE_MS = 14 * 60_000;
export type Reply = Pick<Click, "appId" | "token" | "userId">;

export function busy(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_BUSY");
}

/** After Discord has shown a decision, recording it must not fail on a briefly locked database. */
export async function settle<T>(write: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return write(); }
    catch (error) {
      if (!busy(error) || attempt === 20) throw error;
      await Bun.sleep(100);
    }
  }
}


const retryAfter = new Map<string, number>();

export async function edit(deps: Deps, key: string, run: () => Promise<unknown>, done: () => void): Promise<void> {
  if ((retryAfter.get(key) ?? 0) > deps.now()) return;
  try { await run(); done(); retryAfter.delete(key); }
  catch (error) {
    if (!(error instanceof CallError)) throw error;
    if (error.status === 404) { done(); retryAfter.delete(key); return; }
    if (!retryAfter.has(key)) deps.warn(`could not update Discord message (${key}); retrying: ${error.message}`);
    retryAfter.set(key, deps.now() + RETRY_FAILED_EDIT_MS);
  }
}

/**
 * Posts a reply once. Discord deduplicates a nonce only for a few minutes, so every attempt first looks
 * for an earlier copy after the referenced message; a lost response therefore never yields a second post.
 */
export async function postOnce(deps: Deps, channelId: string, referenceId: string, content: string, nonce: string,
  previousContent?: string): Promise<void> {
  let after = referenceId;
  for (let page = 0; ; page++) {
    if (page === 50) throw new CallError(undefined, `could not finish checking ${channelId} for an earlier copy`);
    const recent = await deps.call("GET", `/channels/${channelId}/messages?after=${after}&limit=100`);
    const items = Array.isArray(recent) ? recent.map(record).filter((item) => item !== undefined) : [];
    if (items.some((message) => record(message.author)?.bot === true && (message.content === content ||
        previousContent !== undefined && message.content === previousContent) &&
        record(message.message_reference)?.message_id === referenceId)) return;
    if (items.length < 100) break;
    after = items.map((message) => id(message.id) ?? "0").reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  }
  await deps.call("POST", `/channels/${channelId}/messages`, {
    content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true,
    message_reference: { message_id: referenceId, fail_if_not_exists: false },
  });
}
