"""A recovered publication spends its creation receipt and finishes bot bookkeeping."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import datetime
import os
import runpy
import sqlite3
import unittest
from unittest.mock import patch
import test_pr_publication as fixtures

WORK = runpy.run_path(str(fixtures.ROOT / "scripts/helio-work.py"))


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.task = fixtures.PublicationTests()
        self.addCleanup(self.task.doCleanups)
        self.task.setUp()

    def test_background_completion_spends_creation_but_keeps_existing_task_continuation(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        grant = WORK["Authorization"]("o/r", 7, "12345", "23456", "34567", now, source_hash="f" * 64)
        WORK["record"](grant)
        self.task.proof = {"message": grant.message, "channel": grant.channel, "author": grant.author,
                           "source_hash": grant.source_hash}
        self.task.github.lose_create = "after"
        with self.assertRaises(fixtures.P["Refused"]):
            fixtures.P["publish"](self.task.store, 7, "helio/autofix-7", self.task.github.head, self.task.body(),
                "Fix regression", self.task.proof, fixtures.M["digest"](self.task.github.issue["body"]), authorize=lambda: None)
        self.assertEqual(WORK["available"]("o/r", 7, now).message, grant.message)

        restarted = fixtures.M["Issues"]("o/r", self.task.state, command=self.task.github.command)
        restarted.publications(7)

        with self.assertRaises(WORK["Refused"]):
            WORK["available"]("o/r", 7, now)
        self.assertEqual(WORK["available"]("o/r", 7, now, include_used=True).message, grant.message)
        with sqlite3.connect(self.task.state / "work-authorizations.sqlite") as db:
            self.assertEqual(db.execute("SELECT used FROM authorizations").fetchall(), [(1,)])
        with sqlite3.connect(self.task.state / "issue-updates.sqlite") as db:
            self.assertEqual(db.execute("SELECT completed FROM operations").fetchall(), [(1,)])
        self.assertEqual(self.task.github.creates, 1)

    def test_background_recovery_waits_while_the_requester_holds_publication(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        grant = WORK["Authorization"]("o/r", 7, "12345", "23456", "34567", now - datetime.timedelta(seconds=2), source_hash="f" * 64)
        WORK["record"](grant)
        self.task.proof = {"message": grant.message, "channel": grant.channel, "author": grant.author,
                           "source_hash": grant.source_hash}
        self.task.github.lose_create = "before"
        with self.assertRaises(fixtures.P["Refused"]):
            fixtures.P["publish"](self.task.store, 7, "helio/autofix-7", self.task.github.head, self.task.body(),
                "Fix regression", self.task.proof, fixtures.M["digest"](self.task.github.issue["body"]), authorize=lambda: None)
        WORK["record"](WORK["Authorization"]("o/r", 7, "12346", "23456", "34567", now - datetime.timedelta(seconds=1),
                                             "e" * 64, "request", ("no-pr",)))
        restarted = fixtures.M["Issues"]("o/r", self.task.state, command=self.task.github.command)
        with self.assertRaisesRegex(ValueError, "Held by the requester"):
            restarted.publications(7)
        self.assertEqual(self.task.github.creates, 1)
        self.assertEqual(WORK["available"]("o/r", 7, now).holds, ("no-pr",))

    def test_noop_delivery_spends_a_new_creation_receipt_without_another_pr_or_edit(self):
        self.task.publish()
        now = datetime.datetime.now(datetime.timezone.utc)
        grant = WORK["Authorization"]("o/r", 7, "12346", "23456", "34567", now, source_hash="e" * 64)
        WORK["record"](grant)
        self.task.proof = {"message": grant.message, "channel": grant.channel, "author": grant.author,
                           "source_hash": grant.source_hash}
        self.assertEqual(self.task.publish(authorize=lambda: None), fixtures.URL)
        with self.assertRaises(WORK["Refused"]):
            WORK["available"]("o/r", 7, now)
        self.assertEqual(WORK["available"]("o/r", 7, now, include_used=True).message, grant.message)
        self.assertEqual((self.task.github.creates, self.task.github.edits), (1, 0))

    def test_background_autofix_waits_for_current_capacity_without_user_recovery(self):
        self.task.github.lose_create = "before"
        with self.assertRaises(fixtures.P["Refused"]):
            self.task.publish()
        self.task.github.autofix_count = 1
        with patch.dict(os.environ, {"HELIO_AUTOFIX_MAX_OPEN": "1"}):
            with self.assertRaisesRegex(ValueError, "cap"):
                self.task.store.publications(7)
        self.assertEqual(self.task.github.creates, 1)
        self.task.github.autofix_count = 0
        self.task.store.publications(7)
        self.assertEqual(self.task.pending(), [])
        self.assertEqual(self.task.github.creates, 2)


if __name__ == "__main__":
    unittest.main()
