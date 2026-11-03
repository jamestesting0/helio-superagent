import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
const sourceSkill = join(import.meta.dir, "../../vendor/dori-mode/scripts/src");
const skillSrc = existsSync(sourceSkill) ? sourceSkill : join(homedir(), ".agents/skills/dori-mode/scripts/src");
const { fill } = await import(join(skillSrc, "config.ts"));
const { quoteForPane } = await import(join(skillSrc, "launch.ts"));

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "elobot browser env "));
  const dori = join(home, ".dori", "elobot");
  const bin = join(home, "fake bin");
  const browserBin = join(home, ".local", "bin");
  await Promise.all([
    mkdir(dori, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(browserBin, { recursive: true }),
    mkdir(join(home, "PythonProjects", "EloBot-dori"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(import.meta.dir, "start"), join(dori, "start")),
    copyFile(join(import.meta.dir, "browser-env"), join(dori, "browser-env")),
    writeFile(join(dori, "setup-prompt.md"), "test prompt"),
    writeFile(join(dori, "work-policy.md"), "test policy"),
    writeFile(join(dori, "env"), [
      "export DORI_DISCORD_TOKEN=fake",
      "export DORI_DISCORD_OWNER_ID=fake",
      "export DORI_DISCORD_ALLOWED=fake",
      'export DORI_STATE_DIR="$HOME/state"',
      'export DORI_CONFIG="$HOME/config.json"',
      "export HELIO_LEAD_MODEL=chatgpt-subscription/gpt-6.1-terra",
      "export HELIO_LEAD_THINKING=medium",
      "export HELIO_MODEL_ALLOW='chatgpt-subscription/*'",
      'export HELIO_BROWSER_SKILL="$HOME/.pi/agent/skills/browser-skill"',
    ].join("\n")),
    writeFile(join(bin, "python3"), [
      "#!/bin/bash",
      'if [[ "$1" == */helio-sessions.py && "$2" == new ]]; then echo 11111111-1111-4111-8111-111111111111; fi',
      'if [[ "$1" == */helio-sessions.py && "$2" == latest ]]; then echo "$HOME/existing-session.jsonl"; fi',
      "exit 0",
    ].join("\n"), { mode: 0o755 }),
    writeFile(join(bin, "bun"), "#!/bin/bash\nexit 0\n", { mode: 0o755 }),
    writeFile(join(browserBin, "bsk"), [
      "#!/bin/bash",
      'test "$BSK_HOME" = "$HOME/.bsk" || exit 42',
      "printf 'fake browser executed\\n'",
    ].join("\n"), { mode: 0o755 }),
    writeFile(join(bin, "omo"), [
      "#!/bin/bash",
      "set -eu",
      'printf "%s\\0" "$@" > "$HOME/agent-args"',
      'printf "%s" "$BSK_BIN" > "$HOME/agent-bsk-bin"',
      'bsk probe > "$HOME/browser-result"',
    ].join("\n"), { mode: 0o755 }),
  ]);
  return {
    home,
    dori,
    browser: join(browserBin, "bsk"),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, HERDR_PANE_ID: "test-pane", HELIO_PROJECT: join(home, "PythonProjects", "EloBot-dori") },
  };
}

async function run(argv: string[], env: Record<string, string>) {
  const child = Bun.spawn(argv, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(5000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}

async function agentResult(home: string) {
  const [args, browser, result] = await Promise.all([
    readFile(join(home, "agent-args"), "utf8"),
    readFile(join(home, "agent-bsk-bin"), "utf8"),
    readFile(join(home, "browser-result"), "utf8"),
  ]);
  return { args: args.slice(0, -1).split("\0"), browser, result };
}

test("lead startup provides the browser and automatic monitor kickoff", async () => {
  const f = await fixture();
  try {
    await run(["/bin/bash", join(f.dori, "start")], f.env);

    const result = await agentResult(f.home);
    expect(result.args.slice(0, -1)).toEqual([
        "--session-id", "11111111-1111-4111-8111-111111111111", "--no-ask-user",
        "--model", "chatgpt-subscription/gpt-6.1-terra", "--thinking", "medium", "--models", "chatgpt-subscription/*",
        "--skill", join(f.home, ".pi/agent/skills/browser-skill"),
        "--append-system-prompt", join(f.dori, "setup-prompt.md"),
        "--append-system-prompt", join(f.dori, "work-policy.md"),
    ]);
    expect(result.args.at(-1)).toStartWith("Start Helio mode.");
    expect({ browser: result.browser, result: result.result }).toEqual({ browser: f.browser, result: "fake browser executed\n" });
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("resume reopens the recorded lead and starts the monitors", async () => {
  const f = await fixture();
  try {
    await run(["/bin/bash", join(f.dori, "start"), "resume"], f.env);
    const result = await agentResult(f.home);
    expect(result.args.slice(0, 2)).toEqual(["--session", join(f.home, "existing-session.jsonl")]);
    expect(result.args.at(-1)).toStartWith("Resume Helio mode.");
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test("worker command exposes bsk and preserves model and prompt as literal arguments", async () => {
  const f = await fixture();
  try {
    const config = await Bun.file(join(import.meta.dir, "config.json")).json();
    const model = "model with spaces";
    const prompt = 'quotes "\' ; `literal` $(touch "$HOME/injected")\n--model other';
    const argv = fill(config.agentCommand, { model, prompt });

    // Only the expected local wrapper and fake agent may be launched by this test.
    expect(argv.slice(0, 3)).toEqual([
      "/bin/bash", "-c", 'source "$HOME/.dori/elobot/env" || exit; source "$HOME/.dori/elobot/browser-env" || exit; exec "$@"',
    ]);
    expect(argv[4]).toBe("/usr/bin/env");
    expect(argv[5]?.startsWith("DORI_CONFIG=")).toBe(true);
    expect(argv[6]?.startsWith("DORI_STATE_DIR=")).toBe(true);
    expect(argv[7]).toBe("omo");
    expect(argv[8]).toBe("--no-ask-user");
    await run(["/bin/bash", "-c", argv.map(quoteForPane).join(" ")], f.env);

    expect(argv[14]?.endsWith("/.dori/elobot/work-policy.md")).toBe(true);
    expect(await agentResult(f.home)).toEqual({
      args: ["--no-ask-user", "--models", "chatgpt-subscription/*", "--skill", argv[12], "--append-system-prompt", argv[14], "--model", model, prompt],
      browser: f.browser,
      result: "fake browser executed\n",
    });
    expect(await Bun.file(join(f.home, "injected")).exists()).toBe(false);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
