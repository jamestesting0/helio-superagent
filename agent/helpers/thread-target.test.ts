import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { sendThread } from "./thread-target.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const sourceSkill = join(import.meta.dir, "../../vendor/dori-mode/scripts/src");
const skillSrc = existsSync(sourceSkill) ? sourceSkill : join(homedir(), ".agents/skills/dori-mode/scripts/src");
const { fill, loadConfig } = await import(join(skillSrc, "config.ts"));

const spawn = Bun.spawn.bind(Bun);
const boundary = spyOn(Bun, "spawn");
const errors = spyOn(console, "error").mockImplementation(() => {});

afterAll(() => {
  boundary.mockRestore();
  errors.mockRestore();
});

afterEach(() => {
  boundary.mockClear();
  errors.mockClear();
});

// Mock only the messenger process; no Discord CLI or network call can run.
boundary.mockImplementation(() => spawn([process.execPath, "-e", "process.exit(0)"]));

test.each(["123456789012345678", "discord:123456789012345678"])(
  "sends %s to the bare Discord channel without interpreting message text",
  async (thread) => {
    const text = "quotes \"' ; `literal` $(literal)\n--to other {thread} \\ end";

    expect(await sendThread(thread, text)).toBe(0);

    expect(boundary.mock.calls[0]?.[0]).toEqual([
      "dori", "send", "discord", "--to", "123456789012345678", "--text", text,
    ]);
  },
);

test.each([
  "slack:123456789012345678", "telegram:123456789012345678", "", "none",
  "discord:", "discord:123:456", "Discord:123", "123/456", " 123", "123\n",
])("rejects target %j before invoking the messenger", async (thread) => {
  expect(await sendThread(thread, "message")).toBe(2);
  expect(boundary).not.toHaveBeenCalled();
});

test("returns the messenger failure status", async () => {
  boundary.mockImplementationOnce(() => spawn([process.execPath, "-e", "process.exit(7)"]));

  expect(await sendThread("discord:123456789012345678", "message")).toBe(7);
});

test.each(["threadReply", "threadDone"] as const)(
  "%s routes stored refs and text through the local wrapper",
  async (name) => {
    const config = await loadConfig(`${import.meta.dir}/config.json`);
    const template = config.hooks[name];
    expect(template).toBeDefined();
    if (!template) throw new TypeError("Missing hook");
    const text = "first line\n\"quoted\"; `literal` {thread}";
    const argv = fill(template, { thread: "discord:123456789012345678", text });

    expect(argv[0]).toBe("bun");
    expect(argv[1]?.endsWith("/.dori/elobot/thread-target.ts")).toBe(true);
    expect(argv.length).toBe(4);
    const [, , thread, message] = argv;
    if (thread === undefined || message === undefined) throw new TypeError("Missing hook arguments");
    expect(await sendThread(thread, message)).toBe(0);
    expect(boundary.mock.calls[0]?.[0]).toEqual([
      "dori", "send", "discord", "--to", "123456789012345678", "--text", text,
    ]);
  },
);
