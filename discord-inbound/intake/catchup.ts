import { newerId } from "./lastseen.ts";
import type { MessageBody } from "../messages/forwarded.ts";

export interface RestMessage extends MessageBody {
  channel_id: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
}

export const PAGE_SIZE = 100;

/** One page of a channel's messages, newest first, older than `before` when given. */
export type FetchPage = (channelId: string, before?: string) => Promise<RestMessage[]>;

export interface Caps {
  maxAgeMs: number;
  maxPerChannel: number;
  /** Keep at least this many newest messages even when they are older than maxAgeMs. */
  minKeep?: number;
}

export interface Backlog {
  messages: RestMessage[];
  truncated: boolean;
}

/**
 * Messages newer than `after` (or every message when `after` is undefined), oldest first.
 * Walks backwards from the newest message so that, when a cap is hit, the newest messages are the ones kept.
 * A full last page at the cap is conservatively reported as possibly truncated;
 * checking another page would fetch more messages than the configured limit.
 */
/**
 * When a cap left nothing to deliver, the channel's newest message, so the cursor can move past messages
 * catch-up will never deliver and the cut-off is reported once instead of on every start.
 */
export async function skippedThrough(fetchPage: FetchPage, channelId: string, backlog: Backlog): Promise<string | undefined> {
  if (!backlog.truncated || backlog.messages.length) return undefined;
  return (await fetchPage(channelId))[0]?.id;
}

export async function fetchBacklog(
  fetchPage: FetchPage,
  channelId: string,
  after: string | undefined,
  now: number,
  caps: Caps,
): Promise<Backlog> {
  const oldestAllowed = now - caps.maxAgeMs;
  const kept: RestMessage[] = [];
  let before: string | undefined;

  for (;;) {
    const page = await fetchPage(channelId, before);
    for (const msg of page) {
      if (after !== undefined && !newerId(msg.id, after)) return { messages: kept.reverse(), truncated: false };
      if (Date.parse(msg.timestamp) < oldestAllowed && kept.length >= (caps.minKeep ?? 0)) {
        return { messages: kept.reverse(), truncated: true };
      }
      if (kept.length === caps.maxPerChannel) return { messages: kept.reverse(), truncated: true };
      kept.push(msg);
    }
    if (page.length < PAGE_SIZE) return { messages: kept.reverse(), truncated: false };
    if (kept.length === caps.maxPerChannel) return { messages: kept.reverse(), truncated: true };
    before = page[page.length - 1].id;
  }
}
