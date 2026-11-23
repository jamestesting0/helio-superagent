"""Concurrent and replayed lifecycle requests use one durable host admission."""
import hermetic  # noqa: F401
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import runpy
import subprocess
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE = runpy.run_path(str(ROOT / "scripts/helio_workspace.py"))
Workspace = MODULE["Workspace"]
Observation = MODULE["Observation"]
HOST = Workspace.action.__globals__
OWNER = "12345"
WORKSPACE = (123, "456", "boot")


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.workspace = Workspace(self.root)
        self.seen = Observation("stopped")
        self.entered = Event()
        self.release = Event()
        self.effects = []
        self.addCleanup(self.release.set)
        observation = patch.dict(HOST, {"observe": lambda: self.seen})
        observation.start()
        self.addCleanup(observation.stop)

    def dispatch(self, value):
        self.effects.append(value)
        self.entered.set()
        if not self.release.wait(5):
            raise AssertionError("The competing requests did not return while dispatch was in progress")

    def test_overlapping_commands_return_progress_and_never_dispatch_later(self):
        for winner in ("start", "stop"):
            with self.subTest(winner=winner):
                self.entered.clear()
                self.release.clear()
                self.effects.clear()
                self.seen = Observation("stopped") if winner == "start" else Observation("running", WORKSPACE, "pane:50")
                revision = self.workspace.status()["revision"]
                contender = Workspace(self.root)
                with (patch.dict(HOST, {"desktop_start": self.dispatch}),
                      patch.object(Workspace, "stop", side_effect=self.dispatch),
                      ThreadPoolExecutor() as pool):
                    first = pool.submit(self.workspace.action, winner, OWNER, f"{winner}-first", revision)
                    try:
                        self.assertTrue(self.entered.wait(5))
                        for action in ("start", "stop"):
                            self.assertEqual(contender.action(action, OWNER, f"{winner}-{action}-busy", revision), f"busy-{winner}")
                        self.assertEqual(contender.status()["state"], {"start": "starting", "stop": "stopping"}[winner])
                    finally:
                        self.release.set()
                    self.assertEqual(first.result(timeout=5), f"{winner}-pending")
                    if winner == "start":
                        contender.begin_launcher("start", self.effects[0])
                        with contender.database() as db:
                            pid = tuple(MODULE["json"].loads(contender.active(db)["launcher"]))
                        self.seen = Observation("running", pid, "pane:55")
                        self.assertEqual(contender.status()["state"], "running")
                    else:
                        self.seen = Observation("stopped")
                        with patch.dict(HOST, {"alive": lambda _: False}), patch.object(MODULE["subprocess"], "run") as run:
                            run.return_value.stdout = ""
                            self.assertEqual(contender.status()["state"], "stopped")
                    self.assertEqual(contender.action("start", OWNER, f"{winner}-start-busy", revision), f"busy-{winner}")
                    self.assertEqual(len(self.effects), 1)

    def test_expired_ticket_cannot_consume_a_newer_workspace_claim(self):
        tickets = []
        with patch.dict(HOST, {"desktop_start": tickets.append}), patch.object(MODULE["time"], "time", return_value=100) as clock:
            self.assertEqual(self.workspace.action("start", OWNER, "old"), "start-pending")
            clock.return_value = 200
            restarted = Workspace(self.root)
            self.assertEqual(restarted.status(OWNER)["last"], "desktop-unavailable")
            self.assertEqual(restarted.action("start", OWNER, "new"), "start-pending")
            with self.assertRaises(MODULE["WorkspaceError"]):
                restarted.begin_launcher("start", tickets[0])
            restarted.begin_launcher("start", tickets[1])
            with self.assertRaises(MODULE["WorkspaceError"]):
                restarted.begin_launcher("start", tickets[1])

    def test_replaced_workspace_rejects_an_existing_stop_confirmation(self):
        self.seen = Observation("running", WORKSPACE, "pane:1")
        preview = self.workspace.status()["revision"]
        self.seen = Observation("running", (WORKSPACE[0], "999", WORKSPACE[2]), "pane:1")
        with patch.object(Workspace, "stop") as stop:
            self.assertEqual(self.workspace.action("stop", OWNER, "stale", preview), "changed")
            stop.assert_not_called()

    def test_local_launcher_can_start_after_verified_cleanup_without_a_discord_read(self):
        self.seen = Observation("running", WORKSPACE, "pane:1")
        revision = self.workspace.status()["revision"]
        with patch.object(Workspace, "stop"):
            self.assertEqual(self.workspace.action("stop", OWNER, "closed", revision), "stop-pending")

        restarted = Workspace(self.root)
        with patch.dict(HOST, {"alive": lambda _: False}):
            restarted.begin_launcher("shell")
        with restarted.database() as db:
            self.assertEqual(restarted.active(db)["phase"], "local-shell")
            self.assertEqual(db.execute("SELECT outcome FROM workspace_operations WHERE id='closed'").fetchone()[0],
                             "stopped")

    def test_restart_waits_for_the_replacement_lead_before_admitting_a_stop(self):
        self.seen = Observation("running", WORKSPACE, "old:pane:50")
        previous = self.workspace.status()["revision"]
        with self.workspace.admission(), self.workspace.database() as db:
            self.workspace.begin_restart(db, self.seen)

        self.assertEqual(self.workspace.status()["state"], "starting")
        self.assertEqual(self.workspace.action("stop", OWNER, "during", previous), "busy-start")
        self.seen = Observation("running", WORKSPACE, "new:pane:51")
        self.assertEqual(self.workspace.status()["state"], "running")
        self.assertEqual(self.workspace.action("stop", OWNER, "old-confirmation", previous), "changed")

    def test_warm_start_waits_for_the_lead_in_its_own_pane(self):
        self.seen = Observation("idle", WORKSPACE)
        commands = []

        def herdr(*args):
            if args[0] == "tab":
                return {"root_pane": {"pane_id": "w1:p2"}}
            return {"process_info": {"shell_pid": 12, "foreground_processes": [{"pid": 12}]}}

        def dispatch(argv):
            commands.append(argv[-1])
            return subprocess.CompletedProcess(argv, 0, "", "")

        with patch.dict(HOST, {"herdr": herdr, "runtime_command": dispatch}):
            self.assertEqual(self.workspace.action("start", OWNER, "warm"), "start-pending")
            self.seen = Observation("running", WORKSPACE, "other", pane="w1:p1")
            self.assertEqual(self.workspace.status()["state"], "starting")
            self.seen = Observation("running", WORKSPACE, "verified", pane="w1:p2")
            self.assertEqual(self.workspace.status()["state"], "running")
            self.assertEqual(self.workspace.action("start", OWNER, "warm"), "running")
            self.assertEqual(commands, ["helio start"])
