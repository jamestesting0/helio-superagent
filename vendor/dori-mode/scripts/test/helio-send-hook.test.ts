import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

async function send(hook: string, ...extra: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "dori-send-hook-"));
  try {
    await writeFile(join(dir, "hook.ts"), hook);
    await writeFile(join(dir, "config.json"), JSON.stringify({ discordTextHook: join(dir, "hook.ts") }));
    await writeFile(join(dir, "text.txt"), "Thanks, James.");
    await writeFile(join(dir, "offline.ts"), `globalThis.fetch=async(input,init)=>{
      console.log("OFFLINE "+(init?.method??"GET")+" "+String(input)+" "+(init?.body??""));
      return Response.json({id:"345678901234567890"});
    };`);
    const child = Bun.spawn([process.execPath, "--preload", join(dir, "offline.ts"), CLI, "send", "discord", "--to", "123456789012345678",
      "--text-file", join(dir, "text.txt"), ...extra], {
      env: { ...process.env, DORI_CONFIG: join(dir, "config.json"), DORI_STATE_DIR: join(dir, "state"), DORI_DISCORD_TOKEN: "offline" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const requests = stdout.split("\n").filter(line => line.startsWith("OFFLINE "));
    return { code, stderr, requests };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a configured Discord text hook rewrites sends and edits before they leave", async () => {
  const hook = `export const formatDiscordText = async (text) => text.replace("James", "**[James](<https://discord.com/users/66?tab=wishlist>)**");`;
  for (const extra of [[], ["--edit", "234567890123456789"]]) {
    const { code, requests } = await send(hook, ...extra);
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.split(" ").slice(3).join(" ")).content)
      .toBe("Thanks, **[James](<https://discord.com/users/66?tab=wishlist>)**.");
  }
});

test("a hook module without formatDiscordText refuses the send", async () => {
  const { code, stderr, requests } = await send("export const other = 1;");
  expect(code).not.toBe(0);
  expect(stderr).toContain("does not export formatDiscordText");
  expect(requests).toEqual([]);
});
