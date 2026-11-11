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
    ["png", "image/png", undefined], ["jpg", "image/jpeg", undefined], ["jpeg", "image/jpeg", undefined],
    ["gif", "image/gif", undefined], ["webp", "image/webp", undefined],
    ["png", "image/png", "image/jpeg"],
    ["png", "image/jpeg", "image/png"],
    ["png", "image/jpeg", undefined],
  ] as const)("decodes %s with HTTP %s and event MIME %s into private static PNG", async (ext, mime, declared) => {
    const bytes = mime === "image/png" ? png : mime === "image/gif" ? gif : mime === "image/webp" ? webp : jpeg;
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
      ...(declared === undefined ? {} : { content_type: declared }),
    })], "100", root);
    expect(result.blocked).toEqual([]);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    if (!file) throw new Error("Expected image file");
    expect(file.kind).toBe("image");
    expect(file).toMatchObject({ format: mime.slice("image/".length), width: 2, height: 2 });
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
    { content_type: "image/svg+xml" }, { size: MAX_IMAGE_BYTES + 1 }, { size: -1 },
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
      create: { width: 8000, height: 5001, channels: 3, background: "red" },
    }).png().toBuffer();
    http.mockResolvedValue(new Response(huge, { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.files).toEqual([]);
    expect(result.blocked[0]?.reason).toBe("Image exceeds 40 MP limit");
  });

  test("large screenshots are shrunk to fit 2048 pixels instead of being refused", async () => {
    const wide = await sharp({
      create: { width: 6016, height: 3384, channels: 3, background: "blue" },
    }).png().toBuffer();
    http.mockResolvedValue(new Response(wide, { headers: { "content-type": "image/png" } }));
    const result = await prepareAttachments([attachment()], "100", root);
    expect(result.blocked).toEqual([]);
    const file = result.files[0];
    if (file?.kind !== "image") throw new Error("Expected image file");
    expect([file.width, file.height, file.format, file.animated]).toEqual([2048, 1152, "png", false]);
    expect(await sharp(await readFile(file.path)).metadata()).toMatchObject({ width: 2048, height: 1152 });
  });

  test("animated GIF keeps its first frame and says so", async () => {
    // Distinct frames: the GIF encoder merges identical ones into a still image.
    const frame = (background: string) => sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer();
    const animated = await sharp([await frame("#00f"), await frame("#f00")], { join: { animated: true } }).gif().toBuffer();
    http.mockResolvedValue(new Response(animated, { headers: { "content-type": "image/gif" } }));
    const result = await prepareAttachments([attachment({
      filename: "clip.gif", url: "https://cdn.discordapp.com/attachments/123/456/clip.gif",
    })], "100", root);
    const file = result.files[0];
    if (file?.kind !== "image") throw new Error(JSON.stringify(result.blocked));
    expect([file.width, file.height, file.format, file.animated]).toEqual([2, 2, "gif", true]);
  });

  test.each(["Screenshot_2026-11-04_at_10.15.32.png", "截图.png", "café [1].png", "photo.exe.png"])(
    "ordinary names are accepted: %s", async (filename) => {
      http.mockResolvedValue(new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }));
      const result = await prepareAttachments([attachment({
        filename, url: `https://cdn.discordapp.com/attachments/123/456/${encodeURIComponent(filename)}`,
      })], "100", root);
      expect(result.blocked).toEqual([]);
      expect(result.files.map((file) => file.name)).toEqual([filename]);
    });

  test.each([".hidden.png", "a\u200fb.png", "x".repeat(201) + ".png", "dir\\photo.png"])(
    "disguising names are refused before HTTP: %j", async (filename) => {
      const result = await prepareAttachments([attachment({
        filename, url: `https://cdn.discordapp.com/attachments/123/456/${encodeURIComponent(filename)}`,
      })], "100", root);
      expect(result.blocked[0]?.reason).toBe("Unsupported or suspicious attachment filename");
      expect(http).not.toHaveBeenCalled();
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
    expect(result.blocked[0]?.reason).toContain("25 MiB");
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

  test("terminal colour codes are stripped from logs instead of refusing them", async () => {
    http.mockResolvedValue(new Response("\u001b[31mERROR\u001b[0m boom\n\u001b]0;title\u0007done\n",
      { headers: { "content-type": "text/plain" } }));
    const result = await prepareAttachments([textAttachment({
      filename: "bot.txt", url: "https://cdn.discordapp.com/attachments/123/456/bot.txt",
    })], "100", root);
    const file = result.files[0];
    if (!file) throw new Error(JSON.stringify(result.blocked));
    expect(await readFile(file.path, "utf8")).toBe("ERROR boom\ndone\n");
  });

  test.each(["text/markdown", "text/x-markdown", "application/octet-stream"])("accepts validated text MIME %s", async (mime) => {
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

test("omitLinks keeps every link into the configured repository and nothing else", async () => {
  const previous = process.env.HELIO_GITHUB_REPO;
  process.env.HELIO_GITHUB_REPO = "jamestesting0/elo-bot";
  try {
    expect(omitLinks("See <https://github.com/JamesTesting0/Elo-Bot/pull/42/files?q=x#diff>"))
      .toBe("See jamestesting0/elo-bot#42 (pull request)");
    expect(omitLinks("https://github.com/jamestesting0/elo-bot/issues/17"))
      .toBe("jamestesting0/elo-bot#17 (issue)");
    for (const url of [
      "https://github.com/other/elo-bot/pull/42",
      "https://github.com.evil.test/jamestesting0/elo-bot/pull/42",
      "https://www.github.com/jamestesting0/elo-bot/pull/42",
      "https://user@github.com/jamestesting0/elo-bot/pull/42",
      "https://github.com@evil.test/jamestesting0/elo-bot/pull/42",
      "http://github.com/jamestesting0/elo-bot/pull/42",
      "https://github.com:443/jamestesting0/elo-bot/pull/42",
      "https://github.com/jamestesting0/elo-bot/pull/42\\evil",
      "https://github.com/jamestesting0/elo-bot.evil/blob/main/main.py",
      "https://github.com/jamestesting0/elo-bot-fork/commit/abc123",
      "https://raw.githubusercontent.com/jamestesting0/elo-bot/main/main.py",
    ]) expect(omitLinks(url)).toBe("[link omitted]");
    for (const url of [
      "https://github.com/jamestesting0/elo-bot",
      "https://github.com/jamestesting0/elo-bot/blob/main/cogs/match_commands.py#L120-L140",
      "https://github.com/jamestesting0/elo-bot/commit/f343d53f237b2e552f445185fcd261605c7999ff",
      "https://github.com/jamestesting0/elo-bot/compare/main...fix-dm",
      "https://github.com/jamestesting0/elo-bot/pull/42evil",
    ]) expect(omitLinks(`see <${url}> or ${url}`)).toBe(`see <${url}> or ${url}`);
    const blocked = await prepareAttachments([attachment({
      filename: "https://github.com/jamestesting0/elo-bot/pull/42",
    })], "100", "/unused-rejected-filename");
    expect(blocked.blocked[0]?.name).toBe("[link omitted]");
    delete process.env.HELIO_GITHUB_REPO;
    expect(omitLinks("<https://github.com/jamestesting0/elo-bot/pull/42>"))
      .toBe("<[link omitted]>");
  } finally {
    if (previous === undefined) delete process.env.HELIO_GITHUB_REPO;
    else process.env.HELIO_GITHUB_REPO = previous;
  }
});
