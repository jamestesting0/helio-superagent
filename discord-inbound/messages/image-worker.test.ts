import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { checkImageSandbox, decodeImage, ImageDecodeError } from "./image-worker.ts";

let dir: string;
let secret: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dori-image-worker-"));
  secret = join(await mkdtemp(join(tmpdir(), "dori-image-secret-")), "env");
  await writeFile(secret, "DORI_DISCORD_TOKEN=secret\n");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(join(secret, ".."), { recursive: true, force: true });
});

async function worker(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

test("the real worker decodes inside the sandbox", async () => {
  expect(await checkImageSandbox()).toBeUndefined();
});

test("only PNG, JPEG, WebP and GIF loaders are reachable", async () => {
  const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).tiff().toBuffer();
  await expect(decodeImage(tiff)).rejects.toThrow("Image could not be decoded");
});

test("the sandbox hides files outside the worker folder and the environment", async () => {
  process.env.HELIO_IMAGE_WORKER_TEST_SECRET = "visible";
  try {
    const probe = await worker("probe.ts", `
      const readable = await Bun.file(${JSON.stringify(secret)}).text().then(() => true, () => false);
      const leaked = readable || process.env.HELIO_IMAGE_WORKER_TEST_SECRET !== undefined;
      process.stdout.write(JSON.stringify({ ok: true, png: "", width: 1, height: 1, format: "png", animated: leaked }));`);
    expect((await decodeImage(new Uint8Array([1]), { worker: probe })).animated).toBe(false);
  } finally {
    delete process.env.HELIO_IMAGE_WORKER_TEST_SECRET;
  }
});

test.each([
  ["a crash", "process.exit(3);", {}],
  ["garbage output", "process.stdout.write('not json');", {}],
  ["a hang", "await new Promise(() => {});", { timeoutMs: 300 }],
] as const)("%s becomes a blocked image, never a decoded one", async (_label, body, options) => {
  const path = await worker(`${_label.replace(/\W/g, "-")}.ts`, body);
  const error = await decodeImage(new Uint8Array([1]), { worker: path, ...options }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ImageDecodeError);
  expect((error as Error).message).toBe("Image could not be decoded safely");
});

test("a missing sandbox fails closed with a reason", async () => {
  expect(await checkImageSandbox({ bwrap: join(dir, "no-bwrap"), prlimit: join(dir, "no-prlimit") }))
    .toBe("Image sandbox unavailable");
});
