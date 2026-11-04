"""Oracle transitions remain pending until handled and baseline does not alert."""
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

    def test_one_restart_is_not_a_crash_loop(self):
        with sqlite3.connect(":memory:") as db:
            M["poll"](db, lambda: {"phase": "running", "restart_count": 0})
            one = M["poll"](db, lambda: {"phase": "running", "restart_count": 1})
            self.assertFalse(one["crash_loop"])
            three = M["poll"](db, lambda: {"phase": "running", "restart_count": 3})
            self.assertTrue(three["crash_loop"])
