"""Real operation storage protects issue edits and resumes notification failures."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_issues.py"))
SYNC = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_issue_sync.py"))
CLI = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio-issue.py"))
STATUS = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_github_status.py"))


class SyncReportingTests(unittest.TestCase):
    def test_link_review_survives_a_simultaneous_comment_write_failure_until_reviewed(self):
        import sqlite3
        import subprocess
        from unittest.mock import patch

        review = "ISSUE_LINK_REVIEW issue=4: merged PR needs completion reconciliation"
        failure = 'ISSUE_SYNC_PARTIAL {"category":"transport","stage":"comment_write","detail":"TLS failed","uncertain":true}'
        cases = [
            subprocess.CompletedProcess([], 0, f"ISSUE_LOG_PENDING issue=4\n{failure}\n{review}", ""),
            subprocess.CompletedProcess([], 2, review, failure),
            subprocess.TimeoutExpired("sync", 120, output=review.encode(), stderr=failure.encode()),
        ]
        for result in cases:
            with self.subTest(result=type(result).__name__), tempfile.TemporaryDirectory() as temp:
                state = Path(temp)
                SYNC["enqueue"](state, "o/r", 4)
                options = {"side_effect": result} if isinstance(result, subprocess.TimeoutExpired) else {"return_value": result}
                with patch("time.time", return_value=1000), patch.object(subprocess, "run", **options):
                    SYNC["reconcile"](state, "o/r")
                with sqlite3.connect(state / "issue-sync.sqlite") as db:
                    self.assertEqual(db.execute("""SELECT failure_kind,failure_stage,review_required,next_attempt_at,completed_at
                        FROM tracked WHERE issue=4""").fetchone(), ("transport", "comment_write", 1, 0, 0))
                SYNC["enqueue"](state, "o/r", 4)
                with patch("time.time", return_value=2000), patch.object(subprocess, "run") as command:
                    SYNC["reconcile"](state, "o/r")
                    command.assert_not_called()
                SYNC["mark_reviewed"](state, "o/r", 4, 2001, "Reviewed completion relationship")
                with patch("time.time", return_value=2002), patch.object(subprocess, "run",
                        return_value=subprocess.CompletedProcess([], 0, "ISSUE_UPDATED issue=4", "")):
                    SYNC["reconcile"](state, "o/r")
                with sqlite3.connect(state / "issue-sync.sqlite") as db:
                    self.assertEqual(db.execute("SELECT last_outcome,review_required,completed_at FROM tracked WHERE issue=4").fetchone(),
                                     ("complete", 0, 2002))

    def test_failed_and_partial_syncs_remain_visible_until_a_completed_sync(self):
        import sqlite3
        import subprocess
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            SYNC["enqueue"](state, "o/r", 4)
            outcomes = [
                subprocess.CompletedProcess([], 1, "", "ISSUE_UPDATE_PENDING error connecting to api.github.com"),
                subprocess.CompletedProcess([], 0, "ISSUE_LOG_PENDING issue=4: comment remains queued\nISSUE_UPDATED issue=4", ""),
                subprocess.CompletedProcess([], 0, "ISSUE_UPDATED issue=4", ""),
            ]
            observed = []
            for index, outcome in enumerate(outcomes):
                if index:
                    SYNC["enqueue"](state, "o/r", 4)
                with patch.object(subprocess, "run", return_value=outcome):
                    SYNC["reconcile"](state, "o/r")
                with sqlite3.connect(state / "issue-sync.sqlite") as db:
                    observed.append(db.execute(
                        "SELECT last_outcome,last_warning,attempted_at,completed_at FROM tracked WHERE issue=4"
                    ).fetchone())
            self.assertEqual([row[0] for row in observed], ["failed", "partial", "complete"])
            self.assertIn("api.github.com", observed[0][1])
            self.assertIn("ISSUE_LOG_PENDING", observed[1][1])
            self.assertEqual(observed[2][1], "")
            self.assertEqual([row[3] for row in observed[:2]], [0, 0])
            self.assertGreater(observed[2][3], 0)
            self.assertTrue(all(row[2] > 0 for row in observed))
            before = (state / "issue-sync.sqlite").read_bytes()
            self.assertIn("#4: complete", STATUS["queue_status"](state, "o/r")["Sync"])
            self.assertEqual((state / "issue-sync.sqlite").read_bytes(), before)

    def test_timeout_is_saved_as_uncertain_without_immediate_retry(self):
        import sqlite3
        import subprocess
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            SYNC["enqueue"](state, "o/r", 4)
            with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("sync", 120)) as command:
                SYNC["reconcile"](state, "o/r")
                self.assertEqual(SYNC["reconcile"](state, "o/r"), [])
                self.assertEqual(command.call_count, 1)
            with sqlite3.connect(state / "issue-sync.sqlite") as db:
                outcome, warning, completed = db.execute(
                    "SELECT last_outcome,last_warning,completed_at FROM tracked WHERE issue=4"
                ).fetchone()
            self.assertEqual(outcome, "uncertain")
            self.assertIn("timed out", warning)
            self.assertEqual(completed, 0)

    def test_failures_keep_classified_stages_end_times_and_review_holds(self):
        import os
        import sqlite3
        import subprocess
        from unittest.mock import patch

        cases = [
            (4, "ISSUE_SYNC_STAGE issue_read\nHTTP 401: Bad credentials", "authentication", "issue_read"),
            (5, "ISSUE_SYNC_STAGE pr_read\nAPI rate limit exceeded", "rate_limit", "pr_read"),
            (6, "ISSUE_EDITED_OUTSIDE_HELIO reviewed_sha256=abc", "human_edit_conflict", "issue_review"),
            (7, "ISSUE_SYNC_STAGE issue_write\nHTTP 403: Forbidden", "permission", "issue_write"),
            (8, "ISSUE_SYNC_STAGE issue_read\nTLS handshake failed with ghp_fixturesecretvalue", "transport", "issue_read"),
        ]
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            for issue, detail, category, stage in cases:
                SYNC["enqueue"](state, "o/r", issue)
                with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 2, "", detail)), \
                     patch.dict(os.environ, {"GH_TOKEN": "ghp_fixturesecretvalue"}), patch("time.time", return_value=1000 + issue):
                    SYNC["reconcile"](state, "o/r")
                with sqlite3.connect(state / "issue-sync.sqlite") as db:
                    recorded = db.execute("""SELECT failure_kind,failure_stage,attempted_at,attempt_finished_at,
                        next_attempt_at,review_required,last_warning FROM tracked WHERE issue=?""", (issue,)).fetchone()
                self.assertEqual(recorded[:4], (category, stage, 1000 + issue, 1000 + issue))
                self.assertEqual(recorded[4:6], (0, 1) if issue == 6 else (1300 + issue, 0))
                self.assertNotIn("ghp_fixturesecretvalue", recorded[6])
            with patch("time.time", return_value=2000), patch.object(
                    subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "ISSUE_UPDATED", "")) as command:
                SYNC["reconcile"](state, "o/r")
                self.assertEqual(command.call_count, 4)
            SYNC["mark_reviewed"](state, "o/r", 6, 2001, "Reviewed the current body")
            with patch("time.time", return_value=2002), patch.object(
                    subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "ISSUE_UPDATED", "")) as command:
                SYNC["reconcile"](state, "o/r")
                self.assertEqual(command.call_count, 1)
            before = (state / "issue-sync.sqlite").read_bytes()
            status = STATUS["queue_status"](state, "o/r")
            self.assertEqual(status["Pending syncs"], "0")
            self.assertEqual(status["Unfinished writes"], "0")
            self.assertIn("#6", status["Last full sync"])
            self.assertEqual((state / "issue-sync.sqlite").read_bytes(), before)


class IssueTests(unittest.TestCase):
    def test_closed_issue_cannot_be_reopened_by_a_new_update(self):
        self.meta.update(state="closed", state_reason="completed", labels=["human-hold"])
        change = {"body": "New local-only work; no commit or PR.", "adopt": M["digest"](self.body),
                  "reopen": True, "projection": "OPEN: REOPENED", "note": "Resuming local-only work"}
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, change)
        self.assertEqual(self.patches, 0)
        self.assertEqual(self.meta["state"], "closed")
        self.assertEqual(self.meta["labels"], ["human-hold"])
        self.assertEqual(self.body, "Human request")
        self.assertEqual(self.comments, [])

    def test_pending_legacy_reopen_is_retired_without_changing_external_state(self):
        import sqlite3
        self.meta.update(state="closed", state_reason="completed", labels=["human-hold"])
        with self.gh.operations() as db:
            db.execute("""INSERT INTO operations(id,repo,issue,before_body,after_body,change)
                          VALUES ('legacy','o/r',4,?,?,?)""",
                       (self.body, "New scope", json.dumps({"reopen": True, "note": "Old pending reopening"})))
        self.gh.update(4, {"projection": "Historical PR completed"})
        self.assertEqual(self.meta, {"state": "closed", "state_reason": "completed", "labels": ["human-hold"]})
        self.assertEqual(M["split"](self.body)[0], "Human request")
        self.assertEqual(self.comments, [])
        with sqlite3.connect(Path(self.temp.name) / "issue-updates.sqlite") as db:
            completed, saved = db.execute("SELECT completed,change FROM operations WHERE id='legacy'").fetchone()
        self.assertEqual((completed, json.loads(saved)["reopen"]), (2, True))
        with self.assertRaises(M["Refused"]):
            self.gh.resume("legacy")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.body = "Human request"
        self.meta = {"state": "open", "state_reason": None, "labels": []}
        self.comments = []
        self.fail_comment = False
        self.fail_patch = None
        self.patches = 0
        self.during_get = None
        self.gh = M["Issues"]("o/r", Path(self.temp.name), self.command)

    def command(self, argv, stdin=None):
        data = json.loads(stdin) if stdin else None
        if "--slurp" in argv:
            return json.dumps([self.comments])
        if argv[2].endswith("/comments"):
            if self.fail_comment:
                raise M["Refused"]("GitHub unavailable after body write")
            self.comments.append(data)
            return "{}"
        if data is not None:
            if self.fail_patch == "before":
                self.fail_patch = None
                raise M["Refused"]("error connecting to api.github.com")
            self.patches += 1
            self.body = data["body"]
            self.meta.update({key: data[key] for key in ("state", "state_reason") if key in data})
            if "labels" in data:
                self.meta["labels"] = list(data["labels"])
            if self.fail_patch == "after":
                self.fail_patch = None
                raise M["Refused"]("error connecting to api.github.com")
            return "{}"
        if self.during_get:
            hook, self.during_get = self.during_get, None
            hook()
        return json.dumps({"body": self.body, "state": self.meta["state"], "state_reason": self.meta["state_reason"],
                           "labels": [{"name": name} for name in self.meta["labels"]]})

    def test_unreviewed_manual_body_is_preserved(self):
        with self.assertRaisesRegex(M["Refused"], "ISSUE_EDITED_OUTSIDE_HELIO"):
            self.gh.update(4, {"body": "Changed scope"})
        self.assertEqual(self.body, "Human request")

    def test_adopt_is_bound_to_exact_body_read(self):
        original_hash = M["digest"](self.body)
        self.body = "Someone changed the request"
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, {"body": "Changed scope", "adopt": original_hash})
        self.assertEqual(self.body, "Someone changed the request")

    def test_partial_update_resumes_without_duplicate_comments(self):
        change = {"body": "Approved scope", "adopt": M["digest"](self.body), "note": "Scope clarified"}
        self.fail_comment = True
        with self.assertRaisesRegex(M["Refused"], "after body write"):
            self.gh.update(4, change)
        self.assertEqual(M["split"](self.body)[0], "Approved scope")
        self.fail_comment = False
        self.gh.update(4, change)
        self.gh.update(4, change)
        self.assertEqual(len(self.comments), 1)

    def test_status_sync_keeps_prose_and_sends_no_comment(self):
        self.gh.update(4, {"projection": "PR #6 open"})
        self.assertEqual(M["split"](self.body)[0], "Human request")
        self.assertEqual(self.comments, [])

    def test_description_change_needs_a_public_log_note(self):
        with self.assertRaisesRegex(M["Refused"], "ISSUE_NOTE_REQUIRED"):
            self.gh.update(4, {"body": "Changed scope", "adopt": M["digest"](self.body)})
        self.assertEqual(self.body, "Human request")
        self.gh.update(4, {"body": "Changed scope", "adopt": M["digest"](self.body), "note": "Loss cap is -30"})
        self.assertIn("Loss cap is -30", self.comments[0]["body"])

    def test_a_later_change_first_finishes_an_interrupted_update(self):
        note = {"body": "Keep the wording", "adopt": M["digest"](self.body), "note": "Owner keeps the wording"}
        self.fail_comment = True
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, note)
        self.fail_comment = False
        self.gh.update(4, {"projection": "PR #6 merged"})
        self.assertEqual([c["body"].split("\n")[0] for c in self.comments], ["**Issue updated:** Owner keeps the wording"])
        self.assertEqual(M["split"](self.body)[0], "Keep the wording")
        self.assertIn("PR #6 merged", self.body)

    def test_repeating_a_finished_update_after_a_status_refresh_is_not_a_conflict(self):
        note = {"body": "Keep the wording", "adopt": M["digest"](self.body), "note": "Owner keeps the wording"}
        first = self.gh.update(4, note)
        self.gh.update(4, {"projection": "PR #6 merged"})
        self.assertEqual(self.gh.update(4, note), first)
        self.assertEqual(len(self.comments), 1)
        self.assertIn("PR #6 merged", self.body)

    def test_repeating_an_update_whose_body_retention_erased_stays_done(self):
        import sqlite3
        from contextlib import closing
        note = {"body": "Keep the wording", "adopt": M["digest"](self.body), "note": "Owner keeps the wording"}
        first = self.gh.update(4, note)
        self.gh.update(4, {"projection": "PR #6 merged"})
        with closing(sqlite3.connect(Path(self.temp.name) / "issue-updates.sqlite")) as db, db:
            db.execute("UPDATE operations SET after_body='',change='' WHERE id=?", (first,))
        patches = self.patches
        self.assertEqual(self.gh.update(4, note), first)
        self.assertEqual(self.gh.resume(first), (4, first))
        self.assertEqual((len(self.comments), self.patches), (1, patches))

    def test_a_repeated_finished_sync_still_finishes_a_later_interrupted_note(self):
        sync = {"projection": "PR #6 open"}
        self.gh.update(4, sync)
        note = {"body": "Keep the wording", "adopt": M["digest"](self.body), "note": "Owner keeps the wording"}
        self.fail_comment = True
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, note)
        self.fail_comment = False
        self.gh.update(4, sync)
        self.assertEqual(len(self.comments), 1)

    def test_cancel_waits_for_an_update_in_flight_and_never_reports_a_cancel_that_did_not_happen(self):
        import threading
        note = {"body": "Keep the wording", "adopt": M["digest"](self.body), "note": "Owner keeps the wording"}
        self.fail_comment = True
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, note)
        self.fail_comment = False
        operation = M["digest"](json.dumps(["o/r", 4, note], sort_keys=True))
        outcome = {}

        def cancel():
            try:
                outcome["result"] = self.gh.cancel(operation)
            except M["Refused"] as error:
                outcome["error"] = str(error)
        worker = threading.Thread(target=cancel)
        self.during_get = worker.start
        self.gh.update(4, {"projection": "PR #6 open"})
        worker.join()
        self.assertEqual(len(self.comments), 1)
        self.assertIn("already completed", outcome.get("error", ""))

    def test_recovery_never_replays_close_or_labels_over_a_human_decision(self):
        intent = {"projection": "PR #6 merged", "close": "completed", "labels": ["reviewed"]}
        self.fail_patch = "before"
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, intent)
        self.meta.update(state="closed", state_reason="not_planned", labels=["human-hold"])
        with self.assertRaisesRegex(M["Refused"], "changed during the update"):
            self.gh.update(4, {"projection": "PR #6 merged"})
        self.assertEqual(self.meta, {"state": "closed", "state_reason": "not_planned", "labels": ["human-hold"]})

    def test_a_write_that_landed_despite_an_error_is_not_sent_again(self):
        intent = {"projection": "PR #6 merged", "close": "completed", "labels": ["reviewed"]}
        self.fail_patch = "after"
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, intent)
        self.gh.update(4, {"projection": "PR #6 merged"})
        self.assertEqual(self.patches, 2)
        self.assertEqual(self.meta, {"state": "closed", "state_reason": "completed", "labels": ["reviewed"]})

    def test_milestones_after_first_use_are_logged_once(self):
        events = [("pr6:opened", "PR #6 opened", 900.0), ("pr6:merged", "PR #6 merged", 1100.0)]
        self.assertEqual(self.gh.log_milestones(4, events[:1], now=1000.0), [])
        self.assertEqual(self.gh.log_milestones(4, events, now=1200.0), ["PR #6 merged"])
        self.assertEqual(self.gh.log_milestones(4, events, now=1300.0), [])
        self.assertEqual(len(self.comments), 1)
        self.assertIn("PR #6 merged", self.comments[0]["body"])


class ProjectionTests(unittest.TestCase):
    def test_historical_reopen_events_remain_readable_without_false_completion(self):
        class Gh:
            state = "CLOSED"
            timeline = [[]]
            body = CLI["ISSUE_LINK"]["marker"](8, 1, True)

            def command(self, argv, stdin=None):
                if argv[:3] == ["gh", "issue", "view"]:
                    return json.dumps({"state": self.state, "stateReason": "COMPLETED", "title": "Facts", "comments": [],
                                       "closedByPullRequestsReferences": [{"number": 9}]})
                if argv[:3] == ["gh", "api", "user"]:
                    return "helio"
                if "/timeline" in " ".join(argv):
                    return json.dumps(self.timeline)
                return json.dumps({"state": "MERGED", "url": "https://github.com/o/r/pull/9",
                                   "body": self.body, "mergedAt": "2026-11-05T09:00:00Z", "statusCheckRollup": [],
                                   "closingIssuesReferences": [{"number": 8}]})

        gh = Gh()
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp, patch.dict(CLI["projection"].__globals__, STATE=Path(temp), REPO="o/r"):
            historical = CLI["projection"](8, gh)
            self.assertTrue(historical["status"].startswith("CLOSED"))
            self.assertIn("PR #9", historical["status"])
            gh.state = "OPEN"
            gh.timeline = [[{"event": "reopened", "created_at": "2026-11-05T10:00:00Z"}]]
            synced = CLI["projection"](8, gh)
            self.assertEqual(synced["warnings"], [])
            gh.body = ""
            self.assertEqual(CLI["projection"](8, gh)["warnings"], [])
            gh.timeline = [[]]
            self.assertEqual(len(CLI["projection"](8, gh)["warnings"]), 1)

    def test_status_does_not_change_when_only_the_observation_time_does(self):
        import datetime, sqlite3
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            db = sqlite3.connect(state / "discord-conversations.sqlite")
            db.execute("CREATE TABLE oracle_observations (singleton INTEGER PRIMARY KEY, data TEXT NOT NULL)")

            class Gh:
                def command(self, argv, stdin=None):
                    joined = " ".join(argv)
                    if "issue view" in joined:
                        return json.dumps({"state": "CLOSED", "stateReason": "COMPLETED", "title": "Facts", "comments": [],
                                           "closedByPullRequestsReferences": [{"number": 9}]})
                    if "api user" in joined:
                        return "helio\n"
                    if "/timeline" in joined:
                        return "[[]]"
                    return json.dumps({"state": "MERGED", "url": "https://github.com/o/r/pull/9", "statusCheckRollup": [],
                                       "mergeCommit": {"oid": "abc"}, "body": "", "closingIssuesReferences": [{"number": 8}],
                                       "createdAt": "2026-11-05T09:00:00Z", "mergedAt": "2026-11-05T09:10:00Z"})

                def api(self, suffix):
                    return {"status": "identical"}

            statuses = []
            for seconds in (0, 5):
                observed = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)).isoformat()
                data = {"observed_at": observed, "active": True, "login_evidence": "observed", "running_revision": "def"}
                db.execute("INSERT OR REPLACE INTO oracle_observations VALUES (1, ?)", (json.dumps(data),))
                db.commit()
                old = CLI["projection"].__globals__["STATE"], CLI["projection"].__globals__["REPO"]
                CLI["projection"].__globals__.update(STATE=state, REPO="o/r")
                try:
                    statuses.append(CLI["projection"](8, Gh())["status"])
                finally:
                    CLI["projection"].__globals__.update(STATE=old[0], REPO=old[1])
            db.close()
            self.assertIn("live revision observed", statuses[0])
            self.assertEqual(statuses[0], statuses[1])


class ReviewTests(unittest.TestCase):
    def test_discussion_stays_due_until_reviewed_and_reminds_at_a_bounded_rate(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            SYNC["mark_discussed"](state, "o/r", 8, 100)
            self.assertEqual(SYNC["reminders"](state, "o/r", 200), [])
            self.assertEqual(len(SYNC["reminders"](state, "o/r", 800)), 1)
            self.assertEqual(SYNC["reminders"](state, "o/r", 900), [])
            self.assertIn("issues/8", SYNC["reminders"](state, "o/r", 2700)[0])
            SYNC["mark_reviewed"](state, "o/r", 8, 2800, "nothing new")
            self.assertEqual(SYNC["reminders"](state, "o/r", 9000), [])
            SYNC["mark_discussed"](state, "o/r", 8, 9100)
            self.assertEqual(len(SYNC["reminders"](state, "o/r", 9800)), 1)

    def test_read_path_omits_helio_comments_and_already_reviewed_discussion(self):
        info = {"comments": [
            {"author": {"login": "helio"}, "body": "**Issue updated:** log", "createdAt": "2026-11-05T10:00:00Z"},
            {"author": {"login": "jpk"}, "body": "old idea", "createdAt": "2026-11-05T09:00:00Z"},
            {"author": {"login": "jpk"}, "body": "season is two months", "createdAt": "2026-11-05T11:00:00Z"},
        ]}
        since = CLI["timestamp"]("2026-11-05T10:30:00Z")
        self.assertEqual([c["body"] for c in CLI["human_comments"](info, "helio", since)], ["season is two months"])
