"""Managed document drift cannot prevent either lead startup mode."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class StartupDocsTests(unittest.TestCase):
    def test_start_and_resume_report_drift_without_reconciling_docs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / ".dori/elobot"
            base.mkdir(parents=True)
            project = home / "project"
            (project / ".omo").mkdir(parents=True)
            (project / ".omo/omo.jsonc").write_text(json.dumps({
                "memory": {"enabled": True, "agent": "EloBot", "sync": {"enabled": False}},
            }))
            (project / "docs").mkdir()
            (project / "docs/local.md").write_text("local edits")
            (base / "project-docs").mkdir()
            (base / "project-docs/local.md").write_text("managed version")
            (base / "project-docs/missing.md").write_text("install later")
            memory = home / ".omo/memory/agents/elobot-ec289b4c"
            for path in ("repo/.git", "repo/system", "runtime/locks"):
                (memory / path).mkdir(parents=True)
            for name in ("setup-prompt.md", "work-policy.md", "skills/karpathy-guidelines/SKILL.md"):
                path = base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("instructions")
            shutil.copyfile(ROOT / "agent/bin/start", base / "start")
            shutil.copyfile(ROOT / "agent/helpers/knowledge-setup.py", base / "knowledge-setup.py")
            shutil.copyfile(ROOT / "agent/helpers/helio-sessions.py", base / "helio-sessions.py")
            shutil.copyfile(ROOT / "agent/helpers/monitor-specs.py", base / "monitor-specs.py")
            (base / "docs").mkdir()
            shutil.copyfile(ROOT / "agent/runbooks/monitor-events.md", base / "docs/monitor-events.md")
            (base / "env").write_text(
                f"export HELIO_PROJECT='{project}'\nexport DORI_STATE_DIR='{base / 'state'}'\n"
                "export DORI_DISCORD_TOKEN=test DORI_DISCORD_OWNER_ID=1 DORI_DISCORD_ALLOWED=1\n"
                "export HELIO_LEAD_MODEL=test HELIO_LEAD_THINKING=low HELIO_MODEL_ALLOW=test HELIO_BROWSER_SKILL=test\n"
            )
            (base / "browser-env").write_text("")
            binaries = home / "bin"
            binaries.mkdir()
            (binaries / "python3").symlink_to(sys.executable)
            (binaries / "bun").write_text("#!/bin/sh\nexit 0\n")
            (binaries / "bun").chmod(0o700)
            (binaries / "omo").write_text(
                f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n"
                "if '--session-id' in sys.argv:\n"
                "    sid = sys.argv[sys.argv.index('--session-id') + 1]\n"
                "    root = Path.home() / '.omo/agent/sessions/project'\n"
                "    root.mkdir(parents=True)\n"
                "    (root / f'lead_{sid}.jsonl').write_text(json.dumps({'type': 'session', 'id': sid, 'cwd': os.environ['HELIO_PROJECT']}) + '\\n')\n"
                "print(json.dumps(sys.argv))\n"
            )
            (binaries / "omo").chmod(0o700)
            environment = {**os.environ, "HOME": str(home), "PATH": f"{binaries}:{os.defpath}",
                           "HERDR_PANE_ID": "test-pane"}
            environment.pop("OMO_MEMORY_HOME", None)
            for mode in ("start", "resume"):
                with self.subTest(mode=mode):
                    result = subprocess.run(["bash", str(base / "start"), mode], env=environment,
                                            capture_output=True, text=True, timeout=10, check=False)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    argv = json.loads(result.stdout.splitlines()[-1])
                    self.assertIn("KNOWLEDGE_DOC_DRIFT count=2", argv[-1])
                    self.assertNotIn("KNOWLEDGE_MEMORY", argv[-1])
                    self.assertIn("greeting", argv[-1])
                    self.assertEqual((project / "docs/local.md").read_text(), "local edits")
                    self.assertFalse((project / "docs/missing.md").exists())
                    for line in subprocess.run([sys.executable, str(base / "monitor-specs.py"), str(base / "docs/monitor-events.md")],
                                               capture_output=True, text=True, check=True).stdout.splitlines():
                        self.assertIn(line, argv[-1])
            runbook = base / "docs/monitor-events.md"
            runbook.write_text(runbook.read_text().replace('"command": "dori guard --loop 1"', '"command": "dori watch"'))
            result = subprocess.run(["bash", str(base / "start"), "start"], env=environment,
                                    capture_output=True, text=True, timeout=10, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("omo", result.stdout)
            self.assertIn("monitor specifications unreadable", result.stderr)


class MonitorSpecTests(unittest.TestCase):
    def test_the_installed_runbook_yields_eight_valid_monitor_specifications_for_startup(self):
        result = subprocess.run([sys.executable, str(ROOT / "agent/helpers/monitor-specs.py"),
                                 str(ROOT / "agent/runbooks/monitor-events.md")], capture_output=True, text=True, check=True)
        specs = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(specs), 8)
        self.assertEqual({spec["command"].split()[0] for spec in specs},
                         {"~/.dori/elobot/inbound", "~/.dori/elobot/context", "helio", "dori"})

    def test_duplicate_incomplete_or_mistyped_specifications_are_refused(self):
        good = (ROOT / "agent/runbooks/monitor-events.md").read_text()
        guard = '"command": "dori guard --loop 1"'
        damaged = {
            "duplicate monitor": good.replace('"description": "guard"', '"description": "lanes"'),
            "duplicate command": good.replace(guard, '"command": "dori watch"'),
            "empty command": good.replace(guard, '"command": " "'),
            "missing monitor": good.replace(good[good.index('{"description": "guard"'):good.index('{"description": "freshness"')], ""),
            "unanchored filter": good.replace('"filter": "^(HOST_GUARD', '"filter": "(HOST_GUARD'),
            "not persistent": good.replace(guard + ', "filter": "^(HOST_GUARD|GUARD_ERROR)", "persistent": true',
                                           guard + ', "filter": "^(HOST_GUARD|GUARD_ERROR)", "persistent": false'),
            "unknown field": good.replace(guard, guard + ', "cwd": "/"'),
            "text wake rate": good.replace('"wakes_per_hour": 3600}', '"wakes_per_hour": "3600"}', 1),
        }
        with tempfile.TemporaryDirectory() as temporary:
            for name, text in damaged.items():
                with self.subTest(name=name):
                    self.assertNotEqual(text, good)
                    runbook = Path(temporary, "monitor-events.md")
                    runbook.write_text(text)
                    result = subprocess.run([sys.executable, str(ROOT / "agent/helpers/monitor-specs.py"), str(runbook)],
                                            capture_output=True, text=True)
                    self.assertEqual((result.returncode, result.stdout), (2, ""))


if __name__ == "__main__":
    unittest.main()
