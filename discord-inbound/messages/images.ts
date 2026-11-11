import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeImage, ImageDecodeError } from "./image-worker.ts";

export interface Attachment {
  readonly url: string;
  readonly filename: string;
  readonly content_type?: string | null;
  readonly size?: number;
  /** Pasted as a link in a trusted chat rather than uploaded. */
  readonly source?: "link";
  /** Discord's media-proxy copy of a previewed external image: its type comes from the response. */
  readonly preview?: true;
}

type ImageKind = "png" | "jpeg" | "webp" | "gif";
type FileKind = ImageKind | "text";

export type PreparedFile = {
  readonly path: string;
  readonly name: string;
  readonly source?: "link";
} & ({ readonly kind: "text" } | {
  readonly kind: "image";
  readonly width: number;
  readonly height: number;
  readonly format: ImageKind;
  readonly animated: boolean;
});

export interface PreparedAttachments {
  readonly files: readonly PreparedFile[];
  readonly blocked: readonly {
    readonly name: string; readonly reason: string;
    readonly category: "unsupported-format" | "invalid" | "unavailable"; readonly source?: "link";
  }[];
}

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 128 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MIB = 1024 * 1024;
// Names are only labels (files are stored under random names after decoding); refuse what can disguise one.
const UNSAFE_NAME = /[/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

class ImageRejected extends Error {
  constructor(message: string, readonly category: "unsupported-format" | "invalid" = "invalid") { super(message); }
}

function omitAllLinks(text: string): string {
  return text.replace(/(?:\b(?:https?|ftp|file|data|javascript):[^\s<>"`]*|\bwww\.[^\s<>"`]*)/gi, "[link omitted]");
}

/** Links into the configured repository stay readable (PRs and issues as `repo#N` references); all others are omitted. */
export function omitLinks(text: string): string {
  const repo = process.env.HELIO_GITHUB_REPO;
  if (!repo || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) return omitAllLinks(text);
  return text.replace(/(<?)(\b(?:https?|ftp|file|data|javascript):[^\s<>"`]*|\bwww\.[^\s<>"`]*)(>?)/gi, (_, open: string, url: string, close: string) => {
    const kept = repositoryLink(url, repo);
    if (kept === undefined) return `${open}[link omitted]${close}`;
    return kept === url ? `${open}${url}${close}` : kept;
  });
}

// Only https://github.com/<repo> itself or a path under it; hosts, other repos and lookalike names never match.
function repositoryLink(url: string, repo: string): string | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:([/?#])([^\\]*))?$/i.exec(url);
  if (!match || match[1]?.toLowerCase() !== repo.toLowerCase()) return undefined;
  const item = match[2] === "/" ? /^(pull|issues)\/([0-9]+)(?:[/?#]|$)/i.exec(match[3] ?? "") : null;
  if (!item) return url;
  return `${repo}#${item[2]} (${item[1]?.toLowerCase() === "pull" ? "pull request" : "issue"})`;
}

function mimeKind(value: string | null | undefined): ImageKind | undefined {
  switch (value?.split(";")[0]?.trim().toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg": return "jpeg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return undefined;
  }
}

function textMime(value: string | null | undefined): boolean {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime === "text/plain" || mime === "text/markdown" || mime === "text/x-markdown" || mime === "application/octet-stream";
}

function attachmentKind(item: Attachment): "image" | "text" {
  const name = item.filename;
  if (!name || name.length > 200 || name.startsWith(".") || UNSAFE_NAME.test(name)) {
    throw new ImageRejected("Unsupported or suspicious attachment filename");
  }
  const extension = /\.(png|jpe?g|webp|gif|txt|md|markdown)$/i.exec(name)?.[1]?.toLowerCase();
  if (!extension) throw new ImageRejected("Unsupported attachment type", "unsupported-format");
  const kind = ["txt", "md", "markdown"].includes(extension) ? "text" : extension === "jpg" ? "jpeg" : extension;
  if (kind !== "text" && kind !== "png" && kind !== "jpeg" && kind !== "webp" && kind !== "gif") {
    throw new ImageRejected("Unsupported attachment type", "unsupported-format");
  }
  // Discord's event MIME and filename can disagree; actual raster types are checked after download.
  if (item.content_type != null &&
      (kind === "text" ? !textMime(item.content_type) : mimeKind(item.content_type) === undefined)) {
    throw new ImageRejected("Declared content type is not supported for this attachment");
  }
  if (item.size !== undefined &&
      (!Number.isSafeInteger(item.size) || item.size < 0 ||
        item.size > (kind === "text" ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES))) {
    throw new ImageRejected("Invalid or oversized attachment");
  }
  return kind === "text" ? "text" : "image";
}

function attachmentUrl(item: Attachment): URL {
  // Check the original spelling too: URL parsing normalizes traversal and backslashes.
  if (!/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[0-9]+\/[0-9]+\/[^/?#\\]+(?:\?[^#\\]*)?$/.test(item.url)) {
    throw new ImageRejected("Not a direct Discord CDN attachment");
  }
  const url = new URL(item.url);
  let basename: string;
  try {
    basename = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new ImageRejected("Invalid attachment filename encoding");
  }
  if (basename !== item.filename) throw new ImageRejected("CDN filename does not match attachment");
  return url;
}

function previewUrl(item: Attachment): URL {
  if (!/^https:\/\/(?:media\.discordapp\.net|images-ext-[0-9]\.discordapp\.net)\/external\/[^\s\\#]+$/.test(item.url)) {
    throw new ImageRejected("Not a Discord media-proxy image");
  }
  return new URL(item.url);
}

function magicKind(bytes: Buffer): ImageKind | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const header = bytes.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "webp";
  return undefined;
}

function messageDirectory(messageId: string, imageRoot: string): string {
  if (!/^[0-9]{1,30}$/.test(messageId)) throw new ImageRejected("Invalid Discord message ID");
  return join(resolve(imageRoot), "pending", messageId);
}

async function download(expected: "text" | "image", url: URL): Promise<{ bytes: Buffer; kind: FileKind }> {
  const limit = expected === "text" ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  // CDN requests are deliberately separate from the authenticated Discord REST client.
  const response = await fetch(url, { redirect: "error", credentials: "omit", signal });
  try {
    if (!response.ok || response.redirected) throw new ImageRejected("CDN request failed or redirected");
    const mime = response.headers.get("content-type");
    const kind = expected === "image" ? mimeKind(mime) : expected;
    if (kind === undefined) throw new ImageRejected("HTTP content type is not a supported image");
    if (kind === "text" && !textMime(mime)) {
      throw new ImageRejected("HTTP content type does not match attachment filename");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
      throw new ImageRejected("Invalid or oversized HTTP content length");
    }
    if (!response.body) throw new ImageRejected("Empty attachment response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new ImageRejected(kind === "text" ? "Text exceeds 128 KiB limit" : `Image exceeds ${MAX_IMAGE_BYTES / MIB} MiB limit`);
        chunks.push(chunk.value);
      }
    } finally {
      // Abort the transport even if a rejected response or stream is still producing data.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    if (kind !== "text" && magicKind(bytes) !== kind) throw new ImageRejected("Image magic bytes do not match image type");
    return { bytes, kind };
  } finally {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

type Safe = { readonly bytes: Buffer; readonly kind: "text" } |
  { readonly bytes: Buffer; readonly kind: "image"; readonly width: number; readonly height: number; readonly format: ImageKind; readonly animated: boolean };

async function safeBytes(bytes: Buffer, kind: FileKind): Promise<Safe> {
  if (kind === "text") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ImageRejected("Text is not valid UTF-8");
    }
    // Terminal logs carry colour codes; drop them, then refuse any other binary control character.
    text = text.replace(ANSI, "");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
      throw new ImageRejected("Text contains binary control characters");
    }
    const output = Buffer.from(omitLinks(text), "utf8");
    if (output.length > MAX_TEXT_BYTES) throw new ImageRejected("Sanitized text exceeds 128 KiB limit");
    return { bytes: output, kind };
  }
  const image = await decodeImage(bytes);
  if (image.format !== kind) throw new ImageRejected("Decoded image type does not match attachment type");
  if (image.png.length > MAX_OUTPUT_BYTES) throw new ImageRejected(`Reencoded image exceeds ${MAX_OUTPUT_BYTES / MIB} MiB limit`);
  return { bytes: image.png, kind: "image", width: image.width, height: image.height, format: image.format, animated: image.animated };
}

/**
 * attachmentRoot is trusted configuration, normally `${DORI_STATE_DIR}/attachments/${stream}`.
 * Returns local files only; attachment failures are isolated and contain no source URLs.
 * Keep the files until delivery acknowledgement, then call cleanupAttachments with the same root.
 * Text is untrusted source content: consumers must never execute it or render it as HTML.
 */
export async function prepareAttachments(
  attachments: readonly Attachment[],
  messageId: string,
  attachmentRoot: string,
): Promise<PreparedAttachments> {
  const directory = messageDirectory(messageId, attachmentRoot);
  const files: PreparedFile[] = [];
  const blocked: PreparedAttachments["blocked"][number][] = [];
  for (const item of attachments) {
    const source = item.source ? { source: item.source } : {};
    try {
      const expected = item.preview ? "image" : attachmentKind(item);
      const url = item.preview ? previewUrl(item) : attachmentUrl(item);
      const downloaded = await download(expected, url);
      const safe = await safeBytes(downloaded.bytes, downloaded.kind);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ImageRejected("Unsafe image directory");
      const path = join(directory, `${randomUUID()}.${safe.kind === "text" ? "txt" : "png"}`);
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(safe.bytes);
        await file.sync();
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      } finally {
        await file.close();
      }
      files.push(safe.kind === "text" ? { path, kind: "text", name: item.filename, ...source } : {
        path, kind: "image", name: item.filename, ...source,
        width: safe.width, height: safe.height, format: safe.format, animated: safe.animated,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      blocked.push({
        name: omitAllLinks(item.filename).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 200),
        reason: error instanceof ImageRejected || error instanceof ImageDecodeError ? error.message :
          "Attachment download, decoding or storage failed",
        category: error instanceof ImageRejected ? error.category : error instanceof ImageDecodeError ? "invalid" : "unavailable",
        ...source,
      });
    }
  }
  return { files, blocked };
}

/** Derives the only deletable directory from a Discord ID, never from payload paths. */
export async function cleanupAttachments(messageId: string, attachmentRoot: string): Promise<void> {
  await rm(messageDirectory(messageId, attachmentRoot), { recursive: true, force: true });
}
