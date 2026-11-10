import json
import os
import sqlite3
import hashlib
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
    if os.environ.get("FOLLOWUP_REOPENED") == args[2]:
        issues[args[2]] = {{"state": "OPEN"}}
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

    def test_repeated_add_preserves_original_target_and_every_subscription_state(self):
        self.assertEqual(self.cli("add", "--issue", "2", "--channel", "100", "--user", "7", "--reply-to", "902").returncode, 0)
        path = Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite"
        for status in ("open", "announced", "done"):
            with self.subTest(status=status):
                with sqlite3.connect(path) as db:
                    db.execute("UPDATE followups SET status=?,announcement=?", (status, '{"event":"FOLLOWUP_DECLINED"}'))
                    original = db.execute("SELECT * FROM followups").fetchone()
                result = self.cli("add", "--issue", "2", "--channel", "101", "--user", "7", "--reply-to", "999", "--kind", "feature")
                self.assertEqual(result.returncode, 0, result.stderr)
                with sqlite3.connect(path) as db:
                    self.assertEqual(db.execute("SELECT * FROM followups").fetchone(), original)

    def test_legacy_done_requires_a_verified_terminal_send_receipt(self):
        self.assertEqual(self.cli("add", "--issue", "2", "--channel", "100", "--user", "7", "--reply-to", "902").returncode, 0)
        self.assertEqual(self.cli("check").returncode, 0)
        result = self.cli("done", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite") as db:
            self.assertEqual(db.execute("SELECT status FROM followups").fetchone()[0], "announced")

    def test_existing_schema_migration_preserves_historical_states_and_targets(self):
        path = Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite"
        path.parent.mkdir(parents=True)
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE followups(repo TEXT,issue INTEGER,user_id TEXT,channel_id TEXT,
                reply_to TEXT,kind TEXT,created_at INTEGER,status TEXT,PRIMARY KEY(repo,issue,user_id))""")
            for issue, status in enumerate(("open", "announced", "done"), start=1):
                db.execute("INSERT INTO followups VALUES('o/r',?,'7','100',?,'bug',0,?)",
                           (issue, str(900 + issue), status))
            before = db.execute("SELECT * FROM followups ORDER BY issue").fetchall()
        result = self.cli("list")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with sqlite3.connect(path) as db:
            after = db.execute("SELECT repo,issue,user_id,channel_id,reply_to,kind,created_at,status FROM followups ORDER BY issue").fetchall()
            self.assertEqual(after, before)
            self.assertEqual(db.execute("SELECT delivery_version FROM followups").fetchall(), [(0,), (0,), (0,)])

    def native_fixture(self):
        from plan_fixture import stage_source
        root = Path(self.tmp.name)
        state = Path(self.env["DORI_STATE_DIR"])
        stage_source(state, json.dumps({"message_id": "902", "channel_id": "100", "author_id": "7",
                                       "author": "Reporter", "content": "A bug report"}))
        preload = root / "native.ts"
        preload.write_text("""
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
globalThis.fetch = async(input, init) => {
  const url = String(input), method = init?.method ?? "GET";
  appendFileSync(process.env.NATIVE_LOG, JSON.stringify({url, method, body: init?.body})+"\\n");
  if (url.endsWith("/channels/100")) {
    if (process.env.NATIVE_FORBIDDEN === "1") return Response.json({message:"Forbidden"},{status:403});
    return Response.json({id:"100", type:0, guild_id:"1"});
  }
  if (url.endsWith("/channels/100/messages/902")) {
    if (process.env.NATIVE_DELETED === "1") return Response.json({code:10008},{status:404});
    if (process.env.NATIVE_REVOKE === "1") process.env.DORI_DISCORD_ALLOWED="9";
    return Response.json({id:"902",channel_id:"100",author:{id:"7"},content:"A bug report"});
  }
  if (url.endsWith("/users/@me")) return Response.json({id:"999"});
  if (url.includes("/channels/100/messages?")) {
    const file=process.env.NATIVE_ACCEPTED;
    return Response.json(file && existsSync(file) ? [{id:"9902",author:{id:"999"},
      content:JSON.parse(readFileSync(file,"utf8")).content,message_reference:{message_id:"902"}}] : []);
  }
  if (url.endsWith("/channels/100/messages") && method === "POST") {
    if (process.env.NATIVE_POST_FORBIDDEN === "1") return Response.json({message:"Forbidden"},{status:403});
    if (process.env.NATIVE_LOST === "1") {
      if (process.env.NATIVE_ACCEPTED) writeFileSync(process.env.NATIVE_ACCEPTED,init.body);
      throw new Error("Connection lost after native POST");
    }
    return Response.json({id:"9902"});
  }
  throw new Error("Unexpected native request "+url);
};
""")
        self.env.update({"HOME": str(root), "DORI_POLICY_DIR": "", "DORI_DISCORD_TOKEN": "offline",
                         "DORI_DISCORD_OWNER_ID": "100", "DORI_DISCORD_ALLOWED": "100",
                         "DORI_DISCORD_NORMAL_CHANNELS": "100", "DORI_DISCORD_TRUSTED_CHANNELS": "",
                         "DORI_DISCORD_SCOPE_CATEGORY": "", "DORI_DISCORD_IGNORED_CHANNELS": "",
                         "BUN_OPTIONS": f"--preload {preload}", "NATIVE_LOG": str(root / "native-log")})
        self.assertEqual(self.cli("add", "--issue", "2", "--channel", "100", "--user", "7", "--reply-to", "902").returncode, 0)
        return root / "native-log"

    def test_deliver_checks_current_outcome_and_completes_from_native_proof_once(self):
        log = self.native_fixture()
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("NOTIFICATION_SENT 9902", result.stdout)
        self.assertIn("FOLLOWUP_CLOSED", result.stdout)
        second = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sum(call["method"] == "POST" for call in calls), 1)
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite") as db:
            self.assertEqual(db.execute("SELECT status,delivered_reply_id FROM followups").fetchone(), ("done", "9902"))

    def test_deleted_target_closes_only_its_subscription_and_reports_once(self):
        log = self.native_fixture()
        self.env["NATIVE_DELETED"] = "1"
        first = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("REPLY_FOLLOWUP_CLOSED", first.stdout)
        second = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertNotIn("REPLY_FOLLOWUP_CLOSED", second.stdout)
        self.assertTrue(all(json.loads(line)["method"] == "GET" for line in log.read_text().splitlines()))

    def test_lost_native_response_recovers_the_same_terminal_send(self):
        log = self.native_fixture()
        self.env.update(NATIVE_LOST="1", NATIVE_ACCEPTED=str(Path(self.tmp.name) / "accepted"))
        first = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(first.returncode, 2, first.stdout + first.stderr)
        second = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(sum(json.loads(line)["method"] == "POST" for line in log.read_text().splitlines()), 1)

    def test_unproved_native_response_stays_announced_without_a_second_post(self):
        log = self.native_fixture()
        self.env["NATIVE_LOST"] = "1"
        for _ in range(2):
            result = self.cli("deliver", "--issue", "2", "--user", "7")
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(sum(json.loads(line)["method"] == "POST" for line in log.read_text().splitlines()), 1)
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite") as db:
            self.assertEqual(db.execute("SELECT status FROM followups").fetchone()[0], "announced")

    def test_stale_unsent_terminal_observation_returns_to_open(self):
        log = self.native_fixture()
        self.assertEqual(self.cli("check").returncode, 0)
        self.env["FOLLOWUP_REOPENED"] = "2"
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("FOLLOWUP_WAIT", result.stdout)
        self.assertFalse(log.exists())
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite") as db:
            self.assertEqual(db.execute("SELECT status,announcement FROM followups").fetchone(), ("open", None))

    def test_legacy_announced_delivery_stays_uncertain_and_open_can_transition(self):
        log = self.native_fixture()
        self.assertEqual(self.cli("check").returncode, 0)
        path = Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite"
        with sqlite3.connect(path) as db:
            db.execute("UPDATE followups SET delivery_version=0")
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertFalse(log.exists())
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute("SELECT status FROM followups").fetchone()[0], "announced")
            db.execute("UPDATE followups SET status='open',announcement=NULL")
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sum(json.loads(line)["method"] == "POST" for line in log.read_text().splitlines()), 1)

    def test_permission_denial_retains_subscription_without_another_destination(self):
        log = self.native_fixture()
        self.env["NATIVE_FORBIDDEN"] = "1"
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("NOTIFICATION_PERMISSION_DENIED", result.stdout)
        again = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(again.returncode, 2, again.stdout + again.stderr)
        self.assertNotIn("NOTIFICATION_PERMISSION_DENIED", again.stdout)
        self.assertTrue(all(json.loads(line)["method"] == "GET" for line in log.read_text().splitlines()))
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "discord-conversations.sqlite") as db:
            self.assertEqual(db.execute("SELECT status FROM followups").fetchone()[0], "announced")

    def test_definitively_rejected_post_can_resume_after_permission_is_restored(self):
        log = self.native_fixture()
        self.env["NATIVE_POST_FORBIDDEN"] = "1"
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.env.pop("NATIVE_POST_FORBIDDEN")
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sum(json.loads(line)["method"] == "POST" for line in log.read_text().splitlines()), 2)

    def test_policy_revoked_during_target_read_prevents_terminal_send(self):
        log = self.native_fixture()
        self.env["NATIVE_REVOKE"] = "1"
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(all(json.loads(line)["method"] == "GET" for line in log.read_text().splitlines()))

    def test_blocked_subscriber_cannot_receive_a_terminal_send(self):
        log = self.native_fixture()
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "discord-delivery.sqlite") as db:
            db.execute("""INSERT INTO blocked_users(user_id,source,reason,created_by,created_at)
                VALUES('7','owner','fixture block','100',0)""")
        result = self.cli("deliver", "--issue", "2", "--user", "7")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(all(json.loads(line)["method"] == "GET" for line in log.read_text().splitlines()))

    def test_live_declined_done_and_waiting(self):
        for issue in range(1, 6):
            self.assertEqual(self.cli("add", "--issue", str(issue), "--channel", "100", "--user", "7", "--reply-to", str(900 + issue)).returncode, 0)
        out = self.cli("check").stdout.splitlines()
        events = {line.split(" ", 1)[0] + ":" + str(json.loads(line.split(" ", 1)[1])["issue"]) for line in out}
        self.assertEqual(events, {"FOLLOWUP_DECLINED:2", "FOLLOWUP_LIVE:3", "FOLLOWUP_DONE:5"})
        page = json.loads(self.cli("show", "2").stdout)
        declined = json.loads(page["content"])[0]["announcement"]
        self.assertEqual((declined["reason"], declined["reply_to"], declined["channel_id"]), ("Out of scope for this season.", "902", "100"))
        identity = hashlib.sha256(json.dumps(["o/r", 3, "7", "100", "903"], separators=(",", ":")).encode()).hexdigest()
        with sqlite3.connect(Path(self.env["DORI_STATE_DIR"]) / "reply-sends.sqlite") as db:
            db.execute("""CREATE TABLE reply_sends(target TEXT,text_hash TEXT,state TEXT,reply_id TEXT)""")
            db.execute("INSERT INTO reply_sends VALUES(?,?,'sent','9903')", ("903", "event:followup:" + identity))
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
