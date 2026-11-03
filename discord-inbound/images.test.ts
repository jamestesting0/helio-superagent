import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  cleanupAttachments, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, omitLinks, prepareAttachments, type Attachment,
} from "./images.ts";

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return { filename: "photo.png", url: "https://cdn.discordapp.com/attachments/123/456/photo.png", ...overrides };
}

function textAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return { filename: "notes.md", url: "https://cdn.discordapp.com/attachments/123/456/notes.md", ...overrides };
}

describe("Discord attachments", () => {
  let root: string;
  let png: Buffer;
  let jpeg: Buffer;
  let webp: Buffer;
  let gif: Buffer;
  const boundary: { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } = globalThis;
  const http = spyOn(boundary, "fetch");

  beforeAll(async () => {
    const image = sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } });
    png = await image.clone().png().toBuffer();
    jpeg = await image.clone().jpeg().toBuffer();
    webp = await image.clone().webp().toBuffer();
    gif = await image.clone().gif().toBuffer();
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dori-attachments-"));
    http.mockReset();
    http.mockImplementation(async () => { throw new Error("Unexpected HTTP request"); });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  afterAll(() => http.mockRestore());

  test.each([
    ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
    ["gif", "image/gif"], ["webp", "image/webp"],
  ] as const)("decodes %s into private static PNG without event MIME", async (ext, mime) => {
    const bytes = ext === "png" ? png : ext === "gif" ? gif : ext === "webp" ? webp : jpeg;
    http.mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(new Uint8Array(bytes), { headers: { "content-type": `${mime}; charset=binary` } });
    });
    const result = await prepareAttachments([attachment({
      filename: `photo.${ext}`,
      url: `https://media.discordapp.net/attachments/123/456/photo.${ext}?ex=abc&hm=def`,
    })], "100", root);
    expect(result.blocked).toEqual([]);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    if (!file) throw new Error("Expected image file");
    expect(file.kind).toBe("image");
    expect(file.name).toBe(`photo.${ext}`);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect(file.path.startsWith(join(root, "pending", "100") + "/")).toBe(true);
    expect(file.path.endsWith("/photo.png")).toBe(false);
    const metadata = await sharp(await readFile(file.path)).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
    expect(metadata.pages ?? 1).toBe(1);
  });

  test.each([
    { filename: "photo.exe" }, { filename: "photo.svg" }, { filename: "photo.zip" },
    { filename: "photo.html" }, { filename: "photo.exe.png" }, { filename: "../photo.png" },
    { filename: "photo\u202egnp.exe.png" }, { content_type: "text/plain" },
    { content_type: "image/jpeg" }, { size: MAX_IMAGE_BYTES + 1 }, { size: -1 },
    { url: "https://example.com/attachments/123/456/photo.png" },
    { url: "http://cdn.discordapp.com/attachments/123/456/photo.png" },
    { url: "https://user:pass@cdn.discordapp.com/attachments/123/456/photo.png" },
    { url: "https://cdn.discordapp.com:443/attachments/123/456/photo.png" },
    { url: "https://cdn.discordapp.com.evil.test/attachments/123/456/photo.png" },
    { url: "https://media.discordapp.net/external/hash/https/example.com/photo.png" },
    { url: "https://cdn.discordapp.com/attachments/abc/456/photo.png" },
    { url: "https://cdn.discordapp.com/attachments/123/456/../photo.png" },
    { url: "https://cdn.discordapp.com/attachments/123/456/%2e%2e%2fphoto.png" },
    { url: "https://cdn.discordapp.com/attachments/123/456/other.png" },
    { url: "https://cdn.discordapp.com/attachments/123/456/photo.png#fragment" },
  ])("rejects unsafe metadata before HTTP: %j", async (overrides) => {
    const result = await prepareAttachments([attachment(overrides)], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(http).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  test.each([
    ["text/html", "valid", 200], ["image/jpeg", "valid", 200], ["", "valid", 200],
    ["image/png", "<svg/>", 200], ["image/png", "MZ executable", 200],
    ["image/png", "", 200], ["image/png", "valid", 302], ["image/png", "valid", 404],
  ] as const)("rejects bad HTTP or magic %s %s %s without writing", async (mime, body, status) => {
    http.mockResolvedValue(new Response(body === "valid" ? new Uint8Array(png) : body, {
      status, headers: { "content-type": mime, location: "https://evil.test/payload" },
    }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("https:");
  });

  test("rejects fake image with correct PNG signature but undecodable pixels", async () => {
    http.mockResolvedValue(new Response(Buffer.concat([png.subarray(0, 8), Buffer.from("MZ executable")]),
      { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });

  test("reencoding removes metadata and appended executable content", async () => {
    const metadataPng = await sharp(png).withMetadata().png().toBuffer();
    const payload = Buffer.concat([metadataPng, Buffer.from("MZ-untrusted-appended-content")]);
    http.mockResolvedValue(new Response(payload, { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([attachment()], "100", root);
    const file = result.files[0];
    if (!file) throw new Error(JSON.stringify(result.blocked));
    const bytes = await readFile(file.path);
    expect(bytes.includes(Buffer.from("MZ-untrusted-appended-content"))).toBe(false);
    const info = await sharp(bytes).metadata();
    expect(info.exif).toBeUndefined();
    expect(info.icc).toBeUndefined();
    expect(await sharp(bytes).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());
  });

  test("pixel cap rejects compressed oversized dimensions", async () => {
    const huge = await sharp({
      create: { width: 5000, height: 4001, channels: 3, background: "red" },
    }).png().toBuffer();
    http.mockResolvedValue(new Response(huge, { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
  });

  test("output cap rejects JPEG whose decoded PNG exceeds the storage limit", async () => {
    const noise = Buffer.alloc(2000 * 2000 * 3);
    let seed = 123456789;
    for (let i = 0; i < noise.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      noise[i] = seed & 0xff;
    }
    const compressed = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } })
      .jpeg({ quality: 90 }).toBuffer();
    expect(compressed.length).toBeLessThan(MAX_IMAGE_BYTES);
    http.mockResolvedValue(new Response(compressed, { headers: { "content-type": "image/jpeg" } }));
    const result = await prepareAttachments([attachment({
      filename: "photo.jpg", url: "https://cdn.discordapp.com/attachments/123/456/photo.jpg",
    })], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked[0]?.reason).toContain("Reencoded");
    expect(await readdir(root)).toEqual([]);
  });

  test.each([undefined, "1"])("stream cap overrides Content-Length %s and cancels transport", async (length) => {
    let cancelled = false;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(index++ === 0 ? png : new Uint8Array(MAX_IMAGE_BYTES)); },
      cancel() { cancelled = true; },
    });
    const headers = new Headers({ "content-type": "image/png" });
    if (length) headers.set("content-length", length);
    http.mockResolvedValue(new Response(body, { headers }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked[0]?.reason).toContain("8 MiB");
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  test("rejects oversized advertised length and cancels body", async () => {
    let cancelled = false;
    http.mockResolvedValue(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) } }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  test("timeout bounds a stalled body, not just response headers", async () => {
    const abort = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    http.mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
      pull() { abort.abort(new DOMException("https://secret.test/private", "TimeoutError")); },
    }), { headers: { "content-type": "image/png" } }));
    try {
      const result = await prepareAttachments([attachment()], "100", root);
      expect(result.files).toEqual([]);
      expect(result.blocked).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("secret.test");
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test.each(["txt", "md", "markdown"])("saves %s as unrendered link-stripped UTF-8 text", async (ext) => {
    const input = "# Notes\n<script>ignore this</script>\nrun ls\nhttps://bad.test javascript:alert(1)\n";
    http.mockResolvedValue(new Response(input, { headers: { "content-type": "text/plain" } }));
    const result = await prepareAttachments([textAttachment({
      filename: `notes.${ext}`, url: `https://cdn.discordapp.com/attachments/123/456/notes.${ext}`,
    })], "100", root);
    expect(result.blocked).toEqual([]);
    const file = result.files[0];
    if (!file) throw new Error("Expected text file");
    expect(file.kind).toBe("text");
    expect(file.path.endsWith(".txt")).toBe(true);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(file.path, "utf8"))
      .toBe("# Notes\n<script>ignore this</script>\nrun ls\n[link omitted] [link omitted]\n");
  });

  test.each(["text/markdown", "application/octet-stream"])("accepts validated text MIME %s", async (mime) => {
    http.mockResolvedValue(new Response("Hello\nWorld\t!", { headers: { "content-type": mime } }));
    const result = await prepareAttachments([textAttachment({ content_type: mime })], "100", root);
    expect(result.files).toHaveLength(1);
    expect(result.blocked).toEqual([]);
  });

  test.each([
    Buffer.from([0xc0, 0xaf]), Buffer.from("hello\0world"), Buffer.from("hello\u0007world"),
    Buffer.from("hello\u007fworld"), Buffer.from("hello\u009fworld"),
    Buffer.alloc(MAX_TEXT_BYTES + 1, 65),
  ])("rejects malformed, binary, or oversized text %#", async (bytes) => {
    http.mockResolvedValue(new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    const result = await prepareAttachments([textAttachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });

  test.each(["text/html", "image/svg+xml", "application/javascript"])("rejects active text MIME %s", async (mime) => {
    http.mockResolvedValue(new Response("plain", { headers: { "content-type": mime } }));
    const result = await prepareAttachments([textAttachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
  });

  test.each([{ size: MAX_TEXT_BYTES + 1 }, { content_type: "text/html" }])("rejects invalid text metadata before HTTP %j", async (overrides) => {
    const result = await prepareAttachments([textAttachment(overrides)], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(http).not.toHaveBeenCalled();
  });

  test("blocked sibling does not drop valid files or expose URL names", async () => {
    http.mockImplementation(async () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([
      attachment({ filename: "https://evil.test/a.exe\n" }), attachment(),
    ], "100", root);
    expect(result.files).toHaveLength(1);
    expect(result.blocked).toHaveLength(1);
    expect(JSON.stringify(result.blocked)).not.toContain("evil.test");
    expect(result.blocked[0]?.name).not.toContain("\n");
  });

  test("ack cleanup stays within the selected message and stream", async () => {
    http.mockImplementation(async () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }));
    const inbound = join(root, "inbound");
    const context = join(root, "context");
    await prepareAttachments([attachment()], "100", inbound);
    const otherMessage = await prepareAttachments([attachment()], "101", inbound);
    const otherStream = await prepareAttachments([attachment()], "100", context);
    await cleanupAttachments("100", inbound);
    await cleanupAttachments("100", inbound);
    expect(await readdir(join(inbound, "pending"))).toEqual(["101"]);
    for (const file of [...otherMessage.files, ...otherStream.files]) {
      expect((await sharp(await readFile(file.path)).metadata()).format).toBe("png");
    }
  });

  test.each(["../100", "", "/tmp", "100/../101", "1;rm -rf x"])("cleanup refuses non-ID %j", async (id) => {
    const sentinel = join(root, "keep");
    await writeFile(sentinel, "keep");
    await expect(cleanupAttachments(id, root)).rejects.toThrow("Invalid Discord message ID");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("refuses writing through a symlinked message directory", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(root, "pending"));
    await symlink(outside, join(root, "pending", "100"));
    http.mockResolvedValue(new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(await readdir(outside)).toEqual([]);
  });
});

test("omitLinks removes explicit URL tokens while preserving plain prose", () => {
  expect(omitLinks("See https://example.com/a and <HTTP://site.test/b> [x](ftp://host/file) www.example.com!"))
    .toBe("See [link omitted] and <[link omitted]> [x]([link omitted] [link omitted]");
  expect(omitLinks("file:///tmp/a data:image/svg+xml;base64,abc javascript:alert(1)\nPlain text example.org"))
    .toBe("[link omitted] [link omitted] [link omitted]\nPlain text example.org");
});
