"""Publication recovery crosses a durable journal and an independent GitHub boundary."""
import json
import os
from pathlib import Path
import runpy
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
P = runpy.run_path(str(ROOT / "scripts/helio_pr_publication.py"))
M = runpy.run_path(str(ROOT / "scripts/helio_issues.py"))
POSTS = runpy.run_path(str(ROOT / "scripts/helio_github_posts.py"))
URL = "https://github.com/o/r/pull/8"


class GitHub:
    def __init__(self, state):
        self.state = state
        self.issue = {"state": "OPEN", "body": "Confirmed requirements", "labels": [{"name": "bug"}], "comments": []}
        self.body = None
        self.head = "a" * 40
        self.creates = self.edits = 0
        self.lose_create = self.lose_edit = None
        self.stale_after_edit = False
        self.stale = None
        self.durable_before_post = False
        self.stale_list = False
        self.reject_create = False
        self.reject_edit = False
        self.remote_head = None
        self.history = []
        self.autofix_count = 0

    def command(self, argv, stdin=None):
        action = argv[1:3]
        if argv[1] == "api" and "/git/ref/heads/" in argv[2]:
            return self.remote_head or self.head
        if action == ["issue", "view"]:
            return json.dumps(self.issue)
        if action == ["pr", "list"]:
            if "--label" in argv:
                return json.dumps([{"url": f"https://github.com/o/r/pull/{100 + i}"} for i in range(self.autofix_count)])
            if self.stale_list:
                self.stale_list = False
                return "[]"
            return json.dumps(([{"url": URL}] if self.body is not None else []) + [{"url": item["url"]} for item in self.history])
        if action == ["pr", "view"]:
            historic = next((item for item in self.history if item["url"] == argv[3]), None)
            if historic:
                return json.dumps(historic)
            body = self.body
            if self.stale is not None:
                body, self.stale = self.stale, None
            return json.dumps({"state": "OPEN", "body": body, "headRefName": "helio/autofix-7",
                               "headRefOid": self.head, "baseRefName": "main", "isCrossRepository": False,
                               "closingIssuesReferences": [{"number": 7}] if body and body.startswith("Fixes #7") else []})
        if action == ["pr", "create"]:
            with sqlite3.connect(self.state / "issue-updates.sqlite") as db:
                self.durable_before_post = db.execute("SELECT written FROM operations WHERE completed=0").fetchone()[0] == 1
            self.creates += 1
            if self.body is not None:
                raise M["Refused"]("HTTP 422: A pull request already exists for this head and base", "pr_write")
            if self.reject_create:
                self.reject_create = False
                raise M["Refused"]("HTTP 422: report input rejected", "pr_write")
            lost, self.lose_create = self.lose_create, None
            if lost == "before":
                raise M["Refused"]("Network response unavailable", "pr_write", True)
            self.body = Path(argv[argv.index("--body-file") + 1]).read_text()
            if lost == "after":
                raise M["Refused"]("Network response lost after creation", "pr_write", True)
            return URL
        if action == ["pr", "edit"]:
            self.edits += 1
            if self.reject_edit:
                self.reject_edit = False
                raise M["Refused"]("HTTP 422: edit input rejected", "pr_write")
            lost, self.lose_edit = self.lose_edit, None
            if lost == "before":
                raise M["Refused"]("Network response unavailable", "pr_write", True)
            old = self.body
            self.body = Path(argv[argv.index("--body-file") + 1]).read_text()
            if self.stale_after_edit:
                self.stale, self.stale_after_edit = old, False
            if lost == "after":
                raise M["Refused"]("Network response lost after edit", "pr_write", True)
            return ""
        raise AssertionError(argv)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.env = patch.dict(os.environ, {"DORI_STATE_DIR": str(self.state), "HELIO_AUTOFIX": "on",
                                          "HELIO_AUTOFIX_DENY": "private/**"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.github = GitHub(self.state)
        self.store = M["Issues"]("o/r", self.state, command=self.github.command)
        self.proof = {"kind": "autofix", "paths": ["fix.py"], "lines": 1, "files": 1, "deny": "private/**"}

    def body(self, summary="Fix the regression."):
        return POSTS["pr_body"](7, None, POSTS["Report"](summary), (), 100)

    def publish(self, summary="Fix the regression.", adopt=None, authorize=None):
        return P["publish"](self.store, 7, "helio/autofix-7", self.github.head, self.body(summary),
                            "Fix regression", self.proof, M["digest"](self.github.issue["body"]),
                            URL if self.github.body is not None else None, adopt, authorize=authorize)

    def pending(self):
        with sqlite3.connect(self.state / "issue-updates.sqlite") as db:
            return db.execute("SELECT id FROM operations WHERE completed=0").fetchall()

    def test_durable_create_and_noop_replay_publish_once(self):
        self.assertEqual(self.publish(), URL)
        self.assertTrue(self.github.durable_before_post)
        self.assertEqual(self.publish(), URL)
        self.assertEqual((self.github.creates, self.github.edits), (1, 0))
        self.assertEqual(self.pending(), [])

    def test_bot_reconciles_lost_create_after_restart_without_repeating_a_post(self):
        self.github.lose_create = "after"
        with self.assertRaises(P["Refused"]):
            self.publish()
        self.assertEqual(len(self.pending()), 1)
        with sqlite3.connect(self.state / "issue-sync.sqlite") as db:
            self.assertEqual(db.execute("SELECT issue FROM tracked").fetchall(), [(7,)])
        restarted = M["Issues"]("o/r", self.state, command=self.github.command)
        restarted.publications(7)
        self.assertEqual(self.pending(), [])
        self.assertEqual((self.github.creates, self.github.edits), (1, 0))

    def test_bot_reconciles_absent_creation_and_retries_the_same_canonical_target(self):
        self.github.lose_create = "before"
        with self.assertRaises(P["Refused"]):
            self.publish()
        self.store.publications(7)
        self.store.publications(7)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 2)
        self.assertEqual(self.github.body, self.body())

    def test_lost_edit_is_settled_without_duplicate_writes_and_notes_survive(self):
        self.publish()
        self.github.body += "\nReviewer note: keep the unknown-history behavior.\n"
        self.github.lose_edit = "after"
        with self.assertRaises(P["Refused"]):
            self.publish("Clarify the accepted timestamp.")
        self.github.body += "A second reviewer note arrived during recovery.\n"
        self.store.publications(7)
        self.assertEqual((self.github.creates, self.github.edits), (1, 1))
        self.assertTrue(self.github.body.endswith("A second reviewer note arrived during recovery.\n"))
        self.assertIn("keep the unknown-history behavior.", self.github.body)
        self.assertEqual(self.pending(), [])

    def test_failed_edit_is_retried_by_the_bot_on_the_existing_pr(self):
        self.publish()
        self.github.lose_edit = "before"
        with self.assertRaises(P["Refused"]):
            self.publish("Clarify the accepted timestamp.")
        self.store.publications(7)
        self.assertEqual((self.github.creates, self.github.edits), (1, 2))
        self.assertIn("Clarify the accepted timestamp.", self.github.body)
        self.assertEqual(self.pending(), [])

    def test_stale_readback_does_not_report_success_or_repeat_a_landed_edit(self):
        self.publish()
        self.github.stale_after_edit = True
        with self.assertRaisesRegex(ValueError, "read-back is pending"):
            self.publish("Clarify the accepted timestamp.")
        self.store.publications(7)
        self.assertEqual((self.github.creates, self.github.edits), (1, 1))
        self.assertEqual(self.pending(), [])

    def test_bot_reviewed_adoption_repairs_a_conflict_without_renewing_user_authorization(self):
        self.publish()
        self.github.lose_edit = "before"
        with self.assertRaises(P["Refused"]):
            self.publish("Clarify the accepted timestamp.")
        self.github.body = self.github.body.replace("Fix the regression.", "Reviewed clarification.")
        with self.assertRaisesRegex(ValueError, "PR_EDITED_OUTSIDE_HELIO"):
            self.store.publications(7)
        self.assertEqual(self.publish("Reviewed clarification.", P["BODY"]["digest"](self.github.body)), URL)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 1)

    def test_recovery_rechecks_current_policy_scope_and_head_before_writing(self):
        self.publish()
        self.github.lose_edit = "before"
        with self.assertRaises(P["Refused"]):
            self.publish("Clarify the accepted timestamp.")
        for alteration in ["policy", "scope", "head"]:
            with self.subTest(alteration=alteration):
                old_scope, old_head = self.github.issue["body"], self.github.head
                with patch.dict(os.environ, {"HELIO_AUTOFIX": "off" if alteration == "policy" else "on"}):
                    self.github.issue["body"] += "Changed" if alteration == "scope" else ""
                    self.github.head = "b" * 40 if alteration == "head" else old_head
                    with self.assertRaises(ValueError):
                        self.store.publications(7)
                self.github.issue["body"], self.github.head = old_scope, old_head
        self.assertEqual(self.github.edits, 1)

    def test_legacy_adoption_is_exact_and_does_not_need_an_owner_interaction(self):
        self.github.body = "Reviewed legacy report, including the human's scope decision."
        with self.assertRaisesRegex(ValueError, "PR_EDITED_OUTSIDE_HELIO"):
            self.publish()
        self.assertEqual(self.publish(adopt=P["BODY"]["digest"](self.github.body)), URL)
        self.assertEqual((self.github.creates, self.github.edits), (0, 1))

    def test_creation_race_reuses_the_server_canonical_pr_without_user_help(self):
        self.github.lose_create = "after"
        with self.assertRaises(P["Refused"]):
            self.publish()
        self.github.stale_list = True
        self.store.publications(7)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 2)
        self.assertEqual(self.github.body, self.body())
        self.assertEqual(self.github.edits, 0)

    def test_bot_can_correct_a_definitively_rejected_report_without_replaying_the_bad_draft(self):
        self.github.reject_create = True
        with self.assertRaisesRegex(P["Refused"], "input rejected"):
            self.publish()
        self.assertEqual(self.publish("Corrected implementation report."), URL)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 2)

    def test_bot_can_correct_a_rejected_edit_without_asking_the_user_to_recover_it(self):
        self.publish()
        self.github.reject_edit = True
        with self.assertRaisesRegex(P["Refused"], "edit input rejected"):
            self.publish("Rejected draft.")
        self.assertEqual(self.publish("Corrected draft."), URL)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 1)
        self.assertEqual(self.github.edits, 2)
        self.assertIn("Corrected draft.", self.github.body)

    def test_recovery_selects_the_exact_publication_among_closed_branch_history(self):
        self.github.lose_create = "after"
        with self.assertRaises(P["Refused"]):
            self.publish()
        self.github.history = [{"url": "https://github.com/o/r/pull/2", "state": "MERGED", "headRefOid": "b" * 40,
                                "headRefName": "helio/autofix-7", "baseRefName": "main", "isCrossRepository": False,
                                "body": "Historical human report"}]
        self.store.publications(7)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 1)

    def test_bot_refreshes_unattempted_intent_when_the_branch_advances(self):
        self.github.remote_head = "b" * 40
        with self.assertRaisesRegex(P["Refused"], "branch advanced"):
            self.publish()
        self.assertEqual(self.github.creates, 0)
        self.github.head = self.github.remote_head
        self.assertEqual(self.publish("Fresh verified report."), URL)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.github.creates, 1)


if __name__ == "__main__":
    unittest.main()
