"""Update the original installed inventory, independently of today's payload lists."""
from contextlib import redirect_stdout
import hashlib
from io import StringIO
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SYNC = runpy.run_path(str(ROOT / "scripts/sync-install.py"))

# Original two-runbook installation, not derived from the updater under test.
LEGACY_ELOBOT = (
    "GUIDE.md", "work-policy.md", "setup-prompt.md", "discord-qa-workflow.md",
    "oracle-restart-workflow.md", "knowledge-setup.py", "config.json",
    "browser-env", "start", "inbound", "ack", "context", "reply.ts",
    "reply.test.ts", "thread-target.ts", "thread-target.test.ts", "browser-env.test.ts",
)
LEGACY_INBOUND = (
    "ack.ts", "bug-reports.test.ts", "bun.lock", "catchup.test.ts", "catchup.ts",
    "context.ts", "learning-scope.ts", "learning-scope.test.ts",
    "delivery.test.ts", "delivery.ts", "filter.test.ts", "filter.ts",
    "fixtures/discord.ts", "flow.test.ts", "forwarded.test.ts", "forwarded.ts",
    "reply-context.ts", "reply-context.test.ts", "question-answer.ts",
    "question-answer.test.ts", "images.test.ts", "images.ts", "inbound.ts",
    "lastseen.ts", "package.json", "rest.ts",
)
# The kit now keeps these modules in area folders; their bytes are what the flat layout shipped.
SOURCE = {name: next(f for f in SYNC["INBOUND_FILES"] if f == name or f.endswith("/" + name)) for name in LEGACY_INBOUND}


class LegacySyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.base = self.home / ".dori/elobot"
        self.base.mkdir(parents=True)
        self.original_paths = {}
        mapping = SYNC["PAYLOAD"]["values"](self.home, str(self.home / "project"))
        for name in LEGACY_ELOBOT:
            target = self.base / name
            target.write_bytes(f"original kit content of {name}\n".encode())
            self.original_paths[name] = target
        config_path = self.base / "config.json"
        config = SYNC["PAYLOAD"]["render_config"](mapping)
        config["defaultCwd"] = str(self.home / "project")
        config["leadPane"] = "active-pane"
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        for name in LEGACY_INBOUND:
            target = self.home / ".dori/discord-inbound" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / "discord-inbound" / SOURCE[name]).read_bytes())
            self.original_paths["@inbound/" + name] = target
        for name in ("http.ts", "discord.ts"):
            relative = Path("vendor/dori-mode/scripts/src/messenger") / name
            target = self.base / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f"original vendored {name}".encode())
            self.original_paths["@messenger/" + name] = target
        self.launcher = self.home / ".local/bin/helio"
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text("owner isolation wrapper")
        (self.base / "trusted-users").write_text("owner reviewed trusted IDs")
        (self.base / "release-approvers").write_text("owner reviewed approvers")
        (self.base / "env").write_text("owner credentials")
        self.manifest = self.base / ".sync-manifest.json"

    def record_original_baseline(self):
        baseline = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for name, path in self.original_paths.items()}
        baseline["_configLeadPane"] = "active-pane"
        baseline["@launcher"] = "previous inner launcher baseline"
        self.manifest.write_text(json.dumps(baseline))

    def test_missing_report_channels_blocks_adoption_before_any_writes(self):
        with redirect_stdout(StringIO()), self.assertRaisesRegex(SystemExit, "report-channels"):
            SYNC["run"](self.home, "adopt")
        self.assertFalse(self.manifest.exists())
        self.assertFalse((self.base / "docs").exists())
        self.assertFalse((self.base / "report-channels").exists())
        self.assertEqual(self.launcher.read_text(), "owner isolation wrapper")

    def test_missing_report_channels_blocks_existing_baseline_update(self):
        self.record_original_baseline()
        before = self.manifest.read_bytes()
        with redirect_stdout(StringIO()), self.assertRaisesRegex(SystemExit, "report-channels"):
            SYNC["run"](self.home, "apply")
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertFalse((self.base / "docs").exists())

    def test_original_inventory_bootstraps_adoption_and_update(self):
        (self.base / "report-channels").write_text("owner reviewed report IDs")
        with redirect_stdout(StringIO()):
            SYNC["run"](self.home, "adopt")
        adopted = json.loads(self.manifest.read_text())
        self.assertNotIn("beta-maintenance-workflow.md", adopted)
        self.assertNotIn("channel-policy.env", adopted)
        self.assertIn("GUIDE.md", adopted)
        self.assertNotIn("helio-sessions.py", adopted)
        self.assertNotIn("@inbound/archived-threads.ts", adopted)
        self.assertFalse((self.base / "docs").exists())
        self.assertFalse((self.base / "channel-policy.env").exists())
        self.assertFalse((self.base / "helio-sessions.py").exists())
        self.assertFalse((self.home / ".dori/discord-inbound/archived-threads.ts").exists())
        with redirect_stdout(StringIO()):
            SYNC["run"](self.home, "apply")
        self.assert_updated()

    def test_original_manifest_updates_without_readoption(self):
        (self.base / "report-channels").write_text("owner reviewed report IDs")
        self.record_original_baseline()
        with redirect_stdout(StringIO()):
            SYNC["run"](self.home, "apply")
        self.assert_updated()
        manifest = json.loads(self.manifest.read_text())
        self.assertEqual(manifest["@launcher"], "previous inner launcher baseline")
        for name in ("filter.ts", "delivery.ts", "bug-reports.test.ts"):
            self.assertFalse((self.home / ".dori/discord-inbound" / name).exists())
            self.assertNotIn("@inbound/" + name, manifest)
        self.assertTrue((self.home / ".dori/discord-inbound/inbound.ts").is_file())

    def assert_updated(self):
        documents = SYNC["PAYLOAD"]["documents"]("isolated", SYNC["PAYLOAD"]["values"](self.home, str(self.home / "project")))
        manifest = json.loads(self.manifest.read_text())
        helper = self.base / "helio-sessions.py"
        self.assertEqual(helper.read_bytes(), (ROOT / "agent/helpers/helio-sessions.py").read_bytes())
        self.assertEqual(manifest["helio-sessions.py"], hashlib.sha256(helper.read_bytes()).hexdigest())
        self.assertFalse((self.base / "channel-policy.env").exists())
        self.assertFalse((self.base / "GUIDE.md").exists())
        self.assertNotIn("GUIDE.md", manifest)
        self.assertEqual(manifest["_profile"], "isolated")
        self.assertEqual((self.base / "env").read_text(), "owner credentials")
        for name in ("setup-prompt.md", "work-policy.md"):
            self.assertEqual((self.base / name).read_bytes(), documents[name])
        for name in ("discord-qa-workflow.md", "oracle-restart-workflow.md", "beta-maintenance-workflow.md"):
            self.assertTrue((self.base / name).is_symlink())
            self.assertEqual((self.base / name).read_bytes(), documents[name])
        for name in ("intake/archived-threads.ts", "intake/archived-threads.test.ts", "intake/authorization.ts", "interactive/handler.ts"):
            self.assertEqual((self.home / ".dori/discord-inbound" / name).read_bytes(),
                             (ROOT / "discord-inbound" / name).read_bytes())
        for name in ("http.ts", "discord.ts"):
            self.assertEqual((self.base / "vendor/dori-mode/scripts/src/messenger" / name).read_bytes(),
                             (ROOT / "vendor/dori-mode/scripts/src/messenger" / name).read_bytes())
        self.assertEqual((self.base / "report-channels").read_text(), "owner reviewed report IDs")
        self.assertEqual((self.base / "trusted-users").read_text(), "owner reviewed trusted IDs")
        self.assertEqual((self.base / "release-approvers").read_text(), "owner reviewed approvers")
        self.assertEqual(self.launcher.read_text(), "owner isolation wrapper")
        self.assertEqual(json.loads((self.base / "config.json").read_text())["leadPane"], "active-pane")
        loader = ROOT / "vendor/dori-mode/scripts/src/config.ts"
        script = (f"import {{ loadConfig }} from {json.dumps(str(loader))}; "
                  f"const config = await loadConfig({json.dumps(str(self.base / 'config.json'))}, {json.dumps(str(self.home))}); "
                  "console.log(JSON.stringify({maxWorkers:config.maxWorkers,hibernateAfterMin:config.hibernateAfterMin}));")
        loaded = subprocess.run(["bun", "--eval", script], capture_output=True, text=True, timeout=20)
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        config = json.loads((self.base / "config.json").read_text())
        self.assertEqual(json.loads(loaded.stdout), {key: config[key] for key in ("maxWorkers", "hibernateAfterMin")})
