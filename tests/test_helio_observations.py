"""Oracle transitions remain pending until handled and baseline does not alert."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import runpy
import sqlite3
import unittest
from pathlib import Path

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_observations.py"))


class ObservationTests(unittest.TestCase):
    def test_baseline_then_outage_are_durable_without_followup_issues(self):
        with sqlite3.connect(":memory:") as db:
            M["poll"](db, lambda: {"phase": "running", "restart_count": 0})
            self.assertEqual(M["pending"](db), [])
            for _ in range(2):
                M["poll"](db, lambda: {"phase": "failed", "restart_count": 0})
            self.assertEqual(M["pending"](db), [1])
            db.execute("UPDATE oracle_events SET handled=1 WHERE id=1")
            self.assertEqual(M["pending"](db), [])

    def test_event_detail_names_the_transition_not_just_the_latest_snapshot(self):
        with sqlite3.connect(":memory:") as db:
            M["poll"](db, lambda: {"phase": "running", "running_revision": "a" * 40, "restart_count": 0})
            M["poll"](db, lambda: {"phase": "running", "running_revision": "b" * 40, "restart_count": 1})
            M["poll"](db, lambda: {"phase": "running", "running_revision": "b" * 40, "restart_count": 1, "gateway_health": "connected"})
            detail = M["detail"](db, 1)
            self.assertEqual((detail["from"]["running_revision"], detail["to"]["running_revision"]), ("a" * 40, "b" * 40))
            self.assertEqual(detail["changes"], ["running revision aaaaaaaa -> bbbbbbbb"])

    def test_inspection_outages_are_not_oracle_events(self):
        with sqlite3.connect(":memory:") as db:
            M["poll"](db, lambda: {"phase": "running", "running_revision": "a" * 40, "restart_count": 0})
            M["poll"](db, lambda: (_ for _ in ()).throw(RuntimeError("broker down")))
            M["poll"](db, lambda: {"phase": "running", "running_revision": "a" * 40, "restart_count": 0})
            self.assertEqual(M["pending"](db), [])
            M["poll"](db, lambda: (_ for _ in ()).throw(RuntimeError("broker down")))
            M["poll"](db, lambda: {"phase": "failed", "restart_count": 0})
            self.assertEqual(M["detail"](db, M["pending"](db)[0])["changes"], ["phase running -> failed"])

    def test_events_stored_before_transitions_say_so(self):
        with sqlite3.connect(":memory:") as db:
            M["poll"](db, lambda: {"phase": "running", "restart_count": 0})
            db.execute("INSERT INTO oracle_events(data) VALUES (?)", ('{"phase":"running"}',))
            detail = M["detail"](db, 1)
            self.assertTrue(detail["legacy"])
            self.assertEqual(detail["snapshot"], {"phase": "running"})

    def test_one_restart_is_not_a_crash_loop(self):
        with sqlite3.connect(":memory:") as db:
            M["poll"](db, lambda: {"phase": "running", "restart_count": 0})
            one = M["poll"](db, lambda: {"phase": "running", "restart_count": 1})
            self.assertFalse(one["crash_loop"])
            three = M["poll"](db, lambda: {"phase": "running", "restart_count": 3})
            self.assertTrue(three["crash_loop"])
