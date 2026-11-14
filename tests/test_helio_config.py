"""The single helio.env drives every generated runtime file."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
from pathlib import Path
import runpy
import stat
import json
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
               "HELIO_AUTOFIX_DENY": "main.py,../outside", "HELIO_AUTOBLOCK_WINDOW_H": "25"}
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
        self.assertEqual(CONFIG["problems"]({**SECRETS, "HELIO_HIBERNATE_AFTER_MIN": "0"}), [])
        self.assertEqual(rendered({"HELIO_HIBERNATE_AFTER_MIN": "0"})["hibernateAfterMin"], 0)
        custom = rendered({"HELIO_MAX_WORKERS": "2", "HELIO_HIBERNATE_AFTER_MIN": "45"})
        self.assertEqual((custom["maxWorkers"], custom["hibernateAfterMin"]), (2, 45))
        issues = " ".join(CONFIG["problems"]({**SECRETS, "HELIO_MAX_WORKERS": "0", "HELIO_HIBERNATE_AFTER_MIN": "soon"}))
        self.assertIn("HELIO_MAX_WORKERS", issues)
        self.assertIn("HELIO_HIBERNATE_AFTER_MIN", issues)

    def test_pr_custody_is_off_by_default_and_changes_current_admission_snapshot(self):
        recovery = runpy.run_path(str(ROOT / "scripts/helio_pr_recovery.py"))
        path = self.home / ".dori/elobot/policy/lane-settings.json"
        path.parent.mkdir(parents=True)
        for flag, expected in (("off", False), ("on", True), ("off", False)):
            files = CONFIG["generate"]({**SECRETS, "HELIO_PR_CUSTODY": flag}, self.home)
            path.write_bytes(files["policy/lane-settings.json"][0])
            self.assertEqual(recovery["admitted"](self.home), expected)
        self.assertFalse(json.loads(CONFIG["generate"](SECRETS, self.home)["policy/lane-settings.json"][0])["prCustody"])
        self.assertIn("HELIO_PR_CUSTODY", " ".join(CONFIG["problems"]({**SECRETS, "HELIO_PR_CUSTODY": "yes"})))

    def test_render_writes_private_files_and_is_idempotent(self):
        self.write_settings(HELIO_TRUSTED_USERS="11111,22222")
        with redirect_stdout(StringIO()):
            self.assertEqual(CONFIG["render"](self.home, False), 8)
            self.assertFalse((self.home / ".dori").exists())
            CONFIG["render"](self.home, True)
            self.assertEqual(CONFIG["render"](self.home, True), 0)
        base = self.home / ".dori/elobot"
        self.assertEqual((base / "trusted-users").read_text(), "11111,22222\n")
        self.assertEqual(stat.S_IMODE((base / "env").stat().st_mode), 0o600)

    def test_public_policy_has_current_authority_but_no_credentials(self):
        values = {**SECRETS, "HELIO_TRUSTED_USERS": "11111,22222"}
        files = CONFIG["generate"](values, self.home)
        policy = json.loads(files["policy/policy.json"][0])
        self.assertEqual(policy["values"]["HELIO_TRUSTED_USERS"], "11111,22222")
        self.assertEqual(policy["revision"], CONFIG["policy_revision"](values, self.home))
        self.assertEqual(files["policy/policy.json"][1], 0o644)
        for key, secret in SECRETS.items():
            self.assertNotIn(key, policy["values"])
            self.assertNotIn(secret, files["policy/policy.json"][0].decode())

    def test_owner_change_is_canonical_idempotent_and_survives_render(self):
        self.write_settings(HELIO_TRUSTED_USERS="11111")
        revision = CONFIG["policy_revision"](CONFIG["load"](self.home), self.home)
        with redirect_stdout(StringIO()):
            result = CONFIG["change"](self.home, "grant-1", "653894110884921366",
                                      revision, "trusted.add", "22222", "")
            repeated = CONFIG["change"](self.home, "grant-1", "653894110884921366",
                                        revision, "trusted.add", "22222", "")
            CONFIG["render"](self.home, True)
        self.assertEqual(result, repeated)
        self.assertEqual(CONFIG["load"](self.home)["HELIO_TRUSTED_USERS"], "11111,22222")
        self.assertEqual((self.home / ".dori/elobot/trusted-users").read_text(), "11111,22222\n")
        self.assertNotEqual(result["revision"], revision)

    def test_owner_revoke_and_timer_changes_reach_canonical_and_published_configuration(self):
        for action, target, value, key, expected in (
                ("trusted.remove", "22222", "", "HELIO_TRUSTED_USERS", "11111"),
                ("timeout.set", "HELIO_HIBERNATE_AFTER_MIN", "45", "HELIO_HIBERNATE_AFTER_MIN", "45")):
            with self.subTest(action=action):
                self.write_settings(HELIO_TRUSTED_USERS="11111,22222")
                revision = CONFIG["policy_revision"](CONFIG["load"](self.home), self.home)

                with redirect_stdout(StringIO()):
                    CONFIG["change"](self.home, "accepted-" + action.replace(".", "-"), "653894110884921366",
                                     revision, action, target, value)

                self.assertEqual(CONFIG["load"](self.home)[key], expected)
                published = json.loads((self.home / ".dori/elobot/policy/policy.json").read_text())
                self.assertEqual(published["values"][key], expected)

    def test_concurrent_owner_edits_cannot_overwrite_a_committed_revision(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier

        self.write_settings(HELIO_TRUSTED_USERS="11111")
        revision = CONFIG["policy_revision"](CONFIG["load"](self.home), self.home)
        barrier = Barrier(2)

        def grant(target):
            barrier.wait()
            try:
                CONFIG["change"](self.home, "race-" + target, "653894110884921366",
                                 revision, "trusted.add", target, "")
                return "saved"
            except CONFIG["ConfigConflict"]:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(grant, ("22222", "33333")))
        self.assertCountEqual(outcomes, ["saved", "conflict"])
        self.assertIn(set(CONFIG["load"](self.home)["HELIO_TRUSTED_USERS"].split(",")),
                      ({"11111", "22222"}, {"11111", "33333"}))

    def test_stale_or_unauthorized_setting_change_preserves_canonical_file(self):
        self.write_settings()
        before = CONFIG["config_path"](self.home).read_bytes()
        revision = CONFIG["policy_revision"](CONFIG["load"](self.home), self.home)
        for actor, expected in (("11111", revision), ("653894110884921366", "0" * 64)):
            with self.subTest(actor=actor, revision=expected), self.assertRaises(CONFIG["ConfigConflict"]):
                CONFIG["change"](self.home, "denied-" + actor, actor, expected,
                                 "timeout.set", "HELIO_HIBERNATE_AFTER_MIN", "45")
        self.assertEqual(CONFIG["config_path"](self.home).read_bytes(), before)

    def test_channel_policy_change_updates_all_overlapping_lists_together(self):
        for policy in ("trusted", "normal", "ignored"):
            with self.subTest(policy=policy):
                self.write_settings(
                    DORI_DISCORD_ALLOWED="11111" if policy == "trusted" else "11111,22222",
                    DORI_DISCORD_TRUSTED_CHANNELS="11111,22222" if policy == "normal" else "11111",
                    DORI_DISCORD_NORMAL_CHANNELS="22222" if policy == "ignored" else "",
                    DORI_DISCORD_IGNORED_CHANNELS="22222" if policy == "trusted" else "")
                revision = CONFIG["policy_revision"](CONFIG["load"](self.home), self.home)

                with redirect_stdout(StringIO()):
                    CONFIG["change"](self.home, "channel-" + policy, "653894110884921366", revision,
                                     "channels.set", "22222", policy)

                values = CONFIG["load"](self.home)
                self.assertEqual(values["DORI_DISCORD_ALLOWED"], "11111" if policy == "ignored" else "11111,22222")
                self.assertEqual(values["DORI_DISCORD_TRUSTED_CHANNELS"], "11111,22222" if policy == "trusted" else "11111")
                self.assertEqual(values["DORI_DISCORD_NORMAL_CHANNELS"], "22222" if policy == "normal" else "")
                self.assertEqual(values["DORI_DISCORD_IGNORED_CHANNELS"], "22222" if policy == "ignored" else "")
                self.assertEqual(CONFIG["problems"](values), [])

    def test_a_settings_file_with_the_retired_nudge_timer_still_loads_and_never_exports_it(self):
        self.write_settings()
        path = CONFIG["config_path"](self.home)
        path.write_text(path.read_text() + "HELIO_CONVERSATION_NUDGE_HOURS=24\n")
        values = CONFIG["load"](self.home)
        self.assertEqual(CONFIG["problems"](values), [])
        self.assertNotIn("HELIO_CONVERSATION_NUDGE_HOURS", CONFIG["resolve"](values, self.home))

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
