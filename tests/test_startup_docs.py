"""Managed document drift cannot prevent either lead startup mode."""
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


if __name__ == "__main__":
    unittest.main()
