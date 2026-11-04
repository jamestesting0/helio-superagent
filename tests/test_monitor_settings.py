import io
import json
import runpy
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTALL = runpy.run_path(str(ROOT / "scripts/install.py"))
SYNC = runpy.run_path(str(ROOT / "scripts/sync-install.py"))


class MonitorSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.project = self.home / "project"
        self.project.mkdir()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(INSTALL["install"](self.home, True, self.project), 0)
        (self.home / ".dori/elobot/report-channels").write_text("456")
        self.settings = self.project / ".omo/settings.json"

    def run_sync(self, action):
        out = io.StringIO()
        with redirect_stdout(out):
            SYNC["run"](self.home, action)
        return out.getvalue()

    def test_fresh_install_and_update_manage_only_the_monitor_limit(self):
        self.assertEqual(json.loads(self.settings.read_text())["terminal"]["monitorMaxCharsPerInjection"], 16384)
        original = {"terminal": {"monitorMaxCharsPerInjection": 4096, "monitorWakeBudget": 9},
                    "editor": {"theme": "local"}, "custom": [1, 2]}
        self.settings.write_text(json.dumps(original))
        before = self.settings.read_bytes()
        self.assertIn("set to 16384", self.run_sync("preview"))
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertIn("set to 16384", self.run_sync("apply"))
        original["terminal"]["monitorMaxCharsPerInjection"] = 16384
        self.assertEqual(json.loads(self.settings.read_text()), original)
        inode = self.settings.stat().st_ino
        self.assertIn("unchanged (16384)", self.run_sync("apply"))
        self.assertEqual(self.settings.stat().st_ino, inode)

    def test_missing_settings_are_created_but_unsafe_paths_and_shapes_are_refused(self):
        self.settings.unlink()
        self.run_sync("apply")
        self.assertEqual(json.loads(self.settings.read_text()), {"terminal": {"monitorMaxCharsPerInjection": 16384}})
        self.settings.unlink()
        outside = self.home / "outside.json"
        outside.write_text('{"terminal":{}}')
        self.settings.symlink_to(outside)
        with self.assertRaisesRegex(SystemExit, "Unsafe project settings"):
            self.run_sync("apply")
        self.assertEqual(outside.read_text(), '{"terminal":{}}')
        self.settings.unlink()
        self.settings.write_text('{"terminal":[]}')
        with self.assertRaisesRegex(SystemExit, "objects"):
            self.run_sync("apply")
        self.assertEqual(self.settings.read_text(), '{"terminal":[]}')
