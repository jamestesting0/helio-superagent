"""Obligations are derived from custody, question and reply records; only a matching send or a waiver ends one."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import argparse
import contextlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LEDGER = runpy.run_path(str(ROOT / "scripts/helio_obligations.py"))
REPO = "o/r"
REQUEST = {"channel": "1220331873079922810", "message": "1570912484972302357"}
PR = f"https://github.com/{REPO}/pull/29"
EVENT = LEDGER["completion_event"](REPO, PR)


class ObligationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("CREATE TABLE reply_sends (target TEXT, text_hash TEXT, state TEXT)")
        with sqlite3.connect(self.state / "issue-updates.sqlite") as db:
            db.execute("CREATE TABLE pr_waits (repo TEXT, issue INTEGER, data TEXT)")
        with sqlite3.connect(self.state / "discord-questions.sqlite") as db:
            db.execute("CREATE TABLE questions (id TEXT, status TEXT, updated INTEGER)")
        with sqlite3.connect(self.state / "discord-conversations.sqlite") as db:
            db.execute("CREATE TABLE conversations (channel_id TEXT, user_id TEXT, status TEXT, anchor_message_id TEXT)")
            db.execute("INSERT INTO conversations VALUES ('1220331873079922810','996083715862184048','open','1570921095282954431')")

    def custody(self, issue, statuses):
        notices = [{"id": f"n{i}", "status": status, "at": 1000.0 + i, "acknowledged": True} for i, status in enumerate(statuses)]
        with sqlite3.connect(self.state / "issue-updates.sqlite") as db:
            db.execute("INSERT INTO pr_waits VALUES (?,?,?)", (REPO, issue, json.dumps(
                {"authority": REQUEST, "pr": f"https://github.com/{REPO}/pull/29", "notices": notices})))

    def sent(self, target, channel, event):
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("INSERT INTO reply_sends VALUES (?,?,'sent')", (target, f"event:{channel}:{event}"))

    def test_a_ready_pr_owes_its_requester_one_completion_until_that_exact_send(self):
        """2026-11-13: PR #29 reached ready, the lead read 'the controller owns completion' and nobody told James."""
        self.custody(28, ["waiting"])
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])
        self.custody(28, ["waiting", "ready"])
        owed = LEDGER["owed"](self.state, REPO)
        self.assertEqual([(o["kind"], o["issue"]) for o in owed], [("pr-ready", 28)])
        self.assertIn(f"--event {EVENT}", owed[0]["send"])
        self.assertIn(REQUEST["message"], owed[0]["send"])
        # A completion for another request in the same channel shares the event name but discharges nothing here.
        self.sent("1570887554843025409", REQUEST["channel"], EVENT)
        self.assertEqual(len(LEDGER["owed"](self.state, REPO)), 1)
        self.sent(REQUEST["message"], REQUEST["channel"], EVENT)
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])

    def test_a_waiver_with_a_reason_ends_an_obligation_and_an_empty_reason_is_refused(self):
        self.custody(28, ["ready"])
        with self.assertRaises(ValueError):
            LEDGER["waive"](self.state, LEDGER["pr_key"](REPO, 28, PR), " ")
        LEDGER["waive"](self.state, LEDGER["pr_key"](REPO, 28, PR), "requester withdrew the request")
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])

    def test_readiness_survives_source_pruning_and_settlement_survives_receipt_pruning(self):
        data = {"pr": PR, "authority": REQUEST, "notices": [{"status": "ready", "at": 10}]}
        LEDGER["record_pr"](self.state, REPO, 28, data)
        other = f"https://github.com/{REPO}/pull/30"
        LEDGER["record_pr"](self.state, REPO, 28, {**data, "pr": other})
        self.assertEqual({o["pr"] for o in LEDGER["owed"](self.state, REPO)}, {PR, other})
        self.sent(REQUEST["message"], REQUEST["channel"], EVENT)
        self.assertEqual([o["pr"] for o in LEDGER["owed"](self.state, REPO)], [other])
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("DELETE FROM reply_sends")
        self.assertEqual([o["pr"] for o in LEDGER["owed"](self.state, REPO)], [other])

    def test_an_answered_question_for_a_conversation_is_owed_to_that_requester_until_relayed(self):
        """2026-11-14: James answered Rascal's correction question; it was acknowledged and Rascal never heard."""
        link = LEDGER["link_question"](self.state, "cb1b83058dd74b51b343", "1570921095282954431", None)
        self.assertEqual((link["channel"], link["requester"]), ("1220331873079922810", "996083715862184048"))
        with sqlite3.connect(self.state / "discord-questions.sqlite") as db:
            db.execute("INSERT INTO questions VALUES ('cb1b83058dd74b51b343','awaiting_answer',1794651700000)")
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])
        with sqlite3.connect(self.state / "discord-questions.sqlite") as db:
            db.execute("UPDATE questions SET status='done'")
        owed = LEDGER["owed"](self.state, REPO)
        self.assertEqual([(o["kind"], o["requester"]) for o in owed], [("question-relay", "996083715862184048")])
        self.sent("1570921095282954431", "1220331873079922810", LEDGER["relay_event"]("cb1b83058dd74b51b343"))
        pending = LEDGER["owed"](self.state, REPO)
        self.assertEqual([item["key"] for item in pending], ["question:cb1b83058dd74b51b343"])
        self.assertIn("relay is already settled", pending[0]["send"])
        with sqlite3.connect(self.state / "discord-conversations.sqlite") as db:
            db.execute("UPDATE conversations SET status='resolved'")
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])

    def test_a_question_must_say_who_it_is_for(self):
        for topic, internal in ((None, None), ("1", "x"), ("999", None), (None, "  ")):
            with self.subTest(topic=topic, internal=internal), self.assertRaises(ValueError):
                LEDGER["link_question"](self.state, "q1", topic, internal)
        LEDGER["link_question"](self.state, "q2", None, "owner-only deploy decision")
        with sqlite3.connect(self.state / "discord-questions.sqlite") as db:
            db.execute("INSERT INTO questions VALUES ('q2','done',1)")
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])

    def test_an_answered_question_obligation_survives_question_pruning(self):
        LEDGER["link_question"](self.state, "q", "1570921095282954431", None)
        LEDGER["activate_question"](self.state, "q")
        self.assertEqual([o["key"] for o in LEDGER["owed"](self.state, REPO)], ["question:q"])
        self.sent("1570921095282954431", REQUEST["channel"], LEDGER["relay_event"]("q"))
        self.assertIn("relay is already settled", LEDGER["owed"](self.state, REPO)[0]["send"])
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("DELETE FROM reply_sends")
        with sqlite3.connect(self.state / "discord-conversations.sqlite") as db:
            db.execute("UPDATE conversations SET status='resolved'")
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])

    def test_the_monitor_line_repeats_hourly_until_the_obligation_ends(self):
        self.custody(28, ["ready"])
        self.assertEqual(len(LEDGER["surface"](self.state, REPO, now=10_000.0)), 1)
        self.assertEqual(LEDGER["surface"](self.state, REPO, now=10_000.0 + 60), [])
        self.assertTrue(LEDGER["surface"](self.state, REPO, now=10_000.0 + 3600)[0].startswith("OBLIGATION_DUE "))
        self.sent(REQUEST["message"], REQUEST["channel"], EVENT)
        self.assertEqual(LEDGER["surface"](self.state, REPO, now=10_000.0 + 7200), [])


class CustodyAckTests(unittest.TestCase):
    """Acknowledging a ready PR is refused until its requester was told, so the lead cannot skip the announcement."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.cli = runpy.run_path(str(ROOT / "scripts/helio_pr_recovery_cli.py"))
        store = self.cli["S"]
        state = self.state

        class Store:
            repo = REPO

            def __init__(self):
                self.state = state

            @contextlib.contextmanager
            def operations(self):
                db = sqlite3.connect(state / "issue-updates.sqlite")
                try:
                    store["migrate"](db)
                    yield db
                    db.commit()
                finally:
                    db.close()

        self.store = Store()
        notices = [{"id": "wait1", "status": "waiting", "at": 1.0, "acknowledged": False, "detail": "", "generation": 1, "key": "a"},
                   {"id": "ready1", "status": "ready", "at": 2.0, "acknowledged": False, "detail": "", "generation": 1, "key": "b"}]
        data = {"lane": "issue28-x", "source": "discord:1:2", "status": "ready", "notices": notices, "incidents": {},
                "authority": REQUEST, "pr": f"https://github.com/{REPO}/pull/29", "acknowledgment": 1}
        store["save"](self.store, store["Wait"](REPO, 28, "issue-28", 1, 0, data))
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("CREATE TABLE reply_sends (target TEXT, text_hash TEXT, state TEXT)")

    def ack(self, event, reason=None):
        args = argparse.Namespace(pr_command="phase", phase_action="ack", issue=28, event=event, no_completion=reason)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.cli["execute"](args, self.store, lambda argv: "")
        return code, out.getvalue()

    def test_a_ready_event_is_acknowledged_only_after_the_completion_was_sent(self):
        self.assertEqual(self.ack("wait1")[0], 0)
        code, out = self.ack("ready1")
        self.assertEqual(code, 2)
        self.assertIn(f"reply once to message {REQUEST['message']}", out)
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("INSERT INTO reply_sends VALUES (?,?,'sent')",
                       (REQUEST["message"], f"event:{REQUEST['channel']}:{EVENT}"))
        self.assertEqual(self.ack("ready1"), (0, "PR_CUSTODY_EVENT_ACK issue=28 event=ready1\n"))
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db:
            db.execute("DELETE FROM reply_sends")
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])

    def test_a_recorded_reason_may_acknowledge_without_telling_the_requester(self):
        self.assertEqual(self.ack("ready1", "requester withdrew the request")[0], 0)
        self.assertEqual(LEDGER["owed"](self.state, REPO), [])


if __name__ == "__main__":
    unittest.main()
