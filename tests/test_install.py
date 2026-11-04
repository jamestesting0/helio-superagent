"""Offline tests of the installer's filesystem and startup prerequisites."""

from __future__ import annotations

import json
import io
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
import shlex
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "scripts/install.py"


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve() / 'home "quoted"'
        self.home.mkdir()

    def run_installer(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(INSTALLER), "--home", str(self.home), *args],
            capture_output=True, text=True, check=False,
            env={"HOME": str(self.home), "PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def test_existing_project_preserves_agents_and_uses_selected_path(self) -> None:
        project = self.home / "chosen-project"
        project.mkdir()
        (project / "AGENTS.md").write_text("existing instructions")
        result = self.run_installer("--project", str(project), "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((project / "AGENTS.md").read_text(), "existing instructions")
        config = json.loads((self.home / ".dori/elobot/config.json").read_text())
        self.assertEqual(config["defaultCwd"], str(project))
        self.assertTrue((project / ".omo/omo.jsonc").exists())

    def test_dry_run_never_creates_destination(self) -> None:
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertIn("PLAN ", result.stdout)

    def test_clean_install_is_portable_and_excludes_private_state(self) -> None:
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        elobot = self.home / ".dori/elobot"
        config = json.loads((elobot / "config.json").read_text())
        self.assertIn(f"DORI_CONFIG={elobot / 'config.json'}", config["agentCommand"])
        self.assertEqual(config["hooks"]["threadReply"][1], str(elobot / "thread-target.ts"))
        skill = elobot / "skills/karpathy-guidelines"
        self.assertIn(str(skill), config["agentCommand"])
        self.assertEqual((skill / "SKILL.md").read_bytes(),
                         (ROOT / "agent/skills/karpathy-guidelines/SKILL.md").read_bytes())
        self.assertTrue((elobot / "vendor/dori-mode/scripts/src/messenger/discord.ts").is_file())
        self.assertEqual(
            (elobot / "vendor/dori-mode/LICENSE").read_bytes(),
            (ROOT / "vendor/dori-mode/LICENSE").read_bytes(),
        )
        self.assertTrue((self.home / ".dori/discord-inbound/inbound.ts").is_file())
        for name in runpy.run_path(str(INSTALLER))["INBOUND_FILES"]:
            self.assertEqual((self.home / ".dori/discord-inbound" / name).read_bytes(),
                             (ROOT / "discord-inbound" / name).read_bytes())
        for name in ("discord-qa-workflow.md", "beta-maintenance-workflow.md", "oracle-restart-workflow.md"):
            self.assertEqual(os.readlink(elobot / name), f"docs/{name}")
            self.assertEqual((elobot / name).read_bytes(), (elobot / "docs" / name).read_bytes())
        self.assertTrue((self.home / "PythonProjects/elo-bot/AGENTS.md").is_file())
        self.assertEqual((self.home / "PythonProjects/elo-bot/.omo/omo.jsonc").read_bytes(),
                         (ROOT / "omo/omo.jsonc").read_bytes())
        self.assertFalse((elobot / "GUIDE.md").exists())
        self.assertNotIn(b"{{", (elobot / "setup-prompt.md").read_bytes() + (elobot / "work-policy.md").read_bytes())
        manifest = json.loads((elobot / ".sync-manifest.json").read_text())
        self.assertEqual(manifest["_profile"], "isolated")
        self.assertEqual(stat.S_IMODE((elobot / ".sync-manifest.json").stat().st_mode), 0o600)
        for name in ("start", "inbound", "ack", "context"):
            self.assertEqual(stat.S_IMODE((elobot / name).stat().st_mode), 0o700)
        for directory in (self.home / ".dori", elobot, elobot / "docs", elobot / "project-docs",
                          self.home / "PythonProjects/elo-bot/.omo"):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertFalse((elobot / "env").exists())
        self.assertFalse((elobot / "state").exists())
        self.assertFalse((self.home / ".dori/discord-inbound/node_modules").exists())
        self.assertEqual((elobot / "helio-sessions.py").read_bytes(),
                         (ROOT / "agent/helpers/helio-sessions.py").read_bytes())

    def test_collision_refuses_all_writes_and_preserves_existing_file(self) -> None:
        existing = self.home / "PythonProjects/elo-bot/.omo/omo.jsonc"
        existing.parent.mkdir(parents=True)
        existing.write_text("existing")
        result = self.run_installer("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(existing.read_text(), "existing")
        self.assertFalse((self.home / ".dori").exists())

    def test_existing_payload_refuses_install_without_overwriting_credentials(self) -> None:
        base = self.home / ".dori/elobot"
        base.mkdir(parents=True)
        for payload in ("helio-sessions.py", "start"):
            with self.subTest(payload=payload):
                originals = {payload: "local payload", "env": "private credentials",
                             "trusted-users": "123", "report-channels": "456", "release-approvers": "789"}
                for name, content in originals.items():
                    (base / name).write_text(content)

                result = self.run_installer("--apply")

                self.assertNotEqual(result.returncode, 0)
                self.assertIn(payload, result.stderr)
                self.assertEqual({p.name: p.read_text() for p in base.iterdir()}, originals)
                (base / payload).unlink()

    def test_installed_wrappers_load_current_policy_after_private_environment(self) -> None:
        project = self.home / "project"
        project.mkdir()
        settings = self.home / ".config/helio/helio.env"
        settings.parent.mkdir(parents=True)
        example = (ROOT / "helio.env.example").read_text()
        filled = {"DORI_DISCORD_TOKEN": "private-token", "BOT_BETA_TOKEN": "beta", "COC_API_PASSWORD": "coc",
                  "HELPER_API_KEY": "helper", "HELIO_BETA_MONGO_URL": "mongodb://beta",
                  "HELIO_PROJECT": str(project), "HELIO_TRUSTED_USERS": "11111,22222",
                  "HELIO_REPORT_CHANNELS": "33333"}
        settings.write_text("\n".join(
            f"{line.split('=', 1)[0]}={filled[line.split('=', 1)[0]]}" if line.split("=", 1)[0] in filled else line
            for line in example.splitlines()) + "\n")
        settings.chmod(0o600)
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        base = self.home / ".dori/elobot"
        self.assertEqual(json.loads((base / "config.json").read_text())["defaultCwd"], str(project))
        for name in ("env", "beta.env", "beta-mongo.env"):
            self.assertEqual(stat.S_IMODE((base / name).stat().st_mode), 0o600)
        self.assertNotIn(b"private-token", (base / "beta.env").read_bytes())
        (base / "browser-env").write_text("")
        binaries = self.home / ".bun/bin"
        binaries.mkdir(parents=True)
        # Observe the exported process boundary without launching Discord or OmO.
        probe = (
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "if Path(sys.argv[0]).name == 'python3' and sys.argv[1].endswith('knowledge-setup.py'):\n"
            "    sys.exit(0)\n"
            "if Path(sys.argv[0]).name == 'python3' and sys.argv[1].endswith('helio-sessions.py'):\n"
            "    os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n"
            "if Path(sys.argv[0]).name == 'omo':\n"
            "    if '--session-id' in sys.argv:\n"
            "        sid = sys.argv[sys.argv.index('--session-id') + 1]\n"
            "        root = Path.home() / '.omo/agent/sessions/project'\n"
            "        root.mkdir(parents=True)\n"
            "        (root / f'lead_{sid}.jsonl').write_text(json.dumps({'type': 'session', 'id': sid, 'cwd': os.environ['HELIO_PROJECT']}) + '\\n')\n"
            "    else:\n"
            "        session = Path(sys.argv[sys.argv.index('--session') + 1])\n"
            "        assert json.loads(session.read_text())['cwd'] == os.environ['HELIO_PROJECT']\n"
            "print(json.dumps({k: v for k, v in os.environ.items() if k.startswith('DORI_DISCORD_')}))\n"
        )
        for name in ("bun", "omo", "python3"):
            executable = binaries / name
            executable.write_text(probe)
            executable.chmod(0o700)
        environment = {"HOME": str(self.home), "PATH": f"{binaries}:{os.defpath}",
                       "HERDR_PANE_ID": "test-pane"}
        commands = [[str(base / name)] for name in ("inbound", "context", "ack")]
        commands += [[str(base / "start"), mode] for mode in ("start", "resume")]
        commands += [[str(ROOT / "scripts/helio-wsl"), "question", "list"]]
        (self.home / ".dori/elobot/channel-policy.env").write_text("export DORI_DISCORD_ALLOWED=retired\n")
        for command in commands:
            with self.subTest(command=command):
                result = subprocess.run(["bash", *command], capture_output=True, text=True,
                                        check=False, env=environment, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                exported = json.loads(result.stdout.splitlines()[-1])
                self.assertEqual(exported["DORI_DISCORD_ALLOWED"],
                                 "1218071208197623880,1199770187738644652,1220331873079922810,1566842840716152962")
                self.assertEqual(exported["DORI_DISCORD_TRUSTED_CHANNELS"], "1218071208197623880,1566842840716152962")
                self.assertEqual(exported["DORI_DISCORD_NORMAL_CHANNELS"],
                                 "1199770187738644652,1220331873079922810")
                self.assertEqual(exported["DORI_DISCORD_TOKEN"], "private-token")
                if Path(command[0]).name in ("inbound", "ack"):
                    self.assertEqual(exported["DORI_DISCORD_TRUSTED_IDS"], "11111,22222")
                    self.assertEqual(exported["DORI_DISCORD_REPORT_CHANNELS"], "33333")
                    self.assertEqual(exported["DORI_DISCORD_BUG_REPORT_SOURCE"],
                                     "1212767017917218876:1566842840716152962")
                if Path(command[0]).name in ("context", "ack"):
                    self.assertEqual(exported["DORI_DISCORD_CONTEXT_EXCLUDED"], "1222942524839165982")
        records = json.loads((base / "state/helio-lead-sessions.json").read_text())
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["project"], str(project))
        self.assertFalse((self.home / "helio-agent").exists())

    def test_project_path_from_helio_env_expands_home(self) -> None:
        settings = self.home / ".config/helio/helio.env"
        settings.parent.mkdir(parents=True)
        settings.write_text("HELIO_PROJECT=~/PythonProjects/elo-bot\n")
        settings.chmod(0o600)
        installer = runpy.run_path(str(INSTALLER))["install"]
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            installer(self.home, False)
        project = self.home / "PythonProjects/elo-bot"
        files = runpy.run_path(str(INSTALLER))["plan"](self.home, project, "owner")
        self.assertIn(project / ".omo/omo.jsonc", [path for path, _, _ in files])
        self.assertFalse(Path("~").exists())
        configured = runpy.run_path(str(ROOT / "scripts/helio_payload.py"))["configured_project"]
        self.assertEqual(configured(self.home, {"HELIO_PROJECT": "~/PythonProjects/elo-bot"}), str(project))

    def test_symlinked_destination_is_refused(self) -> None:
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.home / ".dori").symlink_to(outside, target_is_directory=True)
        result = self.run_installer("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_existing_runtime_state_is_untouched(self) -> None:
        state = self.home / ".dori/elobot/state"
        state.mkdir(parents=True)
        marker = state / "existing"
        marker.write_text("preserve")
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(), "preserve")
        self.assertEqual(list(state.iterdir()), [marker])

    def test_existing_dori_skill_does_not_block_install_or_change(self) -> None:
        skill = self.home / ".dori/src/skills/dori-mode"
        module = skill / "scripts/src/messenger/discord.ts"
        module.parent.mkdir(parents=True)
        module.write_text("independently installed module")
        (skill / "SKILL.md").write_text("independently installed skill")
        registration = self.home / ".agents/skills/dori-mode"
        registration.parent.mkdir(parents=True)
        registration.symlink_to(skill, target_is_directory=True)
        before = {path.relative_to(skill): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                  for path in skill.rglob("*") if path.is_file()}

        result = self.run_installer("--apply")

        self.assertEqual(result.returncode, 0, result.stderr)
        after = {path.relative_to(skill): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                 for path in skill.rglob("*") if path.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(registration.resolve(), skill)
        self.assertTrue((self.home / ".dori/elobot/reply.ts").is_file())

    def test_write_failure_reports_partial_install_and_preserves_state(self) -> None:
        state = self.home / ".dori/elobot/state"
        state.mkdir(parents=True)
        marker = state / "existing"
        marker.write_text("preserve")
        failing = self.home / ".dori/elobot/work-policy.md"
        original_open = Path.open

        def failing_open(path, *args, **kwargs):
            if path == failing and args and args[0] == "xb":
                raise PermissionError("simulated write failure")
            return original_open(path, *args, **kwargs)

        installer = runpy.run_path(str(INSTALLER))["install"]
        errors = io.StringIO()
        with patch.object(Path, "open", failing_open), redirect_stdout(io.StringIO()), redirect_stderr(errors):
            result = installer(self.home, True)

        self.assertEqual(result, 1)
        self.assertIn(str(failing), errors.getvalue())
        self.assertIn("partial", errors.getvalue().lower())
        self.assertTrue((self.home / ".dori/elobot/setup-prompt.md").is_file())
        self.assertEqual(marker.read_text(), "preserve")

    def test_knowledge_setup_uses_bundled_docs_without_original_checkout(self) -> None:
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        memory = self.home / ".omo/memory/agents/elobot-ec289b4c"
        (memory / "repo/.git").mkdir(parents=True)
        (memory / "repo/system").mkdir()
        (memory / "runtime/locks").mkdir(parents=True)
        script = self.home / ".dori/elobot/knowledge-setup.py"
        environment = {"HOME": str(self.home), "PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True,
                                check=False, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        project_doc = self.home / "PythonProjects/elo-bot/docs/README.md"
        bundled_doc = self.home / ".dori/elobot/project-docs/README.md"
        self.assertEqual(project_doc.read_bytes(), bundled_doc.read_bytes())
        project_doc.write_text("local changes")
        result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True,
                                check=False, env=environment)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(project_doc.read_text(), "local changes")


if __name__ == "__main__":
    unittest.main()
