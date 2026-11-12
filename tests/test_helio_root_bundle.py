"""Root bundle rollout against temporary source and installed directories."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class RootBundleTests(unittest.TestCase):
    def test_administration_bootstrap_preserves_other_services_and_their_payloads(self):
        module = runpy.run_path(str(ROOT / "scripts/helio_root_bundle.py"))
        main = module["main"]
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            scripts, units = base / "kit/scripts", base / "kit/isolation/systemd"
            target, installed_units = base / "installed/scripts", base / "installed/units"
            for directory in (scripts, units, target, installed_units):
                directory.mkdir(parents=True)
            for name in module["BUNDLE"]:
                (scripts / name).write_text("updated " + name)
                (target / name).write_text("original " + name)
            for name in module["UNITS"]:
                (units / name).write_text("updated " + name)
                (installed_units / name).write_text("original " + name)
            (scripts.parent / "helio.env.example").write_text("template")
            commands = []
            with patch.dict(main.__globals__, {"__file__": str(scripts / "helio_root_bundle.py"),
                    "TARGET": target, "UNIT_TARGET": installed_units, "BACKUPS": base / "backups"}), \
                    patch("os.geteuid", return_value=0), \
                    patch("sys.argv", ["bundle", "--administration-only", "--apply"]), \
                    patch("subprocess.run", side_effect=lambda argv, **kwargs: commands.append(argv)), \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(main(), 0)
            self.assertEqual((target / "helio_admin_lifecycle.py").read_text(), "updated helio_admin_lifecycle.py")
            self.assertEqual((target / "helio_beta_service.py").read_text(), "original helio_beta_service.py")
            self.assertEqual((target / "helio_release_service.py").read_text(), "original helio_release_service.py")
            self.assertEqual((installed_units / "helio-release.service").read_text(), "original helio-release.service")
            self.assertEqual((installed_units / "helio-admin-controller.service").read_text(), "updated helio-admin-controller.service")
            self.assertEqual(commands, [["systemctl", "daemon-reload"]])
            installed = json.loads((target / "bundle-version.json").read_text())
            self.assertIn("helio_beta_service.py", installed["files"])
            self.assertIn("helio_admin_lifecycle.py", installed["files"])

    def test_unit_only_update_is_backed_up_installed_and_then_idempotent(self):
        module = runpy.run_path(str(ROOT / "scripts/helio_root_bundle.py"))
        main = module["main"]
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            scripts = base / "kit/scripts"
            scripts.mkdir(parents=True)
            units = scripts.parent / "isolation/systemd"
            units.mkdir(parents=True)
            target = base / "installed/scripts"
            target.mkdir(parents=True)
            installed_units = base / "installed/units"
            installed_units.mkdir()
            for name in module["BUNDLE"]:
                (scripts / name).write_text("same script")
                (target / name).write_text("same script")
            for name in module["UNITS"]:
                (units / name).write_text("new unit")
                (installed_units / name).write_text("old unit")
            (scripts.parent / "helio.env.example").write_text("same template")
            (target.parent / "helio.env.example").write_text("same template")
            commands = []
            def run(argv, **kwargs):
                commands.append(argv)
            with patch.dict(main.__globals__, {
                "__file__": str(scripts / "helio_root_bundle.py"),
                "TARGET": target, "UNIT_TARGET": installed_units, "BACKUPS": base / "backups",
            }), patch("os.geteuid", return_value=0), patch("sys.argv", ["bundle", "--apply"]), patch("subprocess.run", side_effect=run):
                preview = io.StringIO()
                with patch("sys.argv", ["bundle"]), redirect_stdout(preview):
                    self.assertEqual(main(), 0)
                self.assertEqual(set(json.loads(preview.getvalue())["changed"]),
                                 set(module["UNITS"]))
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 0)
                self.assertEqual((installed_units / "helio-release.service").read_text(), "new unit")
                self.assertEqual((installed_units / "helio-beta-maintenance.service").read_text(), "new unit")
                saved = list((base / "backups").glob("*/helio-release.service"))
                self.assertEqual(len(saved), 1)
                self.assertEqual(saved[0].read_text(), "old unit")
                self.assertIn(["systemctl", "daemon-reload"], commands)
                self.assertIn(["systemctl", "restart", "helio-release.service"], commands)
                self.assertIn(["systemctl", "restart", "helio-beta-maintenance.service"], commands)
                self.assertFalse(any("elobot" in argv for argv in commands))
                self.assertFalse(any(argv[:2] == ["systemctl", "restart"] and "helio-admin" in argv[-1]
                                     for argv in commands))
                commands.clear()
                output = io.StringIO()
                with redirect_stdout(output):
                    self.assertEqual(main(), 0)
                self.assertEqual(json.loads(output.getvalue())["changed"], [])
                self.assertEqual(commands, [])
                (scripts / "helio_doctor.py").write_text("updated read-only doctor")
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 0)
                self.assertEqual((target / "helio_doctor.py").read_text(), "updated read-only doctor")
                self.assertEqual(commands, [])
