"""Real git, verification and SQLite with independent GitHub/terminal boundaries."""
from __future__ import annotations
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH

from dataclasses import replace
import datetime
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import unittest
from unittest.mock import patch
import uuid

import test_helio_autofix as autofix
import test_pr_publication as publication

ROOT = Path(__file__).resolve().parent.parent
C = runpy.run_path(str(ROOT / "scripts/helio_pr_recovery.py"))
S, P, V = C["S"], C["P"], C["P"]["V"]
LANES = runpy.run_path(str(ROOT / "scripts/helio_task_lane.py"))
CLI = runpy.run_path(str(ROOT / "scripts/helio_pr_recovery_cli.py"))
OWNER = "100000000000000001"


class Custody:
    """Mutable independent service state; only production helpers write custody."""

    def __init__(self, case: unittest.TestCase, *, handed_off: bool = True) -> None:
        self.auto = autofix.AutofixTests()
        case.addCleanup(self.auto.doCleanups)
        self.auto.setUp()
        environment = patch.dict(os.environ, self.auto.env)
        environment.start()
        case.addCleanup(environment.stop)
        self.publication = publication.PublicationTests()
        case.addCleanup(self.publication.doCleanups)
        self.publication.setUp()
        self.store = self.publication.store
        self.project = self.auto.project
        self.auto.git("push", "origin", "HEAD:helio/autofix-7")
        self.head = self.auto.git("rev-parse", "HEAD")
        self.base = self.auto.git("rev-parse", "origin/main")
        self.publication.github.head = self.head
        self.publication.github.issue["labels"].append({"name": "confirmed"})
        self.now = 1_700_000_000.0
        self.attempt = 1
        self.run_status = "completed"
        self.mode = "infra"
        self.reruns: list[float] = []
        self.safe_release = True
        self.pr_state = "OPEN"
        self.replacement = False
        self.reopened: list[str] = []
        self.session = str(uuid.uuid4())
        self.sessions = self.store.state / "sessions"
        self.sessions.mkdir()
        self.config = self.store.state / "config.json"
        self.config.write_text(json.dumps({"sessionsDir": str(self.sessions)}))
        configuration = patch.dict(os.environ, {"DORI_CONFIG": str(self.config), "DORI_DISCORD_OWNER_ID": OWNER,
                                                "DORI_STATE_DIR": str(self.store.state)})
        configuration.start()
        case.addCleanup(configuration.stop)
        task = LANES["Task"]("o/r", 7, "Fix the regression", "autofix", "Standing autofix", "github:o/r#7")
        self.wait = P["initialize"](self.store, task, "issue7-regression", "helio/autofix-7", self.run)
        self.lane_path = self.store.state / "lanes/issue7-regression.json"
        self.lane_path.parent.mkdir()
        self.lane_path.write_text(json.dumps({
            "key": "issue7-regression", "job": "issue-7", "source": "github:o/r#7", "revision": 1,
            "status": "working", "cwd": str(self.project), "session": self.session,
            "phase": {"owner": "helio-pr", "version": 1, "generation": 1},
        }))
        self.checkpoint = self.sessions / ("--" + str(self.project).lstrip("/").replace("/", "-") + "--") / f"2026-11-11_{self.session}.jsonl"
        self.checkpoint.parent.mkdir()
        self.checkpoint.write_text(json.dumps({"type": "session", "id": self.session, "cwd": str(self.project)}) + "\n")
        self.start_goal()
        self.seen: set[str] = set()
        if handed_off:
            self.publish()
            self.wait = P["handoff"](self.store, S["load"](self.store, 7), self.verification, self.run)
            with self.checkpoint.open("a") as output:
                output.write(json.dumps({"type": "message", "message": {
                    "role": "toolResult", "toolName": "update_goal", "isError": False,
                    "details": {"goal": {"threadId": self.session, "status": "complete", "objective": P["objective"](self.wait)}},
                }}) + "\n")

    def publish(self) -> None:
        """The submit path's record and publication for the issue's current text."""
        scope = publication.M["digest"](self.publication.github.issue["body"])
        suite = V["autofix_result"](self.project, self.head, ["tests/test_regression.py"])
        self.verification = V["record"](self.store, {
            "issue": 7, "branch": "helio/autofix-7", "route": "autofix", "head": self.head, "base": self.base,
            "scope": scope,
            "authority": V["digest"](json.dumps(self.publication.proof, sort_keys=True)),
            "authority_proof": self.publication.proof,
            "job": "issue-7", "generation": 1,
        }, suite)
        publication.P["publish"](self.store, 7, "helio/autofix-7", self.head, self.publication.body(),
            "Fix regression", self.publication.proof, scope, verification=self.verification)

    def submit(self) -> str:
        """Run the real `helio autofix submit` against this world's current issue text; returns its verification."""
        self.auto.data["issue"] = dict(self.publication.github.issue)
        self.auto.env.update({"DORI_STATE_DIR": str(self.store.state), "DORI_CONFIG": str(self.config)})
        result = self.auto.invoke("submit")
        if result.returncode or " verification=" not in result.stdout:
            raise AssertionError(result.stdout + result.stderr)
        self.publication.github.body = (self.auto.root / "body").read_text()
        self.verification = result.stdout.split(" verification=")[1].split()[0]
        return self.verification

    def start_goal(self) -> None:
        wait = S["load"](self.store, 7)
        with self.checkpoint.open("a") as output:
            output.write(json.dumps({"type": "message", "message": {
                "role": "toolResult", "toolName": "create_goal", "isError": False,
                "details": {"goal": {"threadId": self.session, "status": "active", "objective": P["objective"](wait)}},
            }}) + "\n")
        self.wait = P["start"](self.store, wait, self.run)

    def pull(self):
        check = {"name": "Unit tests", "status": "COMPLETED" if self.run_status == "completed" else "IN_PROGRESS",
                 "conclusion": "SUCCESS" if self.mode == "pass" else "FAILURE",
                 "detailsUrl": f"https://github.com/o/r/actions/runs/90/job/{100 + self.attempt}"}
        return {"number": 8, "url": publication.URL, "state": self.pr_state,
                "headRefName": "helio/autofix-7", "headRefOid": self.head, "baseRefName": "main",
                "baseRefOid": self.base, "isCrossRepository": False, "isDraft": False,
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "body": self.publication.github.body,
                "closingIssuesReferences": [{"number": 7}], "statusCheckRollup": [check]}

    def job(self):
        return {"id": 100 + self.attempt, "name": "Unit tests", "head_sha": self.head,
                "run_attempt": self.attempt, "status": self.run_status,
                "conclusion": "success" if self.mode == "pass" else "failure",
                "completed_at": datetime.datetime.fromtimestamp(self.now, datetime.timezone.utc).isoformat(),
                "steps": [{"name": "Install CJK font for bracket rendering",
                           "conclusion": "failure" if self.mode == "infra" else "success"},
                          {"name": "Run unit tests", "conclusion": "skipped" if self.mode == "infra" else (
                              "success" if self.mode == "pass" else "failure")}]}

    def question_hold(self, key: str) -> bool:
        path = self.store.state / "discord-questions.sqlite"
        if not path.is_file():
            return False
        with sqlite3.connect(path) as db:
            return db.execute("SELECT 1 FROM questions WHERE lane=? AND status NOT IN ('done','cancelled','expired','withdrawn')",
                              (key,)).fetchone() is not None

    def run(self, argv: list[str], stdin: str | None = None) -> str:
        if argv[0] == "git":
            return subprocess.run(argv, check=True, capture_output=True, text=True).stdout
        if argv[:3] == ["gh", "issue", "view"]:
            created = self.publication.github.created.get(int(argv[3]))
            if created:
                return json.dumps({"number": int(argv[3]), "title": created["title"], "body": created["body"],
                                   "state": "OPEN", "labels": [{"name": name} for name in created.get("labels", [])],
                                   "comments": []})
            return json.dumps({"title": "Fix the regression", **self.publication.github.issue})
        if argv[:3] == ["gh", "pr", "view"]:
            return json.dumps(self.pull())
        if argv[:3] == ["gh", "pr", "reopen"]:
            self.reopened.append(argv[3])
            self.pr_state = "OPEN"
            return ""
        if argv[:3] == ["gh", "pr", "list"]:
            pulls = [self.pull()]
            if self.replacement:
                pulls.append({**self.pull(), "url": "https://github.com/o/r/pull/9", "headRefName": "helio/replacement"})
            return json.dumps(pulls if self.pr_state == "OPEN" or self.replacement else [])
        if argv[:3] == ["gh", "run", "view"]:
            return "Temporary failure resolving 'archive.ubuntu.com'" if self.mode == "infra" else "AssertionError: value differs"
        if argv[:2] == ["gh", "api"]:
            endpoint = next((part for part in argv if part.startswith("repos/")), "")
            if "/branches/main" in endpoint:
                return self.base
            if "/compare/" in endpoint:
                return json.dumps({"merge_base_commit": {"sha": self.base}})
            if endpoint.endswith("/rerun"):
                self.reruns.append(self.now)
                self.attempt += 1
                self.run_status = "in_progress"
                return ""
            if "/actions/jobs/" in endpoint:
                return json.dumps(self.job())
            if endpoint.endswith("/jobs?per_page=100"):
                return json.dumps({"jobs": [self.job()]})
            if "/actions/runs/" in endpoint:
                return json.dumps({"head_sha": self.head, "run_attempt": self.attempt, "workflow_id": 4,
                                   "status": self.run_status})
        if argv[0] == "dori":
            lane = json.loads(self.lane_path.read_text())
            if argv[1] == "reclaim" and "--stop" not in argv:
                if not self.safe_release:
                    raise RuntimeError("REFUSED issue7-regression: current session is working; no terminal closed")
                if self.question_hold(argv[2]):
                    # As Dori's reclaimLane: after the idle check, an open question pins the slot (reclaim.ts:125-126).
                    raise RuntimeError(f"REFUSED {argv[2]}: an unanswered question needs this worker")
                lane["status"] = "hibernated"
            elif argv[1] == "resume":
                lane["status"] = "working"
                lane["phase"] = json.loads(argv[argv.index("--phase") + 1])
                lane["pane"] = "fixture:worker"
                lane["launchState"] = "started"
            elif argv[1] == "claim-done":
                if lane["revision"] != int(argv[argv.index("--expected-revision") + 1]):
                    raise RuntimeError("REFUSED stale completion")
                lane["status"] = "done-claimed"
                lane["phase"] = json.loads(argv[argv.index("--phase") + 1])
            elif argv[1] == "claim-ack":
                lane["acknowledged"] = True
            elif argv[1] == "abandon":
                lane["status"], lane["receipt"] = "closed", {"abandoned": True, "reason": argv[argv.index("--reason") + 1]}
                lane["closedAt"] = "2026-11-12T00:00:00Z"
            elif argv[1] == "pause":
                lane["status"] = "paused"
            elif argv[1] == "reclaim" and "--stop" in argv and self.question_hold(argv[2]):
                raise RuntimeError(f"REFUSED {argv[2]}: an unanswered question needs this worker")
            elif argv[1] == "reclaim" and "--stop" in argv:
                if lane["status"] != "paused" or lane["revision"] != int(argv[argv.index("--expected-revision") + 1]):
                    raise RuntimeError("REFUSED issue7-regression: lane changed before stopping; refresh its confirmation")
                lane["status"] = "hibernated"
            else:
                raise AssertionError(argv)
            lane["revision"] += 1
            self.lane_path.write_text(json.dumps(lane))
            return "OK"
        return self.publication.github.command(argv, stdin)  # issue reads, user and issue creation

    def poll(self, minute: float = 0, run=None) -> list[str]:
        self.now = 1_700_000_000.0 + minute * 60
        return C["watch"](self.store, run or self.run, self.seen, self.now)
