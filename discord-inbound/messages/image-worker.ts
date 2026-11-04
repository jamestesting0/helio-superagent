// Decodes one untrusted raster image in a throwaway sandboxed process and returns fresh PNG pixels.
// Image decoders have a long history of memory-corruption bugs (libpng, libwebp CVE-2023-4863), so
// decoding never happens in the intake process that holds the Discord token. decodeImage() runs this
// file under bubblewrap: no home directory, no network, an empty environment, and prlimit CPU and
// address-space caps. Only the PNG, JPEG, WebP and GIF loaders of libvips stay reachable.
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_EDGE = 2048;
const TIMEOUT_MS = 20_000;
const LOADERS = ["VipsForeignLoadPngBuffer", "VipsForeignLoadJpegBuffer", "VipsForeignLoadWebpBuffer", "VipsForeignLoadNsgifBuffer"];
// 1x1 PNG for the startup self-test.
const PROBE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export type DecodedFormat = "png" | "jpeg" | "webp" | "gif";

export interface DecodedImage {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly format: DecodedFormat;
  /** Only the first frame was decoded. */
  readonly animated: boolean;
}

/** Its message is a fixed, user-presentable reason. */
export class ImageDecodeError extends Error {}

interface SandboxOptions {
  readonly worker?: string;
  readonly timeoutMs?: number;
  readonly bwrap?: string;
  readonly prlimit?: string;
}


// Merged-/usr systems keep /lib, /lib64 and /bin as symlinks into /usr; mirror whatever exists.
async function systemBinds(): Promise<string[]> {
  const binds = ["--ro-bind", "/usr", "/usr"];
  for (const path of ["/lib", "/lib64", "/bin"]) {
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink()) binds.push("--symlink", await readlink(path), path);
    else if (info?.isDirectory()) binds.push("--ro-bind", path, path);
  }
  return binds;
}

async function sandboxCommand(worker: string, options: SandboxOptions): Promise<string[]> {
  const bun = await realpath(process.execPath);
  const folder = dirname(worker);
  // The package root holds node_modules (sharp); it is the same read-only tree the worker had before the area folders.
  const packageRoot = dirname(import.meta.dir);
  const code = folder === packageRoot ? ["--ro-bind", folder, folder] : ["--ro-bind", packageRoot, packageRoot, "--ro-bind", folder, folder];
  return [
    options.prlimit ?? Bun.which("prlimit") ?? "/usr/bin/prlimit", "--as=4294967296", "--cpu=20", "--",
    options.bwrap ?? Bun.which("bwrap") ?? "/usr/bin/bwrap",
    "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    ...await systemBinds(),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", bun, bun, ...code,
    "--", bun, worker,
  ];
}

export async function decodeImage(bytes: Uint8Array, options: SandboxOptions = {}): Promise<DecodedImage> {
  let child: Bun.Subprocess<Blob, "pipe", "ignore">;
  try {
    child = Bun.spawn(await sandboxCommand(options.worker ?? import.meta.path, options), {
      stdin: new Blob([bytes]), stdout: "pipe", stderr: "ignore", env: {},
      timeout: options.timeoutMs ?? TIMEOUT_MS, killSignal: "SIGKILL",
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new ImageDecodeError("Image sandbox unavailable");
  }
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  let result: unknown;
  try { result = JSON.parse(output); }
  catch { result = undefined; }
  if (code !== 0 || typeof result !== "object" || result === null) {
    throw new ImageDecodeError("Image could not be decoded safely");
  }
  const r = result as Record<string, unknown>;
  if (r.ok !== true) {
    throw new ImageDecodeError(r.reason === "pixels" ? `Image exceeds ${MAX_IMAGE_PIXELS / 1_000_000} MP limit` : "Image could not be decoded");
  }
  if (typeof r.png !== "string" || !Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) ||
      !["png", "jpeg", "webp", "gif"].includes(String(r.format)) || typeof r.animated !== "boolean") {
    throw new ImageDecodeError("Image could not be decoded safely");
  }
  return {
    png: Buffer.from(r.png, "base64"), width: r.width as number, height: r.height as number,
    format: r.format as DecodedFormat, animated: r.animated,
  };
}

/** Undefined when the sandbox decodes a known image; otherwise the reason images will be blocked. */
export async function checkImageSandbox(options: SandboxOptions = {}): Promise<string | undefined> {
  try {
    await decodeImage(PROBE, options);
    return undefined;
  } catch (error) {
    if (!(error instanceof ImageDecodeError)) throw error;
    return error.message;
  }
}

if (import.meta.main) {
  const sharp = (await import("sharp")).default;
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: LOADERS });
  sharp.cache(false);
  sharp.concurrency(1);
  const input = Buffer.from(await Bun.stdin.arrayBuffer());
  let result: Record<string, unknown>;
  try {
    // First frame only, decoded and encoded as fresh pixels: no metadata or trailing input bytes survive.
    const image = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning", pages: 1 });
    const meta = await image.metadata();
    const { data, info } = await image.timeout({ seconds: 15 })
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    result = {
      ok: true, format: meta.format, animated: (meta.pages ?? 1) > 1,
      width: info.width, height: info.height, png: data.toString("base64"),
    };
  } catch (error) {
    result = { ok: false, reason: error instanceof Error && /pixel limit/i.test(error.message) ? "pixels" : "undecodable" };
  }
  process.stdout.write(JSON.stringify(result));
}
