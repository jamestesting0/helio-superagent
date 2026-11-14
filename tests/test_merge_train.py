"""Merge trains against real git repositories, with GitHub, Discord and the release broker as independent fakes."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import datetime
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
TRAIN = runpy.run_path(str(ROOT / "scripts/helio_merge_train.py"))
REPO = "o/r"
OWNER = "100000000000000001"


class Refused(Exception):
    pass


def git(*argv: str, cwd: Path) -> str:
    return subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@t", *argv], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


class GitHub:
    """A bare repository is GitHub: PR heads live under refs/pull/N/head, merges happen with a real `git merge`."""

    def __init__(self, root: Path) -> None:
        self.origin = root / "origin.git"
        subprocess.run(["git", "init", "--bare", "-b", "main", str(self.origin)], check=True, capture_output=True)
        self.work = root / "work"
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.work)], check=True, capture_output=True)
        (self.work / "app.py").write_text("A = 1\nB = 1\n")
        git("add", ".", cwd=self.work)
        git("commit", "-qm", "base", cwd=self.work)
        git("push", "-q", "origin", "HEAD:main", cwd=self.work)
        self.pulls: dict[int, dict] = {}
        self.ci_conclusions: list[str] = []
        self.runs: list[dict] = []
        self.jobs = ("Unit tests", "Integration tests")
        self.failed_log = "AssertionError: expected 1"
        self.rerun_lag = 0
        self.merges: list[int] = []
        self.before_merge = None

    def sha(self, ref: str) -> str:
        return git("rev-parse", ref, cwd=self.origin)

    def open_pr(self, number: int, path: str, text: str) -> str:
        git("checkout", "-q", "-B", f"pr{number}", "origin/main", cwd=self.work)
        (self.work / path).write_text(text)
        git("add", ".", cwd=self.work)
        git("commit", "-qm", f"pr {number}", cwd=self.work)
        git("push", "-q", "-f", "origin", f"HEAD:refs/heads/helio/issue-{number}", f"HEAD:refs/pull/{number}/head", cwd=self.work)
        git("fetch", "-q", cwd=self.work)
        self.pulls[number] = {"number": number, "title": f"Change {number}", "state": "OPEN", "headRefName": f"helio/issue-{number}",
                              "baseRefName": "main", "isDraft": False, "isCrossRepository": False, "mergeable": "MERGEABLE",
                              "mergeStateStatus": "CLEAN", "statusCheckRollup": [], "closingIssuesReferences": [], "body": ""}
        return self.sha(f"refs/pull/{number}/head")

    def push_main(self, path: str, text: str) -> None:
        git("fetch", "-q", cwd=self.work)
        git("checkout", "-q", "-B", "direct", "origin/main", cwd=self.work)
        (self.work / path).write_text(text)
        git("add", ".", cwd=self.work)
        git("commit", "-qm", "owner push", cwd=self.work)
        git("push", "-q", "origin", "HEAD:main", cwd=self.work)

    def merge(self, number: int, head: str) -> str:
        if self.before_merge:
            hook, self.before_merge = self.before_merge, None
            hook()
        assert self.sha(f"refs/pull/{number}/head") == head
        git("fetch", "-q", cwd=self.work)
        git("checkout", "-q", "-B", "m", "origin/main", cwd=self.work)
        git("merge", "-q", "--no-ff", "-m", f"Merge pull request #{number}", head, cwd=self.work)
        git("push", "-q", "origin", "HEAD:main", cwd=self.work)
        self.pulls[number].update(state="MERGED", mergeCommit={"oid": self.sha("main")})
        self.merges.append(number)
        return ""

    def view(self, number: int) -> dict:
        return {**self.pulls[number], "headRefOid": self.sha(f"refs/pull/{number}/head")}


class Case(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.gh = GitHub(root)
        self.project = root / "project"
        subprocess.run(["git", "clone", "-q", str(self.gh.origin), str(self.project)], check=True, capture_output=True)
        git("config", "user.name", "Helio", cwd=self.project)
        git("config", "user.email", "h@h", cwd=self.project)
        self.state = root / "state"
        self.state.mkdir()
        self.calls: list[list[str]] = []
        self.binds: dict[str, str] = {}
        self.lock: str | None = None
        self.holds: set[int] = set()
        self.failing: set[int] = set()
        self.restart_hold = False
        self.trusted = {OWNER}
        self.clock = [1_000_000.0]
        self.restarts: list[dict] = []
        env = patch.dict(os.environ, {"DORI_DISCORD_OWNER_ID": OWNER, "DORI_DISCORD_TOKEN": "t", "DORI_DISCORD_ALLOWED": "300"})
        env.start()
        self.addCleanup(env.stop)
        self.world = TRAIN["World"](repo=REPO, state=self.state, project=self.project, run=self.command,
                                    sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s), now=lambda: self.clock[0],
                                    check=self.check(), release={"exchange": self.exchange, "observe": self.observe})

    def check(self) -> dict:
        def no_holds(action, pull=None):
            if action == "restart" and self.restart_hold:
                raise Refused("a restart hold is active")
            if pull and pull.get("number") in self.holds:
                raise Refused(f"#{pull['number']} is held")

        def passing(rollup):
            if rollup == "FAILING":
                raise Refused("required checks are failing")

        def prompt_row(train):
            return {"status": "confirmed", "channel_id": "300", "message_id": "501", "result_message_id": "502"}
        return {"ISSUE_LINK": {"require_link": lambda *a: None}, "require_passing": passing,
                "require_no_holds": no_holds, "prompt_row": prompt_row, "api": lambda path, token: {"id": "88", "content": ""},
                "APPROVAL": {"check_click": lambda *a, **k: (OWNER, None), "Refused": Refused},
                "ids": lambda path: self.trusted, "BASE": self.state, "location": lambda channel, token, allowed: (True, False)}

    def exchange(self, request: dict) -> dict:
        self.restarts.append(request)
        return {"status": "restarted", "invocation": "inv-1"}

    def observe(self, invocation):
        return {"readiness": "login_observed", "observation": {"running_revision": self.gh.sha("main")}}

    def command(self, argv: list[str], cwd: Path | None = None, input: str | None = None, ok=(0,)) -> str:
        self.calls.append(argv)
        if argv[0] == "git":
            result = subprocess.run(["git", "-c", "user.name=Helio", "-c", "user.email=h@h", *argv[1:]], cwd=cwd or self.project,
                                    capture_output=True, text=True)
            if result.returncode not in ok:
                raise TRAIN["TrainError"](result.stderr)
            return result.stdout
        if argv[:2] == ["helio", "confirm"]:
            return self.confirm(argv[2:])
        args = argv[1:]
        if args[:2] == ["pr", "view"]:
            number = int(args[2])
            return json.dumps({**self.gh.view(number), **({"statusCheckRollup": "FAILING"} if number in self.failing else {})})
        if args[:2] == ["pr", "list"]:
            return json.dumps([{"number": n} for n, p in self.gh.pulls.items() if p["state"] == "OPEN"])
        if args[:2] == ["pr", "merge"]:
            return self.gh.merge(int(args[2]), args[args.index("--match-head-commit") + 1])
        if args[:2] == ["workflow", "run"]:
            branch = args[args.index("--ref") + 1]
            self.gh.runs.append({"databaseId": 100 + len(self.gh.runs), "headSha": self.gh.sha(f"refs/heads/{branch}"),
                                 "branch": branch, "attempt": 1})
            return ""
        if args[:2] == ["run", "list"]:
            branch = args[args.index("--branch") + 1]
            return json.dumps([{"databaseId": r["databaseId"], "headSha": r["headSha"]} for r in self.gh.runs if r["branch"] == branch])
        if args[:2] == ["run", "view"] and "--log-failed" in args:
            return self.gh.failed_log
        if args[:2] == ["run", "view"]:
            record = next(r for r in self.gh.runs if r["databaseId"] == int(args[2]))
            if record.get("stale"):  # GitHub still shows the previous, failed attempt while the rerun is queued
                record["stale"] -= 1
                return json.dumps({"status": "completed", "conclusion": "failure", "headSha": record["headSha"],
                                   "attempt": record["attempt"] - 1, "jobs": [{"name": n, "conclusion": "failure", "steps": []}
                                                                              for n in self.gh.jobs]})
            conclusion = self.gh.ci_conclusions.pop(0) if self.gh.ci_conclusions else "success"
            jobs = [{"name": name, "databaseId": 900 + index, "conclusion": conclusion if index == 0 else "success",
                     "steps": [{"name": "Run unit tests" if index == 0 else "Run integration tests",
                                "conclusion": "skipped" if "resolving" in self.gh.failed_log else
                                ("failure" if conclusion != "success" and index == 0 else "success")}]}
                    for index, name in enumerate(self.gh.jobs)]
            return json.dumps({"status": "completed", "conclusion": conclusion, "headSha": record["headSha"],
                               "attempt": record["attempt"], "jobs": jobs})
        if args[:2] == ["run", "rerun"]:
            record = next(r for r in self.gh.runs if r["databaseId"] == int(args[2]))
            record["attempt"] += 1
            record["stale"] = self.gh.rerun_lag
            return ""
        if args[0] == "api":
            path = next(a for a in args if a.startswith("repos/"))
            if path.endswith("/branches/main"):
                return self.gh.sha("main")
            if "/compare/" in path:
                base, head = path.split("/compare/")[1].split("...")
                return json.dumps(git("log", "--format=%B%x00", f"{base}..{head}", cwd=self.gh.origin).strip("\x00\n").split("\x00\n"))
            if "-X" in args:
                return ""
            commit = path.rsplit("/", 1)[1]
            if "[.parents[].sha]" in args:
                return json.dumps(git("rev-list", "--parents", "-n1", commit, cwd=self.gh.origin).split()[1:])
            return self.gh.sha(f"{commit}^{{tree}}")
        raise AssertionError(argv)

    def confirm(self, args: list[str]) -> str:
        if args[0] == "train":
            return "CONFIRM_ASKED {}"
        if args[0] == "unlock":
            self.lock = None
            return "CONFIRM_UNLOCKED"
        train = args[args.index("--train") + 1]
        key = args[1] + args[2]
        if key in self.binds and self.binds[key] != train:
            return 'CONFIRM_BIND {"outcome":"unusable"}'
        if self.lock not in (None, train):
            return 'CONFIRM_BIND {"outcome":"locked"}'
        self.binds[key], self.lock = train, train
        return json.dumps({"x": 1}).replace('{"x": 1}', "") + 'CONFIRM_BIND ' + json.dumps(
            {"train": train, "outcome": "bound", "approver": OWNER, "approved_at": self.clock[0] * 1000})

    def plan(self, *prs: int, restart: bool = True) -> dict:
        lines = TRAIN["plan"](self.world, list(prs), None, restart, "400", "300")
        ready = [json.loads(line.split(" ", 1)[1]) for line in lines if line.startswith(("MERGE_TRAIN_READY", "MERGE_TRAIN_BLOCKED"))]
        self.assertEqual(len(ready), 1, lines)
        return ready[0]

    def approve(self, train: str) -> None:
        TRAIN["ask"](self.world, train)


class MergeTrainTests(Case):
    def test_three_prs_take_one_approval_merge_back_to_back_and_ship_the_tested_tree(self):
        """2026-11-13: five PRs took 8 decisions and each merge staled the others; now one click merges all."""
        for number, path in ((18, "a.py"), (20, "b.py"), (22, "c.py")):
            self.gh.open_pr(number, path, f"x = {number}\n")
        ready = self.plan(18, 20, 22)
        self.approve(ready["id"])
        prompt = TRAIN["load"](self.world, ready["id"])["prompt"]
        self.assertTrue(prompt.startswith("Merge 3 PRs and restart Elo Bot?\n[PR #18](<https://github.com/o/r/pull/18>) · `"))
        self.assertEqual(prompt.count("pull/18"), 1)
        lines = TRAIN["run"](self.world, ready["id"])
        done = json.loads(lines[-1].split(" ", 1)[1])
        self.assertEqual((done["merged"], self.gh.merges), ([18, 20, 22], [18, 20, 22]))
        self.assertEqual(self.gh.sha("main^{tree}"), TRAIN["load"](self.world, ready["id"])["tree"])
        self.assertEqual(self.restarts, [{"action": "restart", "channel_id": "300", "message_id": "502", "revision": self.gh.sha("main")}])
        self.assertTrue(done["message"].startswith("Merged #18, #20 and #22. Elo Bot restarted on `"))
        self.assertNotIn("release gate", done["message"])
        self.assertIsNone(self.lock)

    def test_a_pr_that_conflicts_with_an_earlier_member_is_left_out_with_the_file_named(self):
        self.gh.open_pr(18, "app.py", "A = 2\nB = 1\n")
        self.gh.open_pr(20, "app.py", "A = 3\nB = 1\n")
        self.gh.open_pr(22, "c.py", "c = 1\n")
        ready = self.plan(18, 20, 22, restart=False)
        self.assertEqual(ready["members"], [18, 22])
        self.assertEqual([(x["pr"], x["reason"]) for x in ready["excluded"]], [(20, "conflicts with #18 in app.py")])
        self.approve(ready["id"])
        done = json.loads(TRAIN["run"](self.world, ready["id"])[-1].split(" ", 1)[1])
        self.assertEqual(done["merged"], [18, 22])
        self.assertIn("#20 is next: it conflicts with #18 in app.py.", done["message"])
        self.assertEqual(self.restarts, [])

    def test_main_moving_before_the_run_is_retested_without_asking_again(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        self.approve(ready["id"])
        self.gh.push_main("owner.py", "o = 1\n")
        done = json.loads(TRAIN["run"](self.world, ready["id"])[-1].split(" ", 1)[1])
        self.assertEqual(done["merged"], [18])
        self.assertEqual(self.gh.sha("main^{tree}"), TRAIN["load"](self.world, ready["id"])["tree"])
        self.assertEqual(sum(1 for c in self.calls if c[:3] == ["gh", "workflow", "run"]), 2)

    def test_a_push_to_main_during_the_merges_stops_before_the_restart_and_resume_reports_it(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.open_pr(20, "b.py", "y = 1\n")
        ready = self.plan(18, 20)
        self.approve(ready["id"])
        merge = self.gh.merge
        self.gh.merge = lambda n, h: (self.gh.push_main("owner.py", "o = 1\n") if n == 20 else None) or merge(n, h)
        lines = TRAIN["run"](self.world, ready["id"])
        self.assertTrue(lines[-1].startswith("MERGE_TRAIN_STOPPED"), lines)
        self.assertEqual((self.gh.merges, self.restarts), ([18, 20], []))  # GitHub merged #20 onto the moved main
        stopped = json.loads(lines[-1].split(" ", 1)[1])
        self.assertIn("Merged #18 and #20.", stopped["message"])
        self.assertIn("someone pushed to main while #20 was merging", stopped["reason"])

    def test_an_interrupted_run_resumes_without_merging_anything_twice(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.open_pr(20, "b.py", "y = 1\n")
        ready = self.plan(18, 20, restart=False)
        self.approve(ready["id"])
        merge = self.gh.merge

        def crash(number, head):
            merge(number, head)
            if number == 18:
                raise KeyboardInterrupt
        self.gh.merge = crash
        with self.assertRaises(KeyboardInterrupt):
            TRAIN["run"](self.world, ready["id"])
        self.gh.merge = merge
        train = TRAIN["load"](self.world, ready["id"])
        self.assertEqual(train["status"], "merging")
        # The journal did not record #18's merge before the crash; GitHub's state shows it merged at the approved head.
        lines = TRAIN["run"](self.world, ready["id"])
        self.assertTrue(lines[-1].startswith("MERGE_TRAIN_DONE"), lines)
        self.assertEqual(self.gh.merges, [18, 20])

    def test_a_hold_added_after_approval_stops_the_next_merge(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.open_pr(20, "b.py", "y = 1\n")
        ready = self.plan(18, 20, restart=False)
        self.approve(ready["id"])
        self.holds.add(20)
        lines = TRAIN["run"](self.world, ready["id"])
        self.assertTrue(lines[-1].startswith("MERGE_TRAIN_STOPPED"))
        self.assertIn("#20 is held", lines[-1])
        self.assertEqual(self.gh.merges, [])

    def test_trust_removed_or_an_old_approval_stops_the_run(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        self.approve(ready["id"])
        self.trusted = set()
        with patch.dict(os.environ, {"DORI_DISCORD_OWNER_ID": "999"}):
            self.assertIn("no longer the owner", TRAIN["run"](self.world, ready["id"])[-1])
        self.clock[0] += 13 * 3600
        self.assertIn("more than 12 hours old", TRAIN["run"](self.world, ready["id"])[-1])
        self.assertEqual(self.gh.merges, [])

    def test_a_second_train_waits_for_the_lock_without_consuming_its_approval(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        first = self.plan(18, restart=False)
        self.approve(first["id"])
        self.lock = "another-train-holds-it"
        lines = TRAIN["run"](self.world, first["id"])
        self.assertTrue(lines[0].startswith("MERGE_TRAIN_WAITING"))
        self.assertEqual(TRAIN["load"](self.world, first["id"])["status"], "binding")  # verified, recorded, waiting for the lock
        self.lock = None
        self.binds.clear()
        self.assertTrue(TRAIN["run"](self.world, first["id"])[-1].startswith("MERGE_TRAIN_DONE"))

    def test_a_combined_ci_failure_blocks_and_dropping_the_breaking_pr_replans_the_rest(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.open_pr(20, "b.py", "y = 1\n")
        self.gh.ci_conclusions = ["failure", "failure"]
        blocked = self.plan(18, 20, restart=False)
        self.assertIn("Unit tests failed with all of them together", blocked["reason"])
        lines = TRAIN["drop"](self.world, blocked["id"], 20)
        self.assertTrue(lines[0].startswith("MERGE_TRAIN_DROPPED"))
        ready = json.loads(lines[-1].split(" ", 1)[1])
        self.assertEqual(ready["members"], [18])

    def test_unknown_mergeability_is_waited_out_never_refused(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.pulls[18]["mergeable"] = "UNKNOWN"
        view = self.gh.view
        self.gh.view = lambda n: (self.gh.pulls[n].update(mergeable="MERGEABLE") if self.clock[0] > 1_000_020 else None) or view(n)
        self.assertEqual(self.plan(18)["members"], [18])

    def test_a_left_out_pr_is_announced_once_when_it_becomes_ready(self):
        self.gh.open_pr(18, "app.py", "A = 2\nB = 1\n")
        self.gh.open_pr(20, "app.py", "A = 3\nB = 1\n")
        ready = self.plan(18, 20)
        self.approve(ready["id"])
        TRAIN["run"](self.world, ready["id"])
        states = {20: "FOLLOWUP_PR_REPAIR {}"}
        self.assertEqual(TRAIN["followups"](self.state, REPO, lambda n: states[n]), [])
        states[20] = "FOLLOWUP_PR_READY {}"
        [announced] = TRAIN["followups"](self.state, REPO, lambda n: states[n])
        self.assertIn('"next":"helio merge plan --pr 20 --request 400 --channel 300 --restart"', announced)
        self.assertEqual(TRAIN["followups"](self.state, REPO, lambda n: states[n]), [])

    # Gate review 2026-11-13 reproductions

    def test_a_failed_rebuild_stays_stopped_and_never_merges_on_resume(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        self.approve(ready["id"])
        self.gh.push_main("owner.py", "o = 1\n")
        self.gh.ci_conclusions = ["failure"]
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_STOPPED"))
        dispatches = len(self.gh.runs)
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_STOPPED"))
        self.assertEqual((self.gh.merges, len(self.gh.runs)), ([], dispatches))

    def test_ci_needs_both_required_jobs_on_the_run_it_dispatched(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.jobs = ("Unit tests",)
        self.assertIn("CI did not run Integration tests", self.plan(18)["reason"])
        self.gh.jobs = ("Unit tests", "Integration tests")
        ready = self.plan(18)
        record = TRAIN["load"](self.world, ready["id"])["ci"]
        self.assertEqual((record["run"], record["attempt"], record["passed"]), (self.gh.runs[-1]["databaseId"], 1, True))

    def test_only_an_infrastructure_failure_is_rerun(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.ci_conclusions = ["failure"]
        self.assertIn("Unit tests failed", self.plan(18)["reason"])
        self.assertFalse(any(c[:3] == ["gh", "run", "rerun"] for c in self.calls))
        self.gh.ci_conclusions, self.gh.failed_log = ["failure"], "Temporary failure resolving 'archive.ubuntu.com'"
        ready = self.plan(18)
        self.assertEqual(TRAIN["load"](self.world, ready["id"])["ci"]["attempt"], 2)

    def test_a_failing_check_after_approval_stops_before_any_merge(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        self.approve(ready["id"])
        self.failing.add(18)
        self.assertIn("required checks are failing", TRAIN["run"](self.world, ready["id"])[-1])
        self.assertEqual(self.gh.merges, [])

    def test_a_restart_hold_stops_the_restart_after_the_merges(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18)
        self.approve(ready["id"])
        self.restart_hold = True
        self.assertIn("a restart hold is active", TRAIN["run"](self.world, ready["id"])[-1])
        self.assertEqual((self.gh.merges, self.restarts), ([18], []))

    def test_a_restart_cut_short_is_observed_before_done_and_an_old_revision_is_never_success(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18)
        self.approve(ready["id"])
        exchange = self.exchange

        def crash(request):
            exchange(request)
            raise KeyboardInterrupt  # the broker restarted, but the receipt was never recorded
        self.world.release["exchange"] = crash
        with self.assertRaises(KeyboardInterrupt):
            TRAIN["run"](self.world, ready["id"])
        inspected = {"running_revision": "0" * 40, "login_evidence": "observed", "login_observed_at": "2026-11-13T00:00:00Z",
                     "process_started_at": "1970-01-01T00:00:00Z"}  # started before the restart request
        self.world.release["exchange"] = lambda request: inspected
        line = TRAIN["run"](self.world, ready["id"])[-1]
        self.assertTrue(line.startswith("MERGE_TRAIN_UNCERTAIN"), line)
        self.assertEqual(TRAIN["load"](self.world, ready["id"])["status"], "restarting")
        inspected.update(running_revision=self.gh.sha("main"), login_observed_at="2100-01-01T00:00:00Z")
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_UNCERTAIN"))  # old process, later login
        inspected.update(process_started_at="2100-01-01T00:00:00Z")
        done = json.loads(TRAIN["run"](self.world, ready["id"])[-1].split(" ", 1)[1])
        self.assertIn("is back online", done["message"])
        self.assertEqual(len(self.restarts), 1)

    def test_an_uncertain_broker_result_is_inspected_and_never_requested_again(self):
        """The real broker returns {"status": "uncertain"} (no exception) after a possible effect."""
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18)
        self.approve(ready["id"])
        requests = []
        self.world.release["exchange"] = lambda request: requests.append(request["action"]) or (
            {"status": "uncertain", "previous_revision": "0" * 40} if request["action"] == "restart" else
            {"running_revision": self.gh.sha("main"), "login_evidence": "observed", "login_observed_at": "2100-01-01T00:00:00Z",
             "process_started_at": "2100-01-01T00:00:00Z"})
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_UNCERTAIN"))
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        self.assertEqual(requests, ["restart", "inspect"])

    def test_process_start_times_are_read_in_the_broker_s_systemd_format(self):
        self.assertTrue(TRAIN["after"]("Fri 2026-11-13 16:00:00 UTC", 1794585600))
        self.assertFalse(TRAIN["after"]("Fri 2026-11-13 15:59:59 UTC", 1794585600))
        self.assertFalse(TRAIN["after"]("Fri 2026-11-13 18:00:00 CET", 0))  # an unknown zone never proves a restart

    def test_a_lost_release_response_is_inspected_and_never_requested_again(self):
        """Gate review 2026-11-13: the real client raises ReleaseError when the response is lost after the effect."""
        class ReleaseError(Exception):
            pass
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18)
        self.approve(ready["id"])
        requests = []

        def exchange(request):
            requests.append(request["action"])
            if request["action"] == "restart":
                raise ReleaseError("Release response was incomplete; inspect before retrying")
            return {"running_revision": self.gh.sha("main"), "login_evidence": "observed",
                    "login_observed_at": "2100-01-01T00:00:00Z", "process_started_at": "2100-01-01T00:00:00Z"}
        self.world.release["exchange"] = exchange
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_UNCERTAIN"))
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        self.assertEqual(requests, ["restart", "inspect"])

    def test_two_follow_up_checks_at_once_announce_a_pr_once(self):
        self.gh.open_pr(18, "app.py", "A = 2\nB = 1\n")
        self.gh.open_pr(20, "app.py", "A = 3\nB = 1\n")
        ready = self.plan(18, 20, restart=False)
        self.approve(ready["id"])
        TRAIN["run"](self.world, ready["id"])
        both = []
        def ready_while_the_other_checks(number):  # the second check runs between the first one's read and its claim
            if not both:
                both.append(TRAIN["followups"](self.state, REPO, lambda n: "FOLLOWUP_PR_READY {}"))
            return "FOLLOWUP_PR_READY {}"
        first = TRAIN["followups"](self.state, REPO, ready_while_the_other_checks)
        self.assertEqual(len(first) + len(both[0]), 1)

    def test_an_outdated_release_broker_holds_the_restart_and_keeps_the_approval_unused(self):
        """2026-11-13: the root broker was older than Helio and refused the train's restart; the approval was wasted."""
        self.gh.open_pr(18, "a.py", "x = 1\n")
        current = [False]
        self.world.broker_current = lambda: current[0]
        ready_lines = TRAIN["plan"](self.world, [18], None, True, "400", "300")
        self.assertTrue(ready_lines[0].startswith("HELIO_INCIDENT ") and "--apply" in ready_lines[0])
        ready = json.loads(ready_lines[-1].split(" ", 1)[1])
        self.approve(ready["id"])
        lines = TRAIN["run"](self.world, ready["id"])
        self.assertTrue(lines[-1].startswith("MERGE_TRAIN_WAITING_BROKER"), lines)
        self.assertIn("as soon as a server update finishes", lines[-1])
        self.assertEqual((self.gh.merges, self.restarts), ([18], []))
        current[0] = True
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        self.assertEqual(len(self.restarts), 1)

    def test_a_restart_prompt_names_already_merged_prs_it_would_also_deploy(self):
        running = self.gh.sha("main")
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.merge(18, self.gh.sha("refs/pull/18/head"))
        self.gh.open_pr(20, "b.py", "y = 1\n")
        self.world.running_revision = lambda: running
        ready = self.plan(20)
        prompt = TRAIN["prompt_text"](self.world, TRAIN["load"](self.world, ready["id"]))
        self.assertIn("Also deploys already-merged #18.", prompt)
        self.assertNotIn("already-merged", TRAIN["prompt_text"](self.world, {**TRAIN["load"](self.world, ready["id"]), "restart": False}))

    def test_a_stopped_restart_is_reasked_once_with_its_full_scope_and_nothing_merges_again(self):
        """Gate review: a train refused for an incomplete restart scope had no way to ask again."""
        running = self.gh.sha("main")
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.merge(18, self.gh.sha("refs/pull/18/head"))
        self.gh.open_pr(27, "b.py", "y = 1\n")
        ready = self.plan(27)
        self.approve(ready["id"])
        train = TRAIN["load"](self.world, ready["id"])
        del train["ships"]  # planned before restart prompts named already-merged PRs (the 2026-11-13 train)
        TRAIN["save"](self.world, train)
        self.world.release["exchange"] = lambda request: (_ for _ in ()).throw(
            type("ReleaseError", (Exception,), {})("other commits would ship: N; ask the sender to approve what would ship"))
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_STOPPED"))
        merges = list(self.gh.merges)
        self.world.running_revision = lambda: running
        lines = TRAIN["reask"](self.world, ready["id"])
        reasked = json.loads(lines[0].split(" ", 1)[1])
        self.assertEqual((reasked["replaces"], reasked["ships"]), (ready["id"], [18]))
        self.assertIn("Also deploys already-merged #18.", TRAIN["load"](self.world, reasked["id"])["prompt"])
        self.assertEqual(TRAIN["load"](self.world, ready["id"])["status"], "cancelled")
        self.world.release["exchange"] = self.exchange
        self.assertTrue(TRAIN["run"](self.world, reasked["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        self.assertEqual((self.gh.merges, len(self.restarts)), (merges, 1))

    def test_a_typed_approval_may_name_or_reply_to_the_already_merged_prs_it_deploys(self):
        approval = runpy.run_path(str(ROOT / "scripts/helio_approval.py"))
        intents = []
        self.gh.open_pr(27, "b.py", "y = 1\n")
        ready = self.plan(27)
        train = TRAIN["load"](self.world, ready["id"])
        TRAIN["save"](self.world, {**train, "ships": [18]})
        prompt = "Merge #27 and restart Elo Bot?\n#27 · `" + train["members"][0]["head"][:7] + "` x\nAlso deploys already-merged #18.\nTested."
        for content, referenced in (("merge #27 and #18 and deploy", None), ("yes", {"author": {"id": "88"}, "content": prompt})):
            with self.subTest(content=content):
                live = {"content": content, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        **({"referenced_message": referenced} if referenced else {})}
                self.world.check.update(load=lambda m: {"live": live, "payload": {"channel_id": "300"}, "owner": OWNER,
                                                        "trusted": [], "channel_ok": True, "bot_id": "88"},
                                        verify_source=lambda *a: OWNER)
                self.world.check["APPROVAL"].update(
                    check_intent=lambda action, live, bot, repo, pr, **k: (intents.append((action, pr)),
                                                                            approval["check_intent"](action, live, bot, repo, pr, **k)),
                    check_revision=lambda *a, **k: None, sent_at=approval["sent_at"], pr_numbers=approval["pr_numbers"],
                    Refused=approval["Refused"],
                    train_reference=approval["train_reference"], train_ships=approval["train_ships"])
                fresh = {**TRAIN["load"](self.world, ready["id"]), "status": "asked"}
                fresh.pop("approval", None)
                self.binds.clear(); self.lock = None
                self.assertIsNone(TRAIN["approve"](self.world, fresh, "777"))
        self.assertEqual([pr for action, pr in intents if action == "merge"], [{27, 18}, {27}])
        # A further condition after the readiness clause is never an approval, through the whole approval path.
        for content in ("if ready, please get Bob's approval, then merge #27 and #18 and deploy",
                        "merge #27 and #18 and deploy only with Bob's approval if ready",
                        "if ready, go ahead and get Bob's approval, then merge #27 and #18 and deploy"):
            with self.subTest(refused=content):
                live = {"content": content, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                fresh = {**TRAIN["load"](self.world, ready["id"]), "status": "asked"}
                fresh.pop("approval", None)
                self.binds.clear(); self.lock = None
                with self.assertRaises(TRAIN["TrainError"]):
                    TRAIN["approve"](self.world, fresh, "778")
                self.assertEqual(self.binds, {})

    def test_a_queued_rerun_is_judged_on_its_own_attempt(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        self.gh.ci_conclusions, self.gh.failed_log, self.gh.rerun_lag = ["failure"], "Temporary failure resolving 'x'", 2
        ready = self.plan(18)
        self.assertEqual(TRAIN["load"](self.world, ready["id"])["ci"]["attempt"], 2)

    def test_a_left_out_pr_carried_into_a_replacement_is_followed_up_once(self):
        self.gh.open_pr(18, "app.py", "A = 2\nB = 1\n")
        self.gh.open_pr(20, "app.py", "A = 3\nB = 1\n")
        self.gh.open_pr(22, "c.py", "c = 1\n")
        self.gh.ci_conclusions = ["failure"]
        blocked = self.plan(18, 20, 22, restart=False)
        replacement = json.loads(TRAIN["drop"](self.world, blocked["id"], 22)[-1].split(" ", 1)[1])
        self.approve(replacement["id"])
        TRAIN["run"](self.world, replacement["id"])
        announced = TRAIN["followups"](self.state, REPO, lambda n: "FOLLOWUP_PR_READY {}")
        self.assertEqual(sorted(json.loads(x.split(" ", 1)[1])["pr"] for x in announced), [20, 22])
        self.assertEqual(TRAIN["followups"](self.state, REPO, lambda n: "FOLLOWUP_PR_READY {}"), [])

    def test_cleanup_cut_short_after_done_finishes_on_the_next_run(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        self.approve(ready["id"])
        unlock = self.confirm
        self.confirm = lambda args: (_ for _ in ()).throw(KeyboardInterrupt) if args[0] == "unlock" else unlock(args)
        with self.assertRaises(KeyboardInterrupt):
            TRAIN["run"](self.world, ready["id"])
        self.confirm = unlock
        self.assertIsNotNone(self.lock)
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        self.assertEqual((self.lock, self.gh.merges), (None, [18]))

    def test_a_recorded_typed_approval_resumes_its_binding_without_the_message(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        train = TRAIN["load"](self.world, ready["id"])
        argv = ["--message", "777", "--approver", OWNER, "--at", "1"]
        TRAIN["save"](self.world, {**train, "status": "binding", "approval": {"kind": "message", "id": "777", "channel": "300",
                                                                         "argv": argv}})
        self.assertEqual(TRAIN["frozen"](self.state, REPO), {"helio/issue-18"})
        self.assertTrue(TRAIN["run"](self.world, ready["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        self.assertEqual(self.binds, {"--message777": ready["id"]})

    def test_a_dropped_pr_keeps_its_follow_up_and_a_second_drop_for_the_request_reaches_the_owner(self):
        for number, path in ((18, "a.py"), (20, "b.py")):
            self.gh.open_pr(number, path, f"x = {number}\n")
        self.gh.ci_conclusions = ["failure"]
        blocked = self.plan(18, 20, restart=False)
        lines = TRAIN["drop"](self.world, blocked["id"], 20)
        self.assertFalse(any(x.startswith("MERGE_TRAIN_OWNER") for x in lines))
        self.assertTrue(any(x.startswith("MERGE_TRAIN_REPAIR") for x in lines))
        replacement = json.loads(lines[-1].split(" ", 1)[1])
        self.assertEqual([x["pr"] for x in replacement["excluded"]], [20])
        self.approve(replacement["id"])
        self.assertTrue(TRAIN["run"](self.world, replacement["id"])[-1].startswith("MERGE_TRAIN_DONE"))
        [announced] = TRAIN["followups"](self.state, REPO, lambda n: "FOLLOWUP_PR_READY {}")
        self.assertIn('"pr":20', announced)
        self.gh.open_pr(22, "c.py", "z = 1\n")
        self.gh.ci_conclusions = ["failure"]
        again = self.plan(20, 22, restart=False)
        self.assertTrue(any(x.startswith("MERGE_TRAIN_OWNER") for x in TRAIN["drop"](self.world, again["id"], 20)))
        # Past the bound it is the owner's: readiness no longer replans it automatically.
        self.assertFalse(any('"pr":20' in x for x in TRAIN["followups"](self.state, REPO, lambda n: "FOLLOWUP_PR_READY {}")))

    def test_approved_member_branches_are_frozen_until_the_train_ends(self):
        self.gh.open_pr(18, "a.py", "x = 1\n")
        ready = self.plan(18, restart=False)
        self.approve(ready["id"])
        train = TRAIN["load"](self.world, ready["id"])
        TRAIN["save"](self.world, {**train, "status": "approved", "approval": {"approver": OWNER}})
        self.assertEqual(TRAIN["frozen"](self.state, REPO), {"helio/issue-18"})
        TRAIN["save"](self.world, {**train, "status": "done"})
        self.assertEqual(TRAIN["frozen"](self.state, REPO), set())


if __name__ == "__main__":
    unittest.main()
