import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the real controller entrypoint still answers privately while metadata is globally rate limited", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-main-"));
  try {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures/main-preload.ts"),
      join(import.meta.dir, "main.ts"), "serve"], {
      env: { ...process.env, HOME: home, DORI_DISCORD_TOKEN: "fixture", HELIO_ADMIN_STATE_DIR: home,
        HELIO_ADMIN_SOCKET: join(home, "absent.sock") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Controller fixture failed (${code}):\n${stdout}\n${stderr}`);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const response = stdout.split("\n").find(line => line.startsWith("RESPONSIVE_CALLBACK "));
    if (!response) throw new Error("Missing actual controller callback");
    const message = JSON.parse(response.slice("RESPONSIVE_CALLBACK ".length));
    expect(message.type).toBe(4);
    expect(message.data.flags).toBe(64);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("invalid credentials exit with the service's configuration-failure code", async () => {
  const home = mkdtempSync(join(tmpdir(), "helio-main-"));
  try {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures/main-preload.ts"),
      join(import.meta.dir, "main.ts"), "serve"], {
      env: { ...process.env, HOME: home, DORI_DISCORD_TOKEN: "fixture", HELIO_ADMIN_STATE_DIR: home,
        HELIO_ADMIN_SOCKET: join(home, "absent.sock"), HELIO_ADMIN_FIXTURE_MODE: "invalid-credentials" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(78);
    const report = stdout.split("\n").find(line => line.startsWith("ADMIN_COMMAND_SYNC "));
    if (!report) throw new Error("Missing configuration failure receipt");
    expect(JSON.parse(report.slice("ADMIN_COMMAND_SYNC ".length)).dm.problem).toBe("credentials");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
