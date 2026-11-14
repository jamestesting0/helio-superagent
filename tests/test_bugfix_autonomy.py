"""Confirmed bugs and authorized work reach a PR without another approval, and misses are reported."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import argparse
import contextlib
import datetime
import io
import shlex
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
NOW = datetime.datetime(2026, 11, 11, 12, 0, tzinfo=datetime.timezone.utc)
SHA = "a" * 40
OWNER, TRUSTED = "100", "200"


class StateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        env = patch.dict(os.environ, {"DORI_STATE_DIR": str(self.state), "HELIO_GITHUB_REPO": "o/r",
                                      "HELIO_PROJECT": str(self.root / "project"), "DORI_DISCORD_OWNER_ID": OWNER,
                                      "HELIO_AUTOFIX": "on", "HELIO_AUTOFIX_MAX_OPEN": "3"})
        env.start()
        self.addCleanup(env.stop)
        self.work = runpy.run_path(str(SCRIPTS / "helio-work.py"))

    def grant(self, issue=21, message="1", at=NOW, kind="request", holds=()):
        self.work["record"](self.work["Authorization"]("o/r", issue, message, "9", OWNER, at, "f" * 64, kind, holds))

    def lane(self, issue=21, status=None, closed=False):
        lanes = self.state / "lanes" / ("archive" if closed else "")
        lanes.mkdir(parents=True, exist_ok=True)
        lane = {"key": f"issue{issue}-fix", "job": f"issue-{issue}", "cwd": str(self.root / "tree"), "openedAt": NOW.isoformat(),
                "session": "s1"}
        if status:
            lane["status"] = status
        if closed:
            lane["closedAt"] = NOW.isoformat()
        (lanes / f"issue{issue}-fix.json").write_text(json.dumps(lane))


class StorageTests(StateCase):
    def test_existing_schema_migrates_and_keeps_its_rows(self):
        self.state.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(self.state / "work-authorizations.sqlite")) as db, db:
            db.execute("""CREATE TABLE authorizations (repo TEXT NOT NULL, issue INTEGER NOT NULL, message TEXT NOT NULL,
                channel TEXT NOT NULL, author TEXT NOT NULL, recorded_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
                source_hash TEXT, PRIMARY KEY(repo, issue, message))""")
            db.execute("INSERT INTO authorizations VALUES ('o/r',8,'5','9','100',?,0,NULL)", (NOW.isoformat(),))
        old = self.work["available"]("o/r", 8, NOW)
        self.assertEqual((old.kind, old.holds, old.blocked), ("request", (), None))
        first = self.work["cutoff"]()
        self.work["connect"]().close()
        self.assertEqual(self.work["cutoff"](), first)

    def test_kind_and_holds_round_trip_and_unknown_holds_are_refused(self):
        self.grant(kind="bug-report", holds=("no-pr",))
        grant = self.work["available"]("o/r", 21, NOW)
        self.assertEqual((grant.kind, grant.holds), ("bug-report", ("no-pr",)))
        with self.assertRaises(self.work["Refused"]):
            self.grant(message="2", holds=("no-merge",))

    def test_block_marks_the_newest_request_and_a_later_request_supersedes_it(self):
        self.grant()
        self.work["save_bugfix"]("o/r", 21, NOW, route="work", status="started")
        self.assertTrue(self.work["block"]("o/r", 21, "cannot reproduce", NOW))
        self.assertEqual(self.work["available"]("o/r", 21, NOW).blocked, "cannot reproduce")
        self.assertEqual(self.work["bugfix"]("o/r", 21)["status"], "blocked")
        self.grant(message="2", at=NOW + datetime.timedelta(minutes=1))
        self.assertIsNone(self.work["available"]("o/r", 21, NOW + datetime.timedelta(minutes=1)).blocked)
        self.assertFalse(self.work["block"]("o/r", 99, "nothing", NOW))

    def test_a_named_clear_resumes_only_an_automatic_fix_blocked_on_that_question(self):
        self.work["save_bugfix"]("o/r", 22, NOW, route="autofix", status="started")
        self.assertTrue(self.work["block"]("o/r", 22, "awaiting rounding answer", NOW, "q1"))
        self.assertFalse(self.work["unblock"]("o/r", 22, NOW, "q2"))
        self.assertEqual(self.work["bugfix"]("o/r", 22)["status"], "blocked")
        self.assertTrue(self.work["unblock"]("o/r", 22, NOW, "q1"))
        self.assertEqual((self.work["bugfix"]("o/r", 22)["status"], self.work["bugfix"]("o/r", 22)["blocked_question"]),
                         ("started", None))

    def test_consuming_a_published_request_keeps_later_holds_in_force(self):
        self.grant(message="1", at=NOW - datetime.timedelta(minutes=2))
        self.grant(message="0", at=NOW - datetime.timedelta(minutes=3))
        self.grant(message="2", at=NOW - datetime.timedelta(minutes=1), holds=("no-pr",))
        self.work["consume"]("o/r", 21, "1")
        newest = self.work["available"]("o/r", 21, NOW)
        self.assertEqual((newest.message, newest.holds), ("2", ("no-pr",)))
        with contextlib.closing(sqlite3.connect(self.state / "work-authorizations.sqlite")) as db:
            self.assertEqual(db.execute("SELECT message,used FROM authorizations ORDER BY message").fetchall(),
                             [("0", 1), ("1", 1), ("2", 0)])

    def test_events_repeat_only_on_change_or_after_six_hours(self):
        emit = self.work["should_emit"]
        self.assertTrue(emit("o/r", 21, "FOLLOWUP_PR_DUE", "none", NOW))
        self.assertFalse(emit("o/r", 21, "FOLLOWUP_PR_DUE", "none", NOW + datetime.timedelta(hours=1)))
        self.assertTrue(emit("o/r", 21, "FOLLOWUP_PR_DUE", "k:closed", NOW + datetime.timedelta(hours=1)))
        self.assertTrue(emit("o/r", 21, "FOLLOWUP_PR_DUE", "k:closed", NOW + datetime.timedelta(hours=7)))
        self.work["settle_events"]("o/r", set())
        self.assertTrue(emit("o/r", 21, "FOLLOWUP_PR_DUE", "k:closed", NOW + datetime.timedelta(hours=7)))


def pull(number, branch, closes=(), labels=(), body="", title="t"):
    return {"number": number, "url": f"https://github.com/o/r/pull/{number}", "headRefName": branch, "isCrossRepository": False,
            "closingIssuesReferences": [{"number": n} for n in closes], "labels": [{"name": n} for n in labels],
            "body": body, "title": title, "state": "OPEN", "headRefOid": SHA, "baseRefName": "main", "baseRefOid": SHA,
            "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [{"name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS"}]}


class IssueReadinessTests(unittest.TestCase):
    def setUp(self):
        self.readiness = runpy.run_path(str(SCRIPTS / "helio_pr_readiness.py"))

    def answer(self, open_pulls, merged=()):
        def run(argv):
            if argv[:2] == ["gh", "pr"] and "open" in argv:
                return json.dumps(open_pulls)
            if argv[:2] == ["gh", "pr"] and "merged" in argv:
                branch = argv[argv.index("--head") + 1]
                return json.dumps([{"number": 22, "url": "https://github.com/o/r/pull/22"}] if branch in merged else [])
            if "/branches/main" in argv[2]:
                return SHA
            return json.dumps({"merge_base_commit": {"sha": SHA}})
        return lambda issue: self.readiness["for_issue"]("o/r", issue, run)

    def test_open_canonical_or_closing_pr_reports_readiness(self):
        self.assertTrue(self.answer([pull(22, "helio/issue-21")])(21).startswith("FOLLOWUP_PR_READY "))
        self.assertTrue(self.answer([pull(22, "helio/named-lane", closes=(21,))])(21).startswith("FOLLOWUP_PR_READY "))

    def test_merged_canonical_pr_still_counts_and_absence_is_reported(self):
        self.assertTrue(self.answer([], merged=("helio/autofix-21",))(21).startswith("PR_MERGED "))
        self.assertEqual(self.answer([pull(9, "helio/issue-9")])(21), 'PR_NONE {"issue": 21}')


class LaneCase(StateCase):
    def setUp(self):
        super().setUp()
        self.lanes = runpy.run_path(str(SCRIPTS / "helio_task_lane.py"))
        origin, project = self.root / "origin.git", self.root / "project"
        git = lambda *args, cwd=self.root: subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout
        git("init", "--bare", "-b", "main", str(origin))
        git("clone", str(origin), str(project))
        git("-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "--allow-empty", "-m", "base", cwd=project)
        git("push", "origin", "main", cwd=project)
        self.project = project
        bins = self.root / "bin"
        bins.mkdir()
        (bins / "helio").write_text("#!/bin/sh\n")
        (bins / "helio").chmod(0o755)
        path = patch.dict(os.environ, {"PATH": f"{bins}:{os.environ['PATH']}"})
        path.start()
        self.addCleanup(path.stop)
        self.launches = []

    def command(self, argv, cwd=None):
        if argv[0] == "dori":
            self.launches.append(argv)
            return f"LAUNCHED {argv[2]} pane=w1:p1\nSTARTUP_OK {argv[2]}"
        return self.lanes["run"](argv, cwd)

    def task(self, route="work", holds=()):
        return self.lanes["Task"]("o/r", 21, "Aborted match colour", route, "Requested by the owner.", "discord:9:1", "owner", holds)


class LaneTests(LaneCase):
    def test_new_lane_gets_its_own_worktree_brief_and_pr_done_signal(self):
        key, line = self.lanes["start"](self.task(), self.project, self.command)
        self.assertEqual((key, line), ("issue21-aborted-match-colour", "LAUNCHED issue21-aborted-match-colour pane=w1:p1"))
        argv = self.launches[0]
        options = dict(zip(argv[3::2], argv[4::2]))
        self.assertEqual((options["--job"], options["--priority"], options["--source"]), ("issue-21", "owner", "discord:9:1"))
        self.assertTrue(options["--done"].startswith('command ["') and '"pr", "check", "--issue", "21"]' in options["--done"])
        self.assertIn('stdout~"^(FOLLOWUP_PR_READY|PR_MERGED) "', options["--done"])
        tree = Path(options["--cwd"])
        branch = subprocess.run(["git", "branch", "--show-current"], cwd=tree, capture_output=True, text=True).stdout.strip()
        self.assertEqual(branch, "helio/issue-21")
        brief = Path(options["--brief"]).read_text()
        self.assertIn("## Holds\nNone.", brief)
        self.assertIn(f"helio pr submit --issue 21 --result-file RESULT --report-file REPORT --worktree {tree}", brief)

    def autofix_tree(self):
        subprocess.run(["git", "worktree", "add", "-b", "helio/autofix-21", str(self.root / "tree"), "origin/main"],
                       cwd=self.project, check=True, capture_output=True)
        self.lane(closed=True)

    def branch(self, tree):
        return subprocess.run(["git", "branch", "--show-current"], cwd=tree, capture_output=True, text=True).stdout.strip()

    def test_archived_job_lane_is_woken_in_its_own_tree_with_holds_listed(self):
        self.autofix_tree()
        key, _ = self.lanes["start"](self.task("autofix", ("no-pr",)), self.project, self.command)
        options = dict(zip(self.launches[0][3::2], self.launches[0][4::2]))
        self.assertEqual((key, options["--cwd"]), ("issue21-fix", str(self.root / "tree")))
        brief = Path(options["--brief"]).read_text()
        self.assertIn("## Holds\nno-pr.", brief)
        self.assertIn("--worktree", brief)
        self.assertEqual(self.branch(self.root / "tree"), "helio/autofix-21")

    def test_explicit_work_on_an_automatic_fix_tree_continues_on_the_issue_branch(self):
        self.autofix_tree()
        (self.root / "tree" / "fix.py").write_text("kept = True\n")
        self.lanes["start"](self.task("work"), self.project, self.command)
        tree = self.root / "tree"
        self.assertEqual(self.branch(tree), "helio/issue-21")
        self.assertTrue((tree / "fix.py").exists())
        brief = Path(dict(zip(self.launches[0][3::2], self.launches[0][4::2]))["--brief"]).read_text()
        self.assertIn(f"Worktree: {tree} on helio/issue-21.", brief)

    def commit_fix(self):
        tree = self.root / "tree"
        (tree / "fix.py").write_text("fixed = True\n")
        for argv in (["add", "fix.py"], ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-m", "fix"]):
            subprocess.run(["git", *argv], cwd=tree, check=True, capture_output=True)
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=tree, capture_output=True, text=True).stdout.strip()

    def test_an_older_issue_branch_fast_forwards_and_keeps_the_committed_fix(self):
        self.autofix_tree()
        subprocess.run(["git", "branch", "helio/issue-21", "origin/main"], cwd=self.project, check=True, capture_output=True)
        fix = self.commit_fix()
        self.lanes["start"](self.task("work"), self.project, self.command)
        tree = self.root / "tree"
        self.assertEqual(self.branch(tree), "helio/issue-21")
        self.assertEqual(subprocess.run(["git", "rev-parse", "HEAD"], cwd=tree, capture_output=True, text=True).stdout.strip(), fix)

    def test_diverged_issue_and_autofix_branches_stop_without_losing_either(self):
        self.autofix_tree()
        subprocess.run(["git", "branch", "helio/issue-21", "origin/main"], cwd=self.project, check=True, capture_output=True)
        other = self.root / "other"
        subprocess.run(["git", "worktree", "add", str(other), "helio/issue-21"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "--allow-empty", "-m", "other"],
                       cwd=other, check=True, capture_output=True)
        subprocess.run(["git", "worktree", "remove", str(other)], cwd=self.project, check=True, capture_output=True)
        fix = self.commit_fix()
        with self.assertRaisesRegex(RuntimeError, "diverged"):
            self.lanes["start"](self.task("work"), self.project, self.command)
        self.assertEqual((self.branch(self.root / "tree"), self.launches), ("helio/autofix-21", []))
        self.assertEqual(subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root / "tree", capture_output=True, text=True).stdout.strip(), fix)

    def test_running_lane_gets_the_brief_without_a_second_launch(self):
        self.autofix_tree()
        self.lane(status="working")
        key, line = self.lanes["start"](self.task("work"), self.project, self.command)
        self.assertEqual(self.launches, [])
        self.assertTrue(line.startswith("LANE_EXISTS key=issue21-fix status=working brief="), line)
        self.assertEqual(self.branch(self.root / "tree"), "helio/autofix-21")

    def test_a_launch_race_reported_by_dori_is_a_receipt_not_a_failure(self):
        def racing(argv, cwd=None):
            if argv[0] == "dori":
                raise RuntimeError("LANE_EXISTS key=other status=working: send the new work to that lane")
            return self.lanes["run"](argv, cwd)
        _, line = self.lanes["start"](self.task(), self.project, racing)
        self.assertTrue(line.startswith("LANE_EXISTS key=other status=working"), line)


class FakeGitHub:
    def __init__(self, labels=("bug", "confirmed"), pulls=()):
        self.labels, self.pulls, self.edits = list(labels), list(pulls), []

    def run(self, argv, stdin=None):
        if argv[:3] == ["gh", "issue", "view"]:
            return json.dumps({"state": "OPEN", "title": "Aborted match colour", "labels": [{"name": n} for n in self.labels]})
        if argv[:3] == ["gh", "pr", "list"]:
            return json.dumps(self.pulls)
        if argv[:3] == ["gh", "issue", "edit"]:
            self.edits.append(argv)
            return ""
        raise AssertionError(argv)


class BugfixTests(StateCase):
    def setUp(self):
        super().setUp()
        self.bugfix = runpy.run_path(str(SCRIPTS / "helio-bugfix.py"))
        self.started = []
        lanes = patch.dict(self.bugfix["LANE"], {"start": lambda task, project: (self.started.append(task) or ("issue21-fix", "LAUNCHED issue21-fix"))})
        lanes.start()
        self.addCleanup(lanes.stop)

    def invoke(self, github, *extra, sender=OWNER):
        work = self.bugfix["WORK"]

        def authorize(args, gh, source, kind):
            if sender not in (OWNER, TRUSTED):
                raise self.bugfix["PLAN"]["Refused"]("sender is not currently an authorized release approver")
            work["record"](work["Authorization"]("o/r", args.issue, args.message, args.channel, sender, NOW, "f" * 64, kind))
            return ["WORK_AUTHORIZED"]

        out = io.StringIO()
        with patch.dict(self.bugfix["PLAN"], {"authorize_work": authorize}), contextlib.redirect_stdout(out):
            code = self.bugfix["main"](["start", "--issue", "21", *extra], github=github, discord=lambda m, c: {}, now=NOW)
        return code, out.getvalue().strip()

    def test_owner_report_routes_to_uncapped_work_with_bug_report_authority(self):
        code, out = self.invoke(FakeGitHub(), "--message", "1", "--channel", "9")
        self.assertEqual((code, out), (0, "BUGFIX_STARTED issue=21 route=work key=issue21-fix launch=LAUNCHED issue21-fix"))
        self.assertEqual(self.work["available"]("o/r", 21, NOW).kind, "bug-report")
        task = self.started[0]
        self.assertEqual((task.route, task.priority, task.holds), ("work", "owner", ()))
        self.assertEqual(self.work["bugfix"]("o/r", 21)["status"], "started")
        self.assertEqual(self.invoke(FakeGitHub(), "--message", "1", "--channel", "9")[0], 0)
        self.assertEqual([task.route for task in self.started], ["work", "work"])

    def test_untrusted_or_missing_source_uses_standing_autofix(self):
        code, out = self.invoke(FakeGitHub(), "--message", "1", "--channel", "9", sender="300")
        self.assertEqual(code, 0, out)
        self.assertIn("route=autofix", out)
        self.assertIn("source_unverified=", out)
        self.assertEqual(self.started[0].source, "discord:9:1")
        with self.assertRaises(self.work["Refused"]):
            self.work["available"]("o/r", 21, NOW)

    def test_full_autofix_cap_queues_instead_of_downgrading_and_retries_wait_for_capacity(self):
        busy = [pull(n, f"helio/autofix-{n}", labels=("helio-autofix",)) for n in (1, 2, 3)]
        for _ in range(2):
            self.assertEqual(self.invoke(FakeGitHub(pulls=busy)), (0, "BUGFIX_QUEUED issue=21 reason=autofix-cap"))
        self.assertEqual((self.started, self.work["bugfix"]("o/r", 21)["status"]), ([], "queued"))
        self.assertIn("route=autofix", self.invoke(FakeGitHub(pulls=busy[:2]))[1])
        self.assertEqual(len(self.started), 1)

    def test_resumed_work_carries_a_later_requester_hold_and_respects_a_block(self):
        self.invoke(FakeGitHub(), "--message", "1", "--channel", "9")
        later = NOW + datetime.timedelta(minutes=5)
        self.grant(message="2", at=later, holds=("no-commit", "no-push", "no-pr"))
        with patch.dict(self.bugfix["LANE"], {"start": lambda task, project: (self.started.append(task) or ("k", "LANE_WOKEN k"))}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.bugfix["main"](["start", "--issue", "21"], github=FakeGitHub(), discord=lambda m, c: {}, now=later)
        self.assertEqual(self.started[-1].holds, ("no-commit", "no-push", "no-pr"))
        self.work["block"]("o/r", 21, "needs a product decision", later)
        self.work["connect"]().execute("UPDATE bugfixes SET status='started'").connection.commit()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.bugfix["main"](["start", "--issue", "21"], github=FakeGitHub(), discord=lambda m, c: {}, now=later)
        self.assertIn("BUGFIX_BLOCKED", out.getvalue())

    def test_an_acknowledged_report_keeps_standing_autofix(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.bugfix["main"](["start", "--issue", "21", "--message", "1", "--channel", "9"], github=FakeGitHub(),
                                discord=lambda m, c: {"live": {"_helio_accepted_work": True}}, now=NOW)
        self.assertIn('route=autofix', out.getvalue())
        self.assertIn('source_unverified="report already acknowledged"', out.getvalue())
        with self.assertRaises(self.work["Refused"]):
            self.work["available"]("o/r", 21, NOW)

    def test_existing_pr_overlap_disabled_and_requester_skip(self):
        self.assertEqual(self.invoke(FakeGitHub(pulls=[pull(22, "helio/issue-21")]))[1],
                         "BUGFIX_EXISTS issue=21 pr=https://github.com/o/r/pull/22")
        github = FakeGitHub(pulls=[pull(30, "someone/else", body="Also fixes #21")])
        self.assertEqual(self.invoke(github)[1], 'BUGFIX_SKIPPED issue=21 reason="overlap: https://github.com/o/r/pull/30"')
        self.assertIn("needs-owner-review", github.edits[0])
        self.assertEqual(self.invoke(FakeGitHub())[1], 'BUGFIX_SKIPPED issue=21 reason="overlap: https://github.com/o/r/pull/30"')
        self.assertEqual(self.started, [])

    def test_kill_switch_and_requester_skip_record_their_reason(self):
        with patch.dict(os.environ, {"HELIO_AUTOFIX": "off"}):
            github = FakeGitHub()
            self.assertIn("disabled", self.invoke(github)[1])
            self.assertTrue(github.edits)
        self.work["connect"]().execute("DELETE FROM bugfixes").connection.commit()
        github = FakeGitHub()
        self.assertEqual(self.invoke(github, "--skip", "just log it")[1], 'BUGFIX_SKIPPED issue=21 reason="requester: just log it"')
        self.assertEqual(github.edits, [])

    def test_unconfirmed_issue_is_refused(self):
        self.assertEqual(self.invoke(FakeGitHub(labels=("bug",)))[0], 1)


class BackstopTests(StateCase):
    def setUp(self):
        super().setUp()
        self.followups = runpy.run_path(str(SCRIPTS / "helio-followups.py"))
        self.pulls, self.bugs = [], []

    def run_gh(self, argv, cwd=None):
        if argv[:3] == ["gh", "pr", "list"]:
            return json.dumps(self.pulls)
        if argv[:3] == ["gh", "issue", "list"]:
            return json.dumps(self.bugs)
        if argv[:3] == ["gh", "issue", "view"]:
            return json.dumps({"state": "OPEN"})
        raise AssertionError(argv)

    def lines(self, at=NOW):
        out = io.StringIO()
        with patch.dict(self.followups["check_work"].__globals__, {"run": self.run_gh}), contextlib.redirect_stdout(out):
            self.followups["check_work"](at)
        return [line for line in out.getvalue().splitlines() if line]

    def test_issue_21_state_is_reported_once_and_cleared_by_a_pr(self):
        self.grant(at=NOW - datetime.timedelta(minutes=30))
        self.lane(closed=True)
        first = self.lines()
        self.assertEqual(len(first), 1, first)
        self.assertTrue(first[0].startswith("FOLLOWUP_PR_DUE "))
        event = json.loads(first[0].split(" ", 1)[1])
        self.assertEqual((event["issue"], event["lane"], event["status"], event["resume"]),
                         (21, "issue21-fix", "closed", "helio work start --issue 21 --from-authorization"))
        self.assertEqual(self.lines(NOW + datetime.timedelta(minutes=5)), [])
        self.pulls = [pull(22, "helio/issue-21")]
        self.assertEqual(self.lines(NOW + datetime.timedelta(minutes=10)), [])
        self.pulls = []
        self.assertEqual(len(self.lines(NOW + datetime.timedelta(minutes=15))), 1)

    def test_holds_blocks_active_lanes_and_fresh_requests_stay_quiet(self):
        self.grant(at=NOW - datetime.timedelta(minutes=30), holds=("no-pr",))
        self.assertEqual(self.lines(), [])
        self.grant(issue=22, at=NOW - datetime.timedelta(minutes=30))
        self.lane(issue=22, status="working")
        self.grant(issue=23, at=NOW - datetime.timedelta(minutes=5))
        self.grant(issue=24, at=NOW - datetime.timedelta(minutes=30))
        self.work["block"]("o/r", 24, "needs a product decision", NOW)
        self.assertEqual(self.lines(), [])

    def test_started_bug_fix_without_pr_and_hibernated_lane_is_due(self):
        self.work["save_bugfix"]("o/r", 21, NOW - datetime.timedelta(minutes=40), route="autofix", status="started")
        self.lane(status="hibernated")
        due = self.lines()
        self.assertEqual(len(due), 1, due)
        self.assertIn('"resume": "helio bugfix start --issue 21"', due[0])

    def test_unstarted_confirmed_bug_after_cutoff_is_due_even_with_a_hand_added_label(self):
        cutoff = self.work["cutoff"]()
        self.bugs = [{"number": 21, "createdAt": (cutoff + datetime.timedelta(minutes=1)).isoformat()},
                     {"number": 5, "createdAt": (cutoff - datetime.timedelta(days=1)).isoformat()}]
        due = self.lines()
        self.assertEqual(len(due), 1, due)
        self.assertTrue(due[0].startswith('FOLLOWUP_BUGFIX_DUE {"issue": 21, "reason": "no-record"'))

    def test_queued_fix_is_due_when_capacity_returns(self):
        self.work["save_bugfix"]("o/r", 21, NOW, route="autofix", status="queued", reason="autofix-cap")
        self.pulls = [pull(n, f"helio/autofix-{n}", labels=("helio-autofix",)) for n in (1, 2, 3)]
        self.assertEqual(self.lines(), [])
        self.pulls = self.pulls[:2]
        self.assertIn('"reason": "capacity"', self.lines()[0])


class WorkStartTests(StateCase):
    def setUp(self):
        super().setUp()
        self.plan = runpy.run_path(str(SCRIPTS / "helio-plan.py"))
        self.started = []
        lanes = patch.dict(self.plan["LANE"], {"start": lambda task, project: (self.started.append(task) or ("issue21-fix", "LAUNCHED issue21-fix"))})
        lanes.start()
        self.addCleanup(lanes.stop)
        self.github = type("GitHub", (), {"issue": lambda _self, n: {"state": "OPEN", "title": "Aborted match colour"}})()

    def args(self, **values):
        defaults = {"issue": 21, "message": None, "channel": None, "from_authorization": True, "note_file": None, "hold": None, "now": NOW}
        return argparse.Namespace(**{**defaults, **values})

    def test_relaunch_from_recorded_authority_carries_its_holds(self):
        self.grant(holds=("no-pr",))
        lines = self.plan["start_work"](self.args(), self.github, None)
        self.assertEqual(lines, ["WORK_STARTED issue=21 key=issue21-fix holds=no-pr launch=LAUNCHED issue21-fix"])
        self.assertEqual((self.started[0].route, self.started[0].holds), ("work", ("no-pr",)))

    def test_blocked_work_is_not_relaunched_and_block_requires_unfinished_work(self):
        with self.assertRaises(self.plan["Refused"]):
            self.plan["block_work"](self.args(reason="no failing test"))
        self.grant()
        [blocked] = self.plan["block_work"](self.args(reason="no  failing\ntest"))
        self.assertTrue(blocked.startswith('WORK_BLOCKED issue=21 stage=pre-submit reason="no failing test" next='), blocked)
        self.assertIn("helio question ask", blocked)  # a decision is asked at once, never left parked
        with self.assertRaisesRegex(self.plan["Refused"], "blocked"):
            self.plan["start_work"](self.args(), self.github, None)
        self.assertEqual(self.started, [])


class LaneProfileTests(LaneCase):
    def settings(self, profile):
        policy = Path(os.environ["HOME"]) / ".dori/elobot/policy"
        policy.mkdir(parents=True, exist_ok=True)
        (policy / "lane-settings.json").write_text(json.dumps({"maxWorkers": 2, "hibernateAfterMin": 30, "laneProfile": profile}))
        self.addCleanup((policy / "lane-settings.json").unlink)

    def brief(self, task=None):
        self.lanes["start"](task or self.task(), self.project, self.command)
        argv = self.launches[-1]
        return dict(zip(argv[3::2], argv[4::2])), Path(dict(zip(argv[3::2], argv[4::2]))["--brief"]).read_text()

    def test_the_owner_setting_chooses_the_lane_profile(self):
        self.settings("direct")
        options, text = self.brief()
        self.assertEqual(options["--profile"], "direct")

    def test_an_explicit_thorough_request_wins_over_the_owner_setting(self):
        self.settings("direct")
        options, text = self.brief(self.lanes["Task"]("o/r", 21, "Aborted match colour", "work", "Requested by the owner.",
                                                      "discord:9:1", "owner", (), "", "thorough"))
        self.assertEqual(options["--profile"], "thorough")

    def test_every_brief_carries_submit_files_the_validators_accept(self):
        _, text = self.brief()
        self.assertIn(json.dumps(self.lanes["RESULT_EXAMPLE"]), text)
        self.assertIn(json.dumps(self.lanes["REPORT_EXAMPLE"]), text)


class SubmitExampleTests(StateCase):
    @staticmethod
    def offline(*_):
        raise RuntimeError("no Discord in offline tests")

    def run_plan(self, *argv):
        plan = runpy.run_path(str(SCRIPTS / "helio-plan.py"))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = plan["main"](list(argv), gh=FakeGitHub(), discord=self.offline)
            except SystemExit as exit:
                code = "usage" if exit.code == 2 else exit.code
            except Exception as error:  # the arguments parsed; this offline run stops at the first external call
                code = type(error).__name__
        return plan, code, out.getvalue(), err.getvalue()

    def test_the_printed_example_files_pass_the_submit_validators(self):
        plan, code, out, _ = self.run_plan("pr", "submit", "--example")
        printed = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(plan["check_result"](None, printed["result_file"]), printed["result_file"])
        posts = runpy.run_path(str(SCRIPTS / "helio_github_posts.py"))
        self.assertEqual(posts["report"](json.dumps(printed["report_file"]), True).summary, printed["report_file"]["summary"])

    def test_an_argument_error_prints_a_valid_example_that_parses(self):
        for argv in (("pr", "submit", "--issue", "23"), ("work", "unblock", "--issue", "23"), ("work", "start"),
                     ("work", "unblock", "--issue", "23", "--message", "1570186341193482241"),
                     ("work", "unblock", "--issue", "23", "--message", "1570186341193482241", "--channel", "1", "--named"),
                     ("work", "block", "--issue", "23"),
                     ("work", "unblock", "--issue", "-1", "--question", "6d1eabfab39a478db83b"),
                     ("pr", "submit", "--issue", "-1", "--result-file", "r", "--report-file", "p")):
            with self.subTest(argv=argv):
                _, code, _, err = self.run_plan(*argv)
                self.assertEqual(code, "usage")
                example = next(line for line in err.splitlines() if line.startswith("example: helio "))
                _, parsed, _, _ = self.run_plan(*shlex.split(example)[2:])
                self.assertNotEqual(parsed, "usage", example)


if __name__ == "__main__":
    unittest.main()
