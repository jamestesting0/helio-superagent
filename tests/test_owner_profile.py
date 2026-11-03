"""Run the real installer, updater and host wrapper against disposable owner homes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LEGACY = ("setup-prompt.md", "work-policy.md", "GUIDE.md")


class OwnerProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "owner home"
        self.kit = self.home / "PythonProjects/helio-superagent"
        self.kit.mkdir(parents=True)
        shutil.copytree(ROOT / "scripts", self.kit / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copyfile(ROOT / "helio.env.example", self.kit / "helio.env.example")
        for name in ("agent", "vendor", "omo", "elobot-checkout", "discord-inbound"):
            (self.kit / name).symlink_to(ROOT / name, target_is_directory=True)
        (self.home / "PythonProjects/elo-bot").mkdir()
        self.environment = {
            "HOME": str(self.home),
            "PATH": f"{Path(sys.executable).parent}:{os.defpath}",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        installed = self.command(sys.executable, str(self.kit / "scripts/install.py"), "--home", str(self.home), "--apply")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.base = self.home / ".dori/elobot"
        self.manifest = self.base / ".sync-manifest.json"
        self.launcher = self.home / ".local/bin/helio"
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_bytes((ROOT / "scripts/helio-host").read_bytes())
        self.launcher.chmod(0o700)
        self.private = {}
        for name in ("env", "beta.env", "beta-mongo.env", "trusted-users", "report-channels",
                     "release-approvers", "state/existing"):
            target = self.base / name
            target.parent.mkdir(exist_ok=True)
            target.write_text(f"preserve {name}")
            target.chmod(0o600)
            self.private[target] = (target.read_bytes(), target.stat().st_ino)
        # Model an owner home from the previous kit: reviewed owner documents that
        # the previous release shipped, and a baseline without profile metadata.
        shipped = []
        for name in LEGACY:
            content = f"reviewed owner {name} from the previous kit\n".encode()
            (self.base / name).write_bytes(content)
            shipped.append(f"PREVIOUSLY_SHIPPED['owner'].setdefault({name!r}, set()).add({hashlib.sha256(content).hexdigest()!r})")
        payload = self.kit / "scripts/helio_payload.py"
        payload.write_text(payload.read_text() + "\n" + "\n".join(shipped) + "\n")
        baseline = json.loads(self.manifest.read_text())
        baseline.pop("_profile")
        self.manifest.write_text(json.dumps(baseline))

    def command(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(args, env=self.environment, capture_output=True, text=True, check=False, timeout=30)

    def sync(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.command(sys.executable, str(self.kit / "scripts/sync-install.py"), "--home", str(self.home), *args)

    def snapshot(self) -> dict[Path, tuple[bytes, int, int]]:
        paths = [self.launcher, *(self.home / ".dori").rglob("*")]
        return {
            path: (os.readlink(path).encode() if path.is_symlink() else path.read_bytes(),
                   stat.S_IMODE(path.lstat().st_mode), path.lstat().st_ino)
            for path in paths if path.is_symlink() or path.is_file()
        }

    def activate_owner(self) -> None:
        result = self.sync("--profile", "owner", "--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unmarked_owner_home_is_never_converted_to_isolated(self) -> None:
        before = self.snapshot()
        result = self.command(str(self.launcher), "update", "--preview")
        self.assertEqual(result.returncode, 1)
        for name in LEGACY:
            self.assertIn(name, result.stdout)
        self.assertIn("--profile owner", result.stdout)
        self.assertEqual(self.snapshot(), before)

    def test_owner_activation_then_normal_host_update(self) -> None:
        before = self.snapshot()
        preview = self.sync("--profile", "owner")
        self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
        self.assertIn("GUIDE.md", preview.stdout)
        self.assertEqual(self.snapshot(), before)

        self.activate_owner()
        baseline = json.loads(self.manifest.read_text())
        self.assertEqual(baseline["_profile"], "owner")
        self.assertFalse((self.base / "GUIDE.md").exists())
        for name in ("setup-prompt.md", "work-policy.md"):
            content = (self.base / name).read_bytes()
            self.assertIn(b"Runtime profile: owner", content)
            self.assertNotIn(b"Runtime profile: isolated", content)
            self.assertEqual(baseline[name], hashlib.sha256(content).hexdigest())

        updated = self.command(str(self.launcher), "update")
        self.assertEqual(updated.returncode, 0, updated.stdout + updated.stderr)
        self.assertIn("Managed updates: none", updated.stdout)
        self.assertEqual(self.snapshot()[self.launcher], before[self.launcher])
        for path, expected in self.private.items():
            self.assertEqual((path.read_bytes(), path.stat().st_ino), expected)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_host_update_generates_configuration_from_helio_env(self) -> None:
        self.activate_owner()
        settings = self.home / ".config/helio/helio.env"
        settings.parent.mkdir(parents=True)
        filled = {"DORI_DISCORD_TOKEN": "token", "BOT_BETA_TOKEN": "beta", "COC_API_PASSWORD": "coc",
                  "HELPER_API_KEY": "helper", "HELIO_BETA_MONGO_URL": "mongodb://beta", "HELIO_TEST_CHANNEL": "77777777"}
        lines = [f"{line.split('=', 1)[0]}={filled[line.split('=', 1)[0]]}" if line.split("=", 1)[0] in filled else line
                 for line in (ROOT / "helio.env.example").read_text().splitlines()]
        settings.write_text("\n".join(lines) + "\n")
        settings.chmod(0o644)
        refused = self.command(str(self.launcher), "update")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("chmod 600", refused.stderr)
        settings.chmod(0o600)

        result = self.command(str(self.launcher), "update")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        env = (self.base / "env").read_text()
        self.assertIn("export DORI_DISCORD_TOKEN=token", env)
        self.assertNotIn("mongodb://beta", env)
        self.assertIn("MONGO_DB_URL=mongodb://beta", (self.base / "beta-mongo.env").read_text())
        self.assertEqual(stat.S_IMODE((self.base / "beta.env").stat().st_mode), 0o600)
        self.assertIn(b"77777777", (self.base / "work-policy.md").read_bytes() + (self.base / "setup-prompt.md").read_bytes())
        again = self.command(str(self.launcher), "update", "--preview")
        self.assertIn("Generated from helio.env: up to date", again.stdout)
        self.assertIn("Managed updates: none", again.stdout)

    def test_owner_activation_does_not_rebaseline_unrelated_conflicts(self) -> None:
        (self.base / "inbound").write_text("intentional local wrapper")
        before = self.snapshot()
        result = self.sync("--profile", "owner", "--apply")
        self.assertEqual(result.returncode, 1)
        self.assertIn("inbound", result.stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn("_profile", json.loads(self.manifest.read_text()))

    def test_active_owner_profile_still_refuses_genuine_policy_drift(self) -> None:
        self.activate_owner()
        for name in ("setup-prompt.md", "work-policy.md", "docs/oracle-restart-workflow.md"):
            with self.subTest(name=name):
                target = self.base / name
                original = target.read_bytes()
                target.write_bytes(original + b"\nIntentional local protections.\n")
                before = self.snapshot()
                result = self.command(str(self.launcher), "update")
                self.assertEqual(result.returncode, 1)
                self.assertIn(target.name, result.stdout)
                self.assertEqual(self.snapshot(), before)
                target.write_bytes(original)

    def test_invalid_profile_marker_cannot_fall_back_to_isolated(self) -> None:
        baseline = json.loads(self.manifest.read_text())
        for value in ("unknown", "", None, {"profile": "owner"}):
            with self.subTest(value=value):
                self.manifest.write_text(json.dumps({**baseline, "_profile": value}))
                before = self.snapshot()
                result = self.command(str(self.launcher), "update")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)

    def test_recorded_profile_cannot_be_overridden_or_replace_host_launcher(self) -> None:
        self.activate_owner()
        for options in (("--profile", "isolated", "--apply"), ("--update-launcher", "--apply")):
            with self.subTest(options=options):
                before = self.snapshot()
                result = self.sync(*options)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
