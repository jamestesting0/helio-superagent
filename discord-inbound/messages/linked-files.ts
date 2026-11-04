// Trusted chats only: links to Discord attachments and images Discord itself previewed become files.
// Previewed images are fetched from Discord's media proxy, so Helio never contacts the linked host
// (no SSRF, no redirect chain, no IP leak). Every other link stays omitted.
import { omitLinks, type Attachment } from "./images.ts";
import type { Embed } from "./message-text.ts";

export const MAX_LINKED_FILES = 4;
const LINK = /\bhttps?:\/\/[^\s<>"`]+/gi;
const DISCORD_FILE = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[0-9]+\/[0-9]+\/([^/?#\\]+)(?:\?[^#\\]*)?$/;
const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i;
const LABEL_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\]]/g;

/** A link preview Discord built for an image link: `thumbnail.proxy_url` is its media-proxy copy. */
export interface PreviewEmbed extends Embed {
  readonly url?: string;
  readonly thumbnail?: { readonly url?: string; readonly proxy_url?: string };
}

function previews(embeds: readonly PreviewEmbed[] | undefined): Map<string, string> {
  const found = new Map<string, string>();
  for (const embed of embeds ?? []) {
    if ((embed.type === "image" || embed.type === "gifv") && embed.url && embed.thumbnail?.proxy_url &&
        !DISCORD_FILE.test(embed.url) && !found.has(embed.url)) found.set(embed.url, embed.thumbnail.proxy_url);
  }
  return found;
}

function discordFileName(url: string): string | undefined {
  const name = DISCORD_FILE.exec(url)?.[1];
  if (!name) return undefined;
  try { return decodeURIComponent(name); }
  catch (error) {
    if (!(error instanceof URIError)) throw error;
    return undefined;
  }
}

export function linkedFiles(content: string, embeds: readonly PreviewEmbed[] | undefined) {
  const attachments: Attachment[] = [];
  const unused = previews(embeds);
  let previewNumber = 0;
  const preview = (proxy: string) => {
    const filename = `linked-image-${++previewNumber}`;
    attachments.push({ url: proxy, filename, source: "link", preview: true });
    return filename;
  };
  const marked = content.replace(LINK, (link) => {
    if (attachments.length >= MAX_LINKED_FILES) return link;
    const filename = discordFileName(link);
    if (filename) {
      attachments.push({ url: link, filename, source: "link" });
      return `[linked: ${filename.replace(LABEL_UNSAFE, "").slice(0, 100)}]`;
    }
    const proxy = unused.get(link);
    if (proxy) {
      unused.delete(link);
      return `[linked: ${preview(proxy)}]`;
    }
    return omitLinks(link) === "[link omitted]" && IMAGE_PATH.test(link) ? "[image link omitted: no preview]" : link;
  });
  // Discord sometimes normalizes the link it previews; those previews still belong to this message.
  for (const proxy of unused.values()) {
    if (attachments.length >= MAX_LINKED_FILES) break;
    preview(proxy);
  }
  return { attachments, content: omitLinks(marked) };
}

/** True while an external link has no preview yet: Discord usually adds it in a MESSAGE_UPDATE moments later. */
export function awaitsPreview(content: string, embeds: readonly Embed[] | undefined): boolean {
  if (embeds?.length) return false;
  return [...content.matchAll(LINK)].some(([link]) => !DISCORD_FILE.test(link) && omitLinks(link) === "[link omitted]");
}

export interface PreviewClock {
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

/**
 * Hands late link previews (MESSAGE_UPDATE embeds) to the message being prepared.
 * `update` must be called straight from the gateway handler, never through the delivery queue,
 * because the queue itself is what waits.
 */
export class Previews {
  private readonly early = new Map<string, readonly PreviewEmbed[]>();
  private readonly waiting = new Map<string, (embeds: readonly PreviewEmbed[] | undefined) => void>();

  constructor(private readonly clock: PreviewClock, private readonly timeoutMs = 5000) {}

  update(messageId: string, embeds: readonly PreviewEmbed[] | undefined): void {
    if (!embeds?.length) return;
    const resolve = this.waiting.get(messageId);
    if (resolve) {
      resolve(embeds);
      return;
    }
    this.early.set(messageId, embeds);
    if (this.early.size > 200) this.early.delete(this.early.keys().next().value as string);
  }

  async wait(
    messageId: string, fetchLatest: () => Promise<readonly PreviewEmbed[] | undefined>,
  ): Promise<readonly PreviewEmbed[] | undefined> {
    const early = this.early.get(messageId);
    this.early.delete(messageId);
    const arrived = early ?? await new Promise<readonly PreviewEmbed[] | undefined>((resolve) => {
      const timer = this.clock.setTimeout(() => finish(undefined), this.timeoutMs);
      const finish = (embeds: readonly PreviewEmbed[] | undefined) => {
        this.clock.clearTimeout(timer);
        this.waiting.delete(messageId);
        resolve(embeds);
      };
      this.waiting.set(messageId, finish);
    });
    return arrived ?? await fetchLatest();
  }
}
