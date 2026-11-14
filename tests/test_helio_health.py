import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
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

    def test_external_wait_exposes_controller_ownership_and_cooldown_without_mutating_state(self):
        data = {"status": "waiting", "acknowledgment": 2, "pr": "https://github.com/o/r/pull/9",
                "head": "abc", "last_progress": NOW - 60, "notices": [{"acknowledged": False}],
                "incidents": {"dns": {"first_at": NOW - 8000, "resolved": False, "retries": [
                    {"slot": 0, "status": "finished", "finished_at": NOW - 30}]}}}
        with closing(sqlite3.connect(self.state / "issue-updates.sqlite")) as db, db:
            db.execute("INSERT INTO pr_waits VALUES ('o/r',9,'issue-9',2,5,?,?)", (json.dumps(data), NOW))
        row = HEALTH["snapshot"](self.state, self.home, NOW)["pr_custody"][0]
        self.assertTrue(row["implementation_complete"])
        self.assertEqual(row["next_owner"], "controller")
        self.assertEqual(row["next_probe"], NOW + 1770)
        self.assertEqual(row["last_progress"], NOW - 60)
        with closing(sqlite3.connect(self.state / "issue-updates.sqlite")) as db:
            self.assertEqual(db.execute("SELECT revision,data FROM pr_waits").fetchone(), (5, json.dumps(data)))

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
            "oldest unaccepted message waiting 3h",
            "11 worktrees retaining 0.0 GiB", "housekeeping has not run in 2 days",
        ])
        work = HEALTH["snapshot"](self.state, self.home, NOW)["work_attention"]
        self.assertEqual({row["key"]: row["status"] for row in work}, {"a": "cleanup-pending", "b": "launch-failed"})

    def test_old_lane_failure_is_dated_work_attention_without_claiming_an_intake_outage(self):
        (self.state / "lanes").mkdir()
        (self.state / "lanes/old.json").write_text(json.dumps({
            "key": "old", "launchState": "failed", "openedAt": "2026-11-01T00:00:00Z",
            "launchError": "EEXIST"}))
        health = HEALTH["snapshot"](self.state, self.home, NOW)
        self.assertEqual(HEALTH["problems"](health, NOW), [])
        failure = health["work_attention"][0]
        self.assertEqual(failure["key"], "old")
        self.assertEqual(failure["opened_at"], "2026-11-01T00:00:00Z")
        self.assertEqual(failure["error"], "EEXIST")
        self.assertEqual(failure["age_s"], 6508800)
        self.assertTrue((self.state / "lanes/old.json").exists())

    def test_retained_worktrees_name_what_blocks_their_cleanup_and_databases_are_measured_alone(self):
        for n in range(11):
            (self.state / f"worktrees/w{n}").mkdir(parents=True)
        (self.state / "attachments").mkdir()
        (self.state / "attachments/big.bin").write_bytes(b"x" * 1_000_000)
        kept = [{"key": "w0", "reason": "lane is working"}, {"key": "w1", "reason": "PR acme/app#3 is OPEN"}]
        (self.state / "housekeeping-last.json").write_text(json.dumps({"at": int(NOW - 3600), "mode": "applied", "worktrees": {"kept": kept}}))
        health = HEALTH["snapshot"](self.state, self.home, NOW)
        self.assertIn("11 worktrees retaining 0.0 GiB; blocking cleanup (as of 1h ago): w0 (lane is working), w1 (PR acme/app#3 is OPEN)",
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
