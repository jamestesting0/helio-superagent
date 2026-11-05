import json
import runpy
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from state_fixture import build_state  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HEALTH = runpy.run_path(str(ROOT / "scripts/helio_health.py"))
NOW = 1_800_000_000.0
EPOCH_MS = 1420070400000


class Health(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / ".dori/elobot/state"
        build_state(self.state)
        (self.state / "housekeeping-last.json").write_text(json.dumps({"at": int(NOW - 3600), "mode": "applied", "backup": "daily.tar.gz"}))

    def tearDown(self):
        self.tmp.cleanup()

    def problems(self):
        return HEALTH["problems"](HEALTH["snapshot"](self.state, self.home, NOW), NOW)

    def test_a_quiet_installation_reports_no_problems(self):
        self.assertEqual(self.problems(), [])

    def test_backlog_stuck_lanes_worktrees_and_stale_upkeep_are_reported(self):
        with closing(sqlite3.connect(self.state / "discord-delivery.sqlite")) as db, db:
            db.execute("INSERT INTO delivery VALUES ('inbound', ?, '{}')", (str((int((NOW - 3 * 3600) * 1000) - EPOCH_MS) << 22),))
        (self.state / "lanes").mkdir()
        (self.state / "lanes/a.json").write_text(json.dumps({"key": "a", "status": "cleanup-pending"}))
        (self.state / "lanes/b.json").write_text(json.dumps({"key": "b", "launchState": "failed", "status": "not-done"}))
        for n in range(11):
            (self.state / f"worktrees/w{n}").mkdir(parents=True)
        (self.state / "housekeeping-last.json").write_text(json.dumps({"at": int(NOW - 3 * 86_400), "mode": "applied"}))
        self.assertEqual(self.problems(), [
            "oldest unaccepted message waiting 3h", "1 lane(s) cleanup-pending", "1 lane(s) launch-failed",
            "11 worktrees retaining 0.0 GiB", "housekeeping has not run in 2 days",
        ])

    def test_retained_worktrees_name_what_blocks_their_cleanup_and_databases_are_measured_alone(self):
        for n in range(11):
            (self.state / f"worktrees/w{n}").mkdir(parents=True)
        (self.state / "attachments").mkdir()
        (self.state / "attachments/big.bin").write_bytes(b"x" * 1_000_000)
        kept = [{"key": "w0", "reason": "lane is working"}, {"key": "w1", "reason": "PR acme/app#3 is OPEN"}]
        (self.state / "housekeeping-last.json").write_text(json.dumps({"at": int(NOW - 3600), "mode": "applied", "worktrees": {"kept": kept}}))
        health = HEALTH["snapshot"](self.state, self.home, NOW)
        self.assertIn("11 worktrees retaining 0.0 GiB; blocking cleanup: w0 (lane is working), w1 (PR acme/app#3 is OPEN)",
                      HEALTH["problems"](health, NOW))
        self.assertLess(health["storage"]["databases"], 1_000_000)
        self.assertGreaterEqual(health["storage"]["attachments"], 1_000_000)

    def test_old_housekeeping_reports_with_bare_keys_remain_readable(self):
        for n in range(11):
            (self.state / f"worktrees/w{n}").mkdir(parents=True)
        (self.state / "housekeeping-last.json").write_text(json.dumps({"at": int(NOW), "mode": "applied", "worktrees": {"kept": ["w0"]}}))
        self.assertTrue(any("w0" in problem for problem in self.problems()))

    def test_pending_first_run_approval_and_unreviewed_auto_blocks_are_reported(self):
        (self.state / "housekeeping-last.json").write_text(json.dumps({"at": int(NOW), "mode": "dry-run"}))
        with closing(sqlite3.connect(self.state / "discord-delivery.sqlite")) as db, db:
            db.execute("INSERT INTO blocked_users(user_id,source,reason,created_by,created_at) VALUES ('5','auto','spam','helio',0)")
        self.assertEqual(self.problems(), ["1 automatic blacklist entr(ies) awaiting owner review", "housekeeping awaits first-run approval"])


if __name__ == "__main__":
    unittest.main()
