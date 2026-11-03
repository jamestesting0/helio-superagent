import type { IncomingMessage } from "./filter.ts";
import { omitLinks } from "./images.ts";

export interface PrecedingMessage {
  readonly message_id: string;
  readonly sent_at: string;
  readonly content: string;
}

/** Volatile evidence only. This store never classifies or stages a request. */
export class Preceding {
  private readonly rings = new Map<string, PrecedingMessage[]>();

  constructor(private readonly now: () => number) {}

  remember(message: IncomingMessage): void {
    this.prune();
    const sentAt = Date.parse(message.timestamp);
    if (!Number.isFinite(sentAt) || this.now() - sentAt > 60_000) return;
    const key = JSON.stringify([message.channel_id, message.author.id]);
    const entries = this.rings.get(key) ?? [];
    entries.push({
      message_id: message.id, sent_at: message.timestamp, content: omitLinks(message.content).slice(0, 2000),
    });
    this.rings.set(key, entries.slice(-10));
  }

  take(first: { readonly channel_id: string; readonly author_id: string; readonly sent_at: unknown }): readonly PrecedingMessage[] {
    this.prune();
    const key = JSON.stringify([first.channel_id, first.author_id]);
    const entries = this.rings.get(key) ?? [];
    this.rings.delete(key);
    const firstAt = typeof first.sent_at === "string" ? Date.parse(first.sent_at) : NaN;
    return entries.filter((entry) => Date.parse(entry.sent_at) < firstAt);
  }

  private prune(): void {
    for (const [key, entries] of this.rings) {
      const fresh = entries.filter((entry) => this.now() - Date.parse(entry.sent_at) <= 60_000);
      if (fresh.length) this.rings.set(key, fresh);
      else this.rings.delete(key);
    }
  }
}
