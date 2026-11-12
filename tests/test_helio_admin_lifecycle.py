"""Host lifecycle observations against a real publisher process and kernel signals."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import runpy
import select
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class AdministrationLifecycleTests(unittest.TestCase):
    @contextmanager
    def publisher(self):
        module = runpy.run_path(str(ROOT / "scripts/helio_admin_lifecycle.py"))
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            controller = ROOT / "tests/fixtures/command-publisher.ts"
            version = hashlib.sha256(controller.read_bytes()).hexdigest()
            sources = home / "inbound"
            (sources / "admin").mkdir(parents=True)
            (sources / "admin/main.ts").write_text("deployed source")
            installed = runpy.run_path(str(ROOT / "scripts/helio_admin_install.py"))
            source_receipt = home / "controller-source.json"
            source_receipt.write_text(json.dumps({"controller_sha256": version,
                "source_sha256": installed["source_version"](sources)}))
            child = subprocess.Popen([hermetic.BUN, str(ROOT / "tests/fixtures/command-publisher.ts")],
                env={**os.environ, "HELIO_ADMIN_STATE_DIR": str(home), "HELIO_ADMIN_CONTROLLER_SHA256": version,
                     "HELIO_ADMIN_CREDENTIAL_SHA256": hashlib.sha256(b"fixture").hexdigest()},
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.line(child, "SYNC_DONE")
                functions = module["status"].__globals__
                def systemctl(argv, **kwargs):
                    self.assertEqual(argv[:3], ["systemctl", "show", "helio-admin-controller.service"])
                    return SimpleNamespace(returncode=0, stdout=f"ActiveState=active\nUnitFileState=enabled\nMainPID={child.pid}\n")
                config = SimpleNamespace(run_path=lambda path: {"load": lambda _: {"DORI_DISCORD_TOKEN": "fixture"}}
                    if Path(path).name == "helio_config.py" else installed)
                with patch.dict(functions, {"CONTROLLER": controller, "SOURCES": sources,
                        "SOURCE_RECEIPT": source_receipt, "OBSERVATION": home / "commands.json", "runpy": config}), \
                        patch("subprocess.run", side_effect=systemctl):
                    yield module, home, child
            finally:
                child.terminate()
                child.communicate(timeout=5)

    def line(self, child, expected):
        ready, _, _ = select.select([child.stdout], [], [], 5)
        self.assertTrue(ready, "publisher did not produce its subscribed result")
        self.assertEqual(child.stdout.readline().strip(), expected)

    def test_current_receipt_routes_a_real_signal_to_the_running_publisher(self):
        with self.publisher() as (module, home, child):
            self.assertEqual(module["status"]().state, "active")
            module["synchronize"]()
            self.line(child, "SYNC_DONE")
            receipt = json.loads((home / "commands.json").read_text())
            self.assertEqual(receipt["pid"], child.pid)
            self.assertEqual(receipt["dm"]["state"], "verified")

    def test_stale_process_receipt_cannot_authorize_a_signal(self):
        with self.publisher() as (module, home, child):
            path = home / "commands.json"
            receipt = json.loads(path.read_text())
            receipt["pid"] = child.pid + 1
            path.write_text(json.dumps(receipt))
            with patch("os.pidfd_open", side_effect=AssertionError("stale observation must not open a signal target")):
                self.assertEqual(module["synchronize"]().state, "starting")

    def test_new_credential_or_controller_versions_are_pending_without_signalling_old_code(self):
        with self.publisher() as (module, home, _child):
            path = home / "commands.json"
            original = json.loads(path.read_text())
            for name in ("loadedVersion", "credentialVersion"):
                with self.subTest(name=name):
                    changed = {**original, name: "previous-version"}
                    path.write_text(json.dumps(changed))
                    with patch("os.pidfd_open", side_effect=AssertionError("old controller must wait for activation")):
                        self.assertEqual(module["synchronize"]().state, "activation_pending")

    def test_matching_receipt_cannot_override_a_different_running_executable(self):
        with self.publisher() as (module, home, _child):
            other = home / "other-controller.js"
            other.write_bytes((ROOT / "tests/fixtures/command-publisher.ts").read_bytes())
            with patch.dict(module["status"].__globals__, {"CONTROLLER": other}), \
                    patch("os.pidfd_open", side_effect=AssertionError("wrong executable must not be signalled")):
                self.assertEqual(module["synchronize"]().state, "activation_pending")

    def test_updated_source_reports_deployment_pending_while_start_keeps_the_deployed_publisher(self):
        with self.publisher() as (module, home, child):
            self.assertFalse(module["status"]().deployment_pending)
            (home / "inbound/admin/main.ts").write_text("new staged source")
            status = module["activate"]()
            self.assertEqual(status.state, "active")
            self.assertTrue(status.deployment_pending)
            self.assertNotEqual(status.staged_version, status.deployed_source_version)
            self.line(child, "SYNC_DONE")
