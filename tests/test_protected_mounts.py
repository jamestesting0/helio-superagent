"""Inside the sandbox Helio's code and installed files are read-only; its state and backups stay writable."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import ast
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
PROBE = r"""
set -u
try() { if ( eval "$1" ) 2>/dev/null; then echo "ALLOWED $2"; else echo "REFUSED $2"; fi; }
try 'echo x > /home/james/helio-agent/scripts/new.py' kit-create
try 'echo x >> /home/james/helio-agent/scripts/helio_pr_phase.py' kit-edit
try 'mv /home/james/helio-agent/scripts/helio_pr_phase.py /home/james/helio-agent/scripts/moved.py' kit-rename
try 'echo "{}" > /home/james/.dori/elobot/config.json' config-replace
try 'echo x > /home/james/.dori/elobot/start' installed-edit
try 'echo x > /home/james/.dori/discord-inbound/inbound.ts' intake-edit
try 'echo pane > /home/james/.dori/elobot/state/lead-pane' state-write
try 'mkdir -p /home/james/.dori/elobot/backups/t && echo x > /home/james/.dori/elobot/backups/t/a' backup-write
try 'echo x > /home/james/other.txt' home-write
"""


def protected_mounts():
    tree = ast.parse((ROOT / "scripts/helio_isolated_launcher.py").read_text())
    node = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == "protected_mounts")
    scope: dict = {}
    exec(compile(ast.Module(body=[node], type_ignores=[]), "launcher", "exec"), scope)
    return scope["protected_mounts"]


@unittest.skipUnless(shutil.which("bwrap"), "bubblewrap is required")
class ProtectedMountTests(unittest.TestCase):
    def test_code_and_installed_files_are_read_only_while_state_and_backups_are_writable(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp, "home")
            for rel in ("helio-agent/scripts/helio_pr_phase.py", ".dori/elobot/config.json", ".dori/elobot/start",
                        ".dori/discord-inbound/inbound.ts", ".dori/elobot/state/.keep", ".dori/elobot/backups/.keep"):
                (home / rel).parent.mkdir(parents=True, exist_ok=True)
                (home / rel).write_text("original\n")
            result = subprocess.run(["bwrap", "--unshare-user", "--die-with-parent", "--ro-bind", "/", "/",
                                     "--dev", "/dev", "--tmpfs", "/home", *protected_mounts()(str(home)),
                                     "--", "/bin/bash", "-c", PROBE], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            outcome = dict(reversed(line.split()) for line in result.stdout.splitlines())
            self.assertEqual(outcome, {
                "kit-create": "REFUSED", "kit-edit": "REFUSED", "kit-rename": "REFUSED", "config-replace": "REFUSED",
                "installed-edit": "REFUSED", "intake-edit": "REFUSED",
                "state-write": "ALLOWED", "backup-write": "ALLOWED", "home-write": "ALLOWED"})
            self.assertEqual((home / "helio-agent/scripts/helio_pr_phase.py").read_text(), "original\n")
            self.assertEqual((home / ".dori/elobot/state/lead-pane").read_text(), "pane\n")


if __name__ == "__main__":
    unittest.main()
