import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";

test.each([
  { normal: "100", learning: "600", visible: true },
  { normal: "999", learning: "600", visible: true },
  { normal: "999", learning: "400", visible: false },
])("ack context checks normal union, current learning roots and human provenance: %j", async ({ normal, learning, visible }) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-private-context-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    const values = [
      { channel_id: "100", bot: false, human_verified: true, content: "human normal chat" },
      { channel_id: "101", parent_id: "100", bot: false, human_verified: true, content: "normal thread" },
      { channel_id: "200", bot: true, human_verified: true, content: "bot report" },
      { channel_id: "200", webhook_id: "300", bot: false, human_verified: true, content: "webhook" },
      { channel_id: "200", author: { bot: true }, human_verified: true, content: "nested bot metadata" },
      { channel_id: "104", parent_id: "400", bot: false, human_verified: true, content: "allowed human learning" },
      { channel_id: "104", bot: false, content: "legacy unverified provenance" },
    ];
    for (const [index, value] of values.entries()) queue.stage("context", String(index + 10), JSON.stringify(value));
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures/discord.ts"), join(import.meta.dir, "ack.ts"), "pending", "context"], {
      env: {
        ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_NORMAL_CHANNELS: normal, DORI_DISCORD_TOKEN: "test",
        DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_CONTEXT_EXCLUDED: "",
        DORI_DISCORD_CONTEXT: learning,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exitCode).toBe(0);
    const output: unknown[] = stdout.split("\n").filter((line) => line.startsWith("CONTEXT ")).map((line) => JSON.parse(line.slice("CONTEXT ".length)));
    expect(output).toEqual(visible ? [values[5]] : []);
    expect(stderr.split("\n").filter((line) => line.startsWith("ACK_WARN "))).toHaveLength(visible ? 6 : 7);
    expect(stdout).toContain(`ACK_PENDING stream=context printed=${visible ? 1 : 0} withheld=${visible ? 6 : 7}`);
    expect(queue.pending("context").map((item) => item.payload)).toEqual(values.map((value) => JSON.stringify(value)));
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});
