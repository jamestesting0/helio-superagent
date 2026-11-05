"""Read-only startup diagnostics against real stores and disposable process evidence."""
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
import unittest
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch
import subprocess

from state_fixture import build_state

ROOT = Path(__file__).resolve().parent.parent


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.base = self.home / ".dori/elobot"
        self.state = self.base / "state"
        build_state(self.state)
        self.doctor = runpy.run_path(str(ROOT / "scripts/helio_doctor.py"))
        (self.base / "deploy-state.json").write_text(json.dumps({"version": "new", "lead_version": "new"}))
        (self.state / "helio-lead-sessions.json").write_text(json.dumps([{"id": "lead-id", "project": "/project"}]))
        self.readiness = self.state / "intake-readiness.json"
        self.readiness.write_text(json.dumps({"phase": "ready", "pid": 5, "start_ticks": "100", "at_ms": 123}))
        self.transcript = self.home / ".omo/agent/sessions/--project--/date_lead-id.jsonl"
        self.transcript.parent.mkdir(parents=True)
        self.transcript.write_text(json.dumps({"type": "custom_message", "customType": "senpi-monitor:notification",
                                               "timestamp": "2026-11-05T15:00:00Z",
                                               "content": "An earlier coalesced notification is not readiness evidence"}) + "\n")
        self.processes = [
            {"pid": 10, "argv": ["omo", "--session-id", "lead-id"], "started_at": 0},
            {"pid": 11, "namespace_pid": 5, "start_ticks": "100",
             "argv": ["bun", "/home/james/.dori/discord-inbound/inbound.ts"], "started_at": 0},
        ]

    def snapshot(self):
        return self.doctor["snapshot"](self.home, runtime_home=Path("/home/james"), processes=self.processes)

    def test_work_attention_is_separate_from_running_ingestion_and_has_a_cause(self):
        lanes = self.state / "lanes"
        lanes.mkdir()
        (lanes / "old.json").write_text(json.dumps({
            "key": "old", "launchState": "failed", "launchError": "EEXIST: brief already exists",
            "openedAt": "2026-11-01T00:00:00Z",
        }))
        report = self.snapshot()
        self.assertTrue(report["ingestion"]["ready_observed"])
        self.assertEqual(report["ingestion"]["pids"], [11])
        self.assertEqual(report["lanes"]["failed"][0]["error"], "EEXIST: brief already exists")
        self.assertEqual(report["lanes"]["failed"][0]["inspect"], "helio dori show old")
        self.assertTrue(any("old" in item for item in report["attention"]))
        self.assertEqual(report["queues"]["answered_questions"], 0)
        self.assertEqual(report["dependencies"]["oracle"]["phase"], "running")
        self.assertFalse(report["dependencies"]["oracle"]["current_connectivity_verified"])

    def test_receipt_from_before_an_intake_restart_is_not_current_evidence(self):
        self.processes[1]["start_ticks"] = "200"
        self.assertFalse(self.snapshot()["ingestion"]["ready_observed"])
        self.processes.pop()
        self.assertEqual(self.snapshot()["ingestion"]["pids"], [])

    def test_installed_dori_monitors_are_recognized_and_lane_questions_do_not_mask_the_lead_watcher(self):
        for pid, action in enumerate(("watch", "dead-panes", "guard", "freshness"), 20):
            self.processes.append({"pid": pid, "argv": ["bun", "/home/james/.bun/bin/dori", action], "started_at": 0})
        self.processes.append({"pid": 30, "argv": ["python3", "/kit/scripts/helio-questions.py", "watch", "--lane", "worker"], "started_at": 0})
        monitors = self.snapshot()["monitors"]["processes"]
        self.assertEqual([monitors[key] for key in ("lanes", "dead_panes", "guard", "freshness")], [[20], [21], [22], [23]])
        self.assertEqual(monitors["questions"], [])

    def test_replayed_custody_and_quoted_message_previews_are_not_readiness_events(self):
        self.readiness.unlink()
        records = [
            {"type": "custom", "customType": "work-custody", "data": {"content": "INBOUND_READY allowed=100"}},
            {"type": "custom_message", "customType": "senpi-monitor:notification",
             "content": 'Monitor event(Inbound): INBOUND {"preview":"INBOUND_READY allowed=100"}'},
        ]
        self.transcript.write_text("".join(json.dumps({**r, "timestamp": "2026-11-05T15:00:00Z"}) + "\n" for r in records))
        self.assertFalse(self.snapshot()["ingestion"]["ready_observed"])

    def test_unknown_schema_and_corruption_are_reported_instead_of_zero(self):
        with closing(sqlite3.connect(self.state / "discord-delivery.sqlite")) as db, db:
            db.execute("DROP TABLE inbound_recovery")
        (self.base / "deploy-state.json").write_text("{")
        report = self.snapshot()
        self.assertIsNone(report["queues"]["recovery_pending"])
        self.assertTrue(any("inbound_recovery" in error for error in report["errors"]))
        self.assertTrue(any("deploy-state.json" in error for error in report["errors"]))
        (self.base / "deploy-state.json").write_text("[]")
        (self.state / "helio-lead-sessions.json").write_text("[null]")
        report = self.snapshot()
        self.assertIsNone(report["lead"]["session"])
        self.assertTrue(any("session record" in error for error in report["errors"]))

    def test_unknown_databases_are_not_created_and_private_environment_is_not_read(self):
        missing = self.home / "missing"
        missing.mkdir()
        (missing / "env").write_text("SECRET=do-not-show-this")
        report = self.doctor["snapshot"](missing, processes=[])
        self.assertFalse((missing / ".dori").exists())
        self.assertNotIn("do-not-show-this", json.dumps(report))
        self.assertIsNone(report["queues"]["pending_inbound"])

    def test_unreadable_state_reports_unknown_without_aborting_the_snapshot(self):
        self.state.chmod(0)
        try:
            report = self.snapshot()
        finally:
            self.state.chmod(0o700)
        self.assertIsNone(report["queues"]["pending_inbound"])
        self.assertIsNone(report["queues"]["unclaimed_inbound"])
        self.assertTrue(report["errors"])
        self.assertEqual(report["versions"]["version"], "new")

    def test_non_object_oracle_observation_does_not_hide_other_startup_state(self):
        with closing(sqlite3.connect(self.state / "discord-conversations.sqlite")) as db, db:
            db.execute("UPDATE oracle_observations SET data='[]' WHERE singleton=1")
        report = self.snapshot()
        self.assertEqual(report["queues"]["pending_inbound"], 0)
        self.assertTrue(any("Oracle observation" in error for error in report["errors"]))
        self.assertNotIn("phase", report["dependencies"]["oracle"])

    def test_snapshot_is_read_only_and_keeps_pending_answer_and_recovery_details(self):
        with closing(sqlite3.connect(self.state / "discord-questions.sqlite")) as db, db:
            db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,updated) "
                       "VALUES ('q','f','old','owner','99','Private question','answered',1)")
        with closing(sqlite3.connect(self.state / "discord-delivery.sqlite")) as db, db:
            db.execute("INSERT INTO inbound_recovery(id,source_hash,required_at) VALUES ('123','h','then')")
        before = {p: p.read_bytes() for p in self.state.glob("*.sqlite")}
        report = self.snapshot()
        self.assertEqual(report["queues"]["answered_questions"], 1)
        self.assertEqual(report["questions"][0]["inspect"], "helio question show q")
        self.assertEqual(report["queues"]["recovery_pending"], 1)
        self.assertNotIn("Private question", json.dumps(report))
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_host_admin_drops_privileges_and_does_not_enter_the_runtime(self):
        with patch("os.geteuid", return_value=0), patch("pwd.getpwnam", return_value=SimpleNamespace(pw_uid=999, pw_gid=999)):
            admin = runpy.run_path(str(ROOT / "scripts/helio_isolated_admin.py"))
        commands = []

        def run(argv, **kwargs):
            commands.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout="{}\n", stderr="")

        with patch.dict(admin["main"].__globals__, {"run": run}), \
                patch("sys.argv", ["admin", "doctor", "--json"]), patch("builtins.print"):
            self.assertEqual(admin["main"](), 0)
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][:8], ["setpriv", "--reuid", "999", "--regid", "999",
                                          "--clear-groups", "--no-new-privs", "/usr/bin/python3"])
        self.assertIn("-I", commands[0])
        self.assertEqual(commands[0][-1], "--json")
        self.assertFalse(any("herdr" in arg or "systemctl" in arg for arg in commands[0]))
