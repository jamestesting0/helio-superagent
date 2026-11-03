import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts/helio-followups.py"
FAKE_GH = """#!{python}
import json, sys
args = sys.argv[1:]
issues = {{
    "1": {{"state": "OPEN"}},
    "2": {{"state": "CLOSED", "stateReason": "NOT_PLANNED", "comments": [{{"body": "Out of scope for this season."}}]}},
    "3": {{"state": "CLOSED", "stateReason": "COMPLETED", "closedByPullRequestsReferences": [{{"number": 30}}]}},
    "4": {{"state": "CLOSED", "stateReason": "COMPLETED", "closedByPullRequestsReferences": [{{"number": 40}}]}},
    "5": {{"state": "CLOSED", "stateReason": "COMPLETED", "closedByPullRequestsReferences": []}},
}}
if args[:2] == ["issue", "view"]:
    print(json.dumps({{"title": "t" + args[2], "url": "u" + args[2], **issues[args[2]]}}))
elif args[:2] == ["pr", "view"]:
    print(json.dumps({{"number": int(args[2]), "state": "MERGED", "mergeCommit": {{"oid": {merges}[args[2]]}}}}))
else:
    sys.exit(3)
"""


class FollowupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        git = lambda *a, cwd=None: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
        origin, project = root / "origin.git", root / "project"
        git("init", "--bare", "-b", "main", str(origin))
        git("clone", str(origin), str(project))
        git("config", "user.email", "t@example.invalid", cwd=project); git("config", "user.name", "T", cwd=project)
        commits = []
        for name in ("deployed fix", "newer fix"):
            (project / "f.txt").write_text(name)
            git("add", ".", cwd=project); git("commit", "-m", name, cwd=project)
            commits.append(git("rev-parse", "HEAD", cwd=project))
        git("push", "origin", "main", cwd=project)
        bins = root / "bin"; bins.mkdir()
        (bins / "gh").write_text(FAKE_GH.format(python=sys.executable, merges=json.dumps({"30": commits[0], "40": commits[1]})))
        (bins / "helio").write_text(f"#!/bin/sh\n[ \"$*\" = \"release inspect\" ] || exit 3\necho '{{\"head\": \"{commits[0]}\"}}'\n")
        for b in bins.iterdir():
            b.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bins}:{os.environ['PATH']}", "HELIO_GITHUB_REPO": "o/r",
                    "HELIO_PROJECT": str(project), "DORI_STATE_DIR": str(root / "state")}

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=self.env, timeout=60)

    def test_live_declined_done_and_waiting(self):
        for issue in range(1, 6):
            self.assertEqual(self.cli("add", "--issue", str(issue), "--channel", "100", "--user", "7", "--reply-to", str(900 + issue)).returncode, 0)
        out = self.cli("check").stdout.splitlines()
        events = {line.split(" ", 1)[0] + ":" + str(json.loads(line.split(" ", 1)[1])["issue"]) for line in out}
        self.assertEqual(events, {"FOLLOWUP_DECLINED:2", "FOLLOWUP_LIVE:3", "FOLLOWUP_DONE:5"})
        declined = json.loads(next(line for line in out if line.startswith("FOLLOWUP_DECLINED")).split(" ", 1)[1])
        self.assertEqual((declined["reason"], declined["reply_to"], declined["channel_id"]), ("Out of scope for this season.", "902", "100"))
        self.assertEqual(self.cli("done", "--issue", "3", "--user", "7").returncode, 0)
        listed = self.cli("list").stdout
        self.assertNotIn("issue=3 ", listed)
        self.assertIn("issue=4 user=7 kind=bug status=open", listed)
        self.assertIn("issue=2 user=7 kind=bug status=announced", listed)

    def test_unknown_follow_up_and_bad_ids_are_refused(self):
        self.assertEqual(self.cli("done", "--issue", "9", "--user", "7").returncode, 2)
        self.assertNotEqual(self.cli("add", "--issue", "1", "--channel", "abc", "--user", "7", "--reply-to", "1").returncode, 0)


if __name__ == "__main__":
    unittest.main()
