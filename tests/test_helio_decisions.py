"""Ledger authority, idempotency and undo are exercised against real SQLite."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
from dataclasses import replace
from pathlib import Path
import runpy
import tempfile
import unittest

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_decisions.py"))


class DecisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = M["connect"](Path(self.temp.name) / "decisions.sqlite")
        self.addCleanup(self.db.close)
        self.rule = M["Decision"]("o/r", "rule", "copy-style", "project", "Use plain language",
                                   "Use plain language", "1", "owner", "100", "200", "owner")

    def test_replayed_source_creates_one_record_and_event(self):
        first = M["record"](self.db, self.rule)
        self.assertEqual(M["record"](self.db, self.rule), first)
        self.assertEqual(self.db.execute("SELECT count(*) FROM decision_events").fetchone()[0], 1)

    def test_conflict_without_replacement_preserves_original(self):
        first = M["record"](self.db, self.rule)
        with self.assertRaisesRegex(M["Refused"], "DECISION_CONFLICT"):
            M["record"](self.db, replace(self.rule, statement="Use legal language", message_id="201"))
        self.assertEqual([item["id"] for item in M["active"](self.db, "o/r")], [first])

    def test_trusted_author_cannot_replace_owner(self):
        first = M["record"](self.db, self.rule)
        with self.assertRaisesRegex(M["Refused"], "Only the owner"):
            M["record"](self.db, replace(self.rule, author_role="trusted", author_id="2", message_id="201"), first)
        self.assertEqual(self.db.execute("SELECT status FROM decisions WHERE id=?", (first,)).fetchone()[0], "active")

    def test_other_trusted_person_cannot_replace_or_revoke_hold(self):
        hold = replace(self.rule, kind="hold", scope="issue#4", author_id="2", author_role="trusted")
        first = M["record"](self.db, hold)
        with self.assertRaisesRegex(M["Refused"], "hold author"):
            M["record"](self.db, replace(hold, author_id="3", message_id="201"), first)
        with self.assertRaises(M["Refused"]):
            M["revoke"](self.db, first, "3", "1", "202")
        self.assertEqual([item["id"] for item in M["holds"](self.db, "o/r", {4}, "merge")], [first])

    def test_undo_replacement_restores_prior_rule_without_deleting_history(self):
        first = M["record"](self.db, self.rule)
        second = M["record"](self.db, replace(self.rule, statement="Use shorter language", message_id="201"), first)
        M["revoke"](self.db, second, "1", "1", "202")
        self.assertEqual([item["id"] for item in M["active"](self.db, "o/r")], [first])
        self.assertEqual(self.db.execute("SELECT count(*) FROM decisions").fetchone()[0], 2)

    def test_expired_lane_and_revoked_trust_are_not_silently_erased(self):
        first = M["record"](self.db, replace(self.rule, scope="lane:work"))
        second = M["record"](self.db, replace(self.rule, topic="other", author_id="2", author_role="trusted"))
        self.assertEqual(M["upkeep"](self.db, "o/r", {"1"}, {"work"}), [second])
        self.assertEqual(self.db.execute("SELECT status FROM decisions WHERE id=?", (first,)).fetchone()[0], "expired")
        self.assertEqual([item["id"] for item in M["active"](self.db, "o/r")], [second])

    def test_release_preflight_blocks_linked_hold_until_author_lifts_it(self):
        checker = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/release-check.py"))
        hold = replace(self.rule, kind="hold", scope="issue#4", action="merge")
        identity = M["record"](self.db, hold)
        namespace = checker["require_no_holds"].__globals__
        namespace.update(STATE=Path(self.temp.name), REPO="o/r")
        for link in ({"closingIssuesReferences": [{"number": 4}]}, {"body": "Implements #4"}):
            with self.subTest(link=link), self.assertRaisesRegex(checker["Refused"], "Active issue hold"):
                checker["require_no_holds"]("merge", link)
        M["revoke"](self.db, identity, "1", "1", "201")
        checker["require_no_holds"]("merge", {"closingIssuesReferences": [{"number": 4}]})
