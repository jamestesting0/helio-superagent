"""The single helio.env drives every generated runtime file."""
from pathlib import Path
import runpy
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO

ROOT = Path(__file__).resolve().parent.parent
CONFIG = runpy.run_path(str(ROOT / "scripts/helio_config.py"))
SECRETS = {"DORI_DISCORD_TOKEN": "discord-secret", "BOT_BETA_TOKEN": "beta-secret", "COC_API_PASSWORD": "coc-secret",
           "HELPER_API_KEY": "helper-secret", "HELIO_BETA_MONGO_URL": "mongodb://beta-secret"}


class HelioConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def write_settings(self, **overrides):
        path = CONFIG["config_path"](self.home)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(f"{k}={v}\n" for k, v in {**SECRETS, **overrides}.items()))
        path.chmod(0o600)

    def test_agent_env_never_receives_beta_secrets(self):
        files = CONFIG["generate"](SECRETS, self.home)
        env = files["env"][0].decode()
        self.assertIn("discord-secret", env)
        for secret in ("beta-secret", "coc-secret", "helper-secret"):
            self.assertNotIn(secret, env)
        self.assertIn("MONGO_DB_URL=mongodb://beta-secret", files["beta.env"][0].decode())
        self.assertEqual({files[name][1] for name in ("env", "beta.env", "beta-mongo.env")}, {0o600})
        self.assertIn(f"export HELIO_PROJECT={self.home}/PythonProjects/elo-bot", env)
        self.assertIn("export DORI_DISCORD_BUG_REPORT_SOURCE=1212767017917218876:1566842840716152962", env)

    def test_validation_reports_typos_and_inconsistent_channels(self):
        issues = CONFIG["problems"]({**SECRETS, "DORI_DISCORD_TRUSTED_CHANNELS": "12345678", "HELIO_TRUSTED_USER": "1"})
        self.assertTrue(any("HELIO_TRUSTED_USER" in issue for issue in issues))
        self.assertTrue(any("DORI_DISCORD_TRUSTED_CHANNELS" in issue for issue in issues))
        self.assertTrue(any("DORI_DISCORD_TOKEN" in issue for issue in CONFIG["problems"]({})))

    def test_switches_counts_and_deny_globs_are_typed(self):
        self.assertEqual(CONFIG["problems"](SECRETS), [])
        env = CONFIG["generate"](SECRETS, self.home)["env"][0].decode()
        self.assertIn("export HELIO_ANSWER_FOR_OWNER=on", env)
        self.assertIn("export HELIO_AUTOFIX_DENY='requirements*.txt,", env)
        bad = {"HELIO_AUTOFIX": "yes", "HELIO_OWNER_PRESENT_MINUTES": "0", "HELIO_AUTOFIX_MAX_LINES": "40 ",
               "HELIO_AUTOFIX_DENY": "main.py,../outside"}
        issues = " ".join(CONFIG["problems"]({**SECRETS, **bad}))
        for key in bad:
            self.assertIn(key, issues)
        for deny in ("/etc/passwd", "a b.py", "x,,y", "docs/.."):
            self.assertIn("HELIO_AUTOFIX_DENY", " ".join(CONFIG["problems"]({**SECRETS, "HELIO_AUTOFIX_DENY": deny})))

    def test_worker_cap_and_hibernation_come_from_helio_env(self):
        payload = runpy.run_path(str(ROOT / "scripts/helio_payload.py"))
        rendered = lambda env: payload["render_config"](payload["values"](self.home, str(self.home / "repo"), env))
        defaults = rendered({})
        self.assertEqual((defaults["maxWorkers"], defaults["hibernateAfterMin"]), (4, 30))
        custom = rendered({"HELIO_MAX_WORKERS": "2", "HELIO_HIBERNATE_AFTER_MIN": "45"})
        self.assertEqual((custom["maxWorkers"], custom["hibernateAfterMin"]), (2, 45))
        issues = " ".join(CONFIG["problems"]({**SECRETS, "HELIO_MAX_WORKERS": "0", "HELIO_HIBERNATE_AFTER_MIN": "soon"}))
        self.assertIn("HELIO_MAX_WORKERS", issues)
        self.assertIn("HELIO_HIBERNATE_AFTER_MIN", issues)

    def test_render_writes_private_files_and_is_idempotent(self):
        self.write_settings(HELIO_TRUSTED_USERS="11111,22222")
        with redirect_stdout(StringIO()):
            self.assertEqual(CONFIG["render"](self.home, False), 6)
            self.assertFalse((self.home / ".dori").exists())
            CONFIG["render"](self.home, True)
            self.assertEqual(CONFIG["render"](self.home, True), 0)
        base = self.home / ".dori/elobot"
        self.assertEqual((base / "trusted-users").read_text(), "11111,22222\n")
        self.assertEqual(stat.S_IMODE((base / "env").stat().st_mode), 0o600)

    def test_render_refuses_a_world_readable_settings_file(self):
        self.write_settings()
        CONFIG["config_path"](self.home).chmod(0o644)
        with self.assertRaisesRegex(SystemExit, "chmod 600"):
            CONFIG["render"](self.home, True)
        self.assertFalse((self.home / ".dori").exists())

    def test_init_from_installed_uses_the_values_the_wrappers_used(self):
        base = self.home / ".dori/elobot"
        base.mkdir(parents=True)
        (base / "env").write_text("export DORI_DISCORD_TOKEN='discord-secret'\nexport DORI_DISCORD_ALLOWED='11111'\n")
        (base / "channel-policy.env").write_text("export DORI_DISCORD_ALLOWED='11111,22222'\n")
        (base / "beta.env").write_text("BOT_BETA_TOKEN=beta-secret\nMONGO_DB_URL=mongodb://beta-secret\n")
        (base / "trusted-users").write_text("33333, 44444\n")
        with redirect_stdout(StringIO()):
            CONFIG["init"](self.home, True)
        values = CONFIG["load"](self.home)
        self.assertEqual(values["DORI_DISCORD_ALLOWED"], "11111,22222")
        self.assertEqual(values["HELIO_TRUSTED_USERS"], "33333,44444")
        self.assertEqual(values["HELIO_BETA_MONGO_URL"], "mongodb://beta-secret")
        with self.assertRaisesRegex(SystemExit, "already exists"):
            CONFIG["init"](self.home, True)


if __name__ == "__main__":
    unittest.main()
