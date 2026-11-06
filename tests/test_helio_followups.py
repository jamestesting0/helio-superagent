import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts/helio-followups.py"
FAKE_GH = """#!{python}
import json, os, subprocess, sys
args = sys.argv[1:]
if os.environ.get("FOLLOWUP_GH_LOG"):
    with open(os.environ["FOLLOWUP_GH_LOG"], "a") as log:
        log.write(" ".join(args[:3]) + "\\n")
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
elif args[:2] == ["pr", "list"]:
    print(os.environ.get("FOLLOWUP_PRS", "[]"))
elif args[:1] == ["api"] and "/branches/main" in args[1]:
    head = subprocess.run(["git", "ls-remote", "origin", "refs/heads/main"], cwd=os.environ["HELIO_PROJECT"],
                          capture_output=True, text=True, check=True).stdout.split()[0]
    print(head)
elif args[:1] == ["api"] and "/compare/" in args[1]:
    import subprocess
    base, head = args[1].split("/compare/")[1].split("?")[0].split("...")
    if head == os.environ.get("FOLLOWUP_UNAVAILABLE_HEAD"):
        sys.exit(3)
    common = subprocess.run(["git", "merge-base", base, head], cwd=os.environ["HELIO_PROJECT"],
                            capture_output=True, text=True, check=True).stdout.strip()
    print(json.dumps({{"merge_base_commit": {{"sha": common}}}}))
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
        (bins / "helio").write_text(f"#!/bin/sh\n[ \"$*\" = \"release inspect\" ] || exit 3\necho '{{\"head\": \"{commits[0]}\", \"running_revision\": \"{commits[0]}\", \"active\": true, \"login_evidence\": \"observed\"}}'\n")
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
        page = json.loads(self.cli("show", "2").stdout)
        declined = json.loads(page["content"])[0]["announcement"]
        self.assertEqual((declined["reason"], declined["reply_to"], declined["channel_id"]), ("Out of scope for this season.", "902", "100"))
        self.assertEqual(self.cli("done", "--issue", "3", "--user", "7").returncode, 0)
        listed = self.cli("list").stdout
        self.assertNotIn("issue=3 ", listed)
        self.assertIn("issue=4 user=7 kind=bug status=open", listed)
        self.assertIn("issue=2 user=7 kind=bug status=announced", listed)

    def test_unknown_follow_up_and_bad_ids_are_refused(self):
        self.assertEqual(self.cli("done", "--issue", "9", "--user", "7").returncode, 2)
        self.assertNotEqual(self.cli("add", "--issue", "1", "--channel", "abc", "--user", "7", "--reply-to", "1").returncode, 0)

    def test_one_check_reads_a_shared_issue_once_and_notifies_each_requester(self):
        log = Path(self.tmp.name) / "gh-reads"
        self.env["FOLLOWUP_GH_LOG"] = str(log)
        for user in ("7", "8"):
            self.assertEqual(self.cli("add", "--issue", "2", "--channel", "100", "--user", user, "--reply-to", "902").returncode, 0)
        result = self.cli("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line.split(" ", 1)[1]) for line in result.stdout.splitlines() if line.startswith("FOLLOWUP_DECLINED ")]
        self.assertEqual({event["user_id"] for event in events}, {"7", "8"})
        self.assertEqual([line for line in log.read_text().splitlines() if line.startswith("issue ")], ["issue view 2"])

    def test_open_pr_readiness_tracks_base_drift_ci_and_unknown_state(self):
        project = Path(self.env["HELIO_PROJECT"])
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=project, check=True, capture_output=True, text=True).stdout.strip()
        parent = subprocess.run(["git", "rev-parse", "HEAD^"], cwd=project, check=True, capture_output=True, text=True).stdout.strip()
        passing = [{"name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS"}]
        pull = {"number": 20, "url": "https://github.com/o/r/pull/20", "state": "OPEN",
                "headRefName": "helio/issue-20", "headRefOid": head, "baseRefName": "main", "baseRefOid": head,
                "isCrossRepository": False, "isDraft": False, "mergeable": "MERGEABLE",
                "mergeStateStatus": "CLEAN", "statusCheckRollup": passing}
        cases = [
            ({}, "FOLLOWUP_PR_READY"),
            ({"headRefOid": parent}, "FOLLOWUP_PR_REPAIR"),
            ({"headRefOid": parent, "baseRefOid": parent}, "FOLLOWUP_PR_REPAIR"),
            ({"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"}, "FOLLOWUP_PR_REPAIR"),
            ({"mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN"}, "FOLLOWUP_PR_WAIT"),
            ({"statusCheckRollup": [{"name": "unit", "status": "IN_PROGRESS"}]}, "FOLLOWUP_PR_WAIT"),
            ({"statusCheckRollup": [{"name": "unit", "status": "COMPLETED", "conclusion": "FAILURE"}]}, "FOLLOWUP_PR_REPAIR"),
            ({"statusCheckRollup": []}, "FOLLOWUP_PR_REPAIR"),
        ]
        for changes, expected in cases:
            with self.subTest(changes=changes):
                self.env["FOLLOWUP_PRS"] = json.dumps([{**pull, **changes}])
                result = self.cli("check")
                self.assertEqual(result.returncode, 0, result.stderr)
                lines = result.stdout.splitlines()
                self.assertEqual(len(lines), 1, result.stdout)
                line, = lines
                prefix, detail = line.split(" ", 1)
                self.assertEqual(prefix, expected)
                observation = json.loads(detail)
                self.assertEqual((observation["head"], observation["base"]), (changes.get("headRefOid", head), head))
                self.assertEqual(observation["read"], "helio pr check --number 20")
                self.assertLessEqual(len(line), 1000)

        self.env["FOLLOWUP_PRS"] = json.dumps([
            {**pull, "headRefName": "owner/work"},
            {**pull, "isCrossRepository": True},
            {**pull, "headRefOid": parent},
            {**pull, "number": 21},
        ])
        self.env["FOLLOWUP_UNAVAILABLE_HEAD"] = parent
        result = self.cli("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 2, result.stdout)
        warning, ready = lines
        self.assertTrue(warning.startswith("FOLLOWUP_WARN pr=20 "), warning)
        self.assertTrue(ready.startswith("FOLLOWUP_PR_READY "), ready)

    def test_checkout_only_evidence_never_announces_live(self):
        bins = Path(self.env["PATH"].split(":")[0])
        (bins / "helio").write_text('#!/bin/sh\necho \'{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","active":true,"login_evidence":"observed"}\'\n')
        self.assertEqual(self.cli("add", "--issue", "3", "--channel", "100", "--user", "7", "--reply-to", "903").returncode, 0)
        result = self.cli("check")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("FOLLOWUP_LIVE", result.stdout)
        self.assertIn("FOLLOWUP_WARN", result.stdout)


if __name__ == "__main__":
    unittest.main()
