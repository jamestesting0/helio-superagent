"""The triage helper surfaces existing issues, pull requests, lanes and unmerged branches."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/helio-triage.py"
FAKE_GH = """#!{python}
import json, sys
args = sys.argv[1:]
if args[:2] == ["issue", "list"]:
    print(json.dumps([
        {{"number": 2, "title": "Reveal opponent shows raw mention", "state": "OPEN", "closedAt": None, "url": "https://github.com/o/r/issues/2"}},
        {{"number": 1, "title": "Old fixed bug", "state": "CLOSED", "closedAt": "2020-01-01T00:00:00Z", "url": "https://github.com/o/r/issues/1"}},
    ]))
elif args[:2] == ["pr", "list"] and "files" in args[-1]:
    print(json.dumps([{{"number": 7, "title": "Fix DM mentions", "headRefName": "fix-dm", "url": "u7", "files": [{{"path": "cogs/final_commands.py"}}]}}]))
elif args[:2] == ["pr", "list"]:
    print(json.dumps([]))
else:
    sys.exit(3)
"""


class TriageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        bins = root / "bin"
        bins.mkdir()
        (bins / "gh").write_text(FAKE_GH.format(python=sys.executable))
        (bins / "gh").chmod(0o755)
        origin, project = root / "origin.git", root / "project"
        git = lambda *a, cwd=None: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)
        git("init", "--bare", "-b", "main", str(origin))
        git("clone", str(origin), str(project))
        for key, value in (("user.email", "t@example.invalid"), ("user.name", "T")):
            git("config", key, value, cwd=project)
        (project / "cogs").mkdir()
        (project / "cogs/final_commands.py").write_text("v1\n")
        git("add", ".", cwd=project); git("commit", "-m", "base", cwd=project); git("push", "origin", "main", cwd=project)
        git("checkout", "-b", "local-fix", cwd=project)
        (project / "cogs/final_commands.py").write_text("v2\n")
        git("commit", "-am", "fix reveal opponent", cwd=project)
        git("checkout", "main", cwd=project)
        self.running = git("rev-parse", "HEAD", cwd=project).stdout.decode().strip()
        (project / "cogs/final_commands.py").write_text("v3\n")
        git("commit", "-am", "guard mentions in DMs", cwd=project); git("push", "origin", "main", cwd=project)
        tip = git("rev-parse", "HEAD", cwd=project).stdout.decode().strip()
        (bins / "helio").write_text(f"#!/bin/sh\n[ \"$*\" = \"release inspect\" ] || exit 3\n"
                                    f"echo '{{\"head\": \"{self.running}\", \"tip\": \"{tip}\", \"active\": true}}'\n")
        (bins / "helio").chmod(0o755)
        lanes = root / "state/lanes"
        lanes.mkdir(parents=True)
        (lanes / "dm-mention.json").write_text(json.dumps({"status": "working", "title": "DM mention fix", "thread": "discord:1"}))
        (lanes / "old.json").write_text(json.dumps({"status": "closed", "title": "old"}))
        self.env = {**os.environ, "PATH": f"{bins}:{os.environ['PATH']}", "HELIO_GITHUB_REPO": "o/r",
                    "HELIO_PROJECT": str(project), "DORI_STATE_DIR": str(root / "state")}

    def test_reports_existing_work_from_every_source(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "reveal", "opponent", "--path", "cogs/final_commands.py"],
                                capture_output=True, text=True, env=self.env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        out = result.stdout
        self.assertIn("#2 [open] Reveal opponent shows raw mention", out)
        self.assertNotIn("Old fixed bug", out)
        self.assertIn("#7 Fix DM mentions (fix-dm) u7 [touches cogs/final_commands.py]", out)
        self.assertIn("dm-mention [working] DM mention fix", out)
        self.assertNotIn("old [closed]", out)
        self.assertIn("local-fix: 1 commit(s) not on main", out)
        self.assertRegex(out, r"== origin/main\n[0-9a-f]{40} ")
        self.assertIn(f"running {self.running} (service active)", out)
        self.assertIn("origin/main has 1 newer commit(s) touching those paths; they go live at the next restart", out)
        self.assertIn("guard mentions in DMs", out)

    def test_an_unavailable_source_is_reported_not_hidden(self):
        env = dict(self.env, HELIO_PROJECT=str(Path(self.tmp.name) / "missing"))
        result = subprocess.run([sys.executable, str(SCRIPT), "anything"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("UNAVAILABLE", result.stdout)
        self.assertIn("#2 [open]", result.stdout)


if __name__ == "__main__":
    unittest.main()
