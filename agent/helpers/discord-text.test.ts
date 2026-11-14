import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDiscordText } from "./discord-text.ts";

const original = process.env.DORI_STATE_DIR;
afterEach(() => { process.env.DORI_STATE_DIR = original; });

test("dori send text links the people intake knows, and is unchanged without Helio state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "helio-discord-text-"));
  try {
    const { Delivery } = await import(new URL("../discord-inbound/delivery/delivery.ts", import.meta.url).href);
    const delivery = new Delivery(join(directory, "discord-delivery.sqlite"));
    delivery.stage("context", "10", JSON.stringify({ message_id: "10", channel_id: "1", author_id: "66", author: "Crystal Wolf", bot: false }));
    delivery.close();
    const text = "New bug issue <https://github.com/o/r/issues/1>: stats clutter (from Crystal Wolf)";
    process.env.DORI_STATE_DIR = directory;
    expect(await formatDiscordText(text))
      .toBe("New bug issue <https://github.com/o/r/issues/1>: stats clutter (from **[Crystal Wolf](<https://discord.com/users/66?tab=wishlist>)**)");
    delete process.env.DORI_STATE_DIR;
    expect(await formatDiscordText(text)).toBe(text);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
