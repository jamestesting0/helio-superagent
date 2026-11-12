import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

// A minimal herdr: the named pane runs an idle agent that turns working once Enter is pressed.
const HERDR = `#!/bin/sh
state="$FAKE_HERDR_DIR"
echo "$*" >> "$state/calls"
case "$1 $2" in
  "pane list") status=idle; [ -f "$state/entered" ] && status=working
    printf '{"result":{"panes":[{"pane_id":"w9:p4","workspace_id":"w9","agent_status":"%s"},{"pane_id":"w1:p1","workspace_id":"w1","agent_status":"idle"}]}}' "$status" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"name":"omo","argv":["omo"]}]}}}' ;;
  "pane send-keys") touch "$state/entered" ;;
esac
`;

test("dori report delivers one [REPORT] line to the lead pane recorded at startup, not the stale configured one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-report-"));
  try {
    const bin = join(dir, "bin"), state = join(dir, "state");
    mkdirSync(bin); mkdirSync(join(state, "lanes"), { recursive: true });
    writeFileSync(join(bin, "herdr"), HERDR); chmodSync(join(bin, "herdr"), 0o755);
    writeFileSync(join(state, "lead-pane"), "w9:p4\n");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: state, leadPane: "w1:p1", leadPaneFile: join(state, "lead-pane") }));
    writeFileSync(join(state, "lanes", "issue23-x.json"), JSON.stringify({ key: "issue23-x", job: "issue-23", title: "t", thread: "none",
      brief: "/b", done: "closed o/r#23", openedAt: "2026-11-12T00:00:00Z", status: "working" }));
    writeFileSync(join(dir, "report.txt"), "Blocked: needs the owner's rounding choice.\n");
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_HERDR_DIR: dir,
      DORI_CONFIG: join(dir, "config.json"), DORI_STATE_DIR: state };
    delete env.DORI_LEAD_PANE;
    const child = Bun.spawn(["bun", CLI, "report", "issue23-x", "blocker", "--text-file", join(dir, "report.txt")], {
      env,
      stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    expect(out).toContain("REPORT_DELIVERED issue23-x pane=w9:p4");
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n");
    expect(calls).toContain("pane send-text w9:p4 [REPORT] issue23-x | blocker | Blocked: needs the owner's rounding choice.");
    expect(calls.some((line) => line.includes("w1:p1") && line.startsWith("pane send"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
