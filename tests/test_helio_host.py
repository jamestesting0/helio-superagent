"""Exercise the host CLI with fake commands; never enter an isolated runtime."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Final
import unittest

ROOT: Final = Path(__file__).resolve().parent.parent
WRAPPER: Final = ROOT / "scripts/helio-host"
WSL: Final = "/mnt/c/Windows/System32/wsl.exe"
LAUNCH: Final = [
    WSL, "-d", "Ubuntu-22.04", "-u", "root", "--", "systemd-run",
    "--scope", "--quiet", "--unit", "helio-isolated", "/usr/bin/python3",
    "/opt/helio-beta-service/scripts/helio_isolated_launcher.py",
]

# Sourcing preserves Bash's real argument dispatch while intercepting even the
# absolute WSL exec. Nothing outside this temporary fixture can be executed.
HARNESS: Final = r"""
systemctl() {
  printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
  [[ "${3:-}" == "$ACTIVE_SERVICE" ]]
}
python3() {
  [[ "${1:-}" == "$FAKE_UPDATER" ]] || return 97
  "$TEST_PYTHON" "$@"
}
exec() {
  printf '%s\0' "$@" >> "$EXEC_LOG"
  case "$1" in
    python3)
      [[ "${2:-}" == "$FAKE_UPDATER" ]] || exit 97
      shift
      "$TEST_PYTHON" "$@"
      exit $? ;;
    /mnt/c/Windows/System32/wsl.exe) exit "$LAUNCH_EXIT" ;;
    *) exit 97 ;;
  esac
}
wrapper=$1
shift
source "$wrapper" "$@"
"""

FAKE_UPDATER: Final = """\
import argparse
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--home", type=Path, required=True)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
(args.home / "updater-args.json").write_text(json.dumps(sys.argv[1:]))
if (args.home / "conflict").exists():
    print("Local changes need review; nothing updated: work-policy.md, setup-prompt.md")
    sys.exit(1)
if args.apply:
    (args.home / "applied").write_text("managed update")
else:
    print("Managed updates: preview")
"""

ADMIN: Final = [
    WSL, "-d", "Ubuntu-22.04", "-u", "root", "--", "/usr/bin/python3",
    "/opt/helio-beta-service/scripts/helio_isolated_admin.py",
]


class HelioHostTests(unittest.TestCase):
    def test_doctor_forwards_only_read_only_json_option_without_launching(self):
        for args in (("doctor",), ("doctor", "--json")):
            with self.subTest(args=args):
                self.reset_logs()
                result = self.run_host(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.exec_args(), [*ADMIN, *args])
                self.assertFalse(self.systemctl_log.exists())
        result = self.run_host("doctor", "--fix")
        self.assertEqual(result.returncode, 2)

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / "owner home"
        self.home.mkdir()
        self.updater = self.home / "PythonProjects/helio-superagent/scripts/sync-install.py"
        self.updater.parent.mkdir(parents=True)
        self.updater.write_text(FAKE_UPDATER)
        self.exec_log = self.base / "exec-log"
        self.systemctl_log = self.base / "systemctl-log"
        self.empty_path = self.base / "empty-bin"
        self.empty_path.mkdir()

    def run_host(
        self, *args: str, active: str = "", launch_exit: int = 0,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/bash", "--noprofile", "--norc", "-c", HARNESS,
             "helio-host-test", str(WRAPPER), *args],
            cwd=self.base,
            env={
                "HOME": str(self.home),
                "PATH": str(self.empty_path),
                "PYTHONDONTWRITEBYTECODE": "1",
                "TEST_PYTHON": sys.executable,
                "FAKE_UPDATER": str(self.updater),
                "EXEC_LOG": str(self.exec_log),
                "SYSTEMCTL_LOG": str(self.systemctl_log),
                "ACTIVE_SERVICE": active,
                "LAUNCH_EXIT": str(launch_exit),
            },
            capture_output=True, text=True, timeout=5, check=False,
        )

    def exec_args(self) -> list[str]:
        if not self.exec_log.exists():
            return []
        return self.exec_log.read_text().rstrip("\0").split("\0")

    def reset_logs(self) -> None:
        self.exec_log.unlink(missing_ok=True)
        self.systemctl_log.unlink(missing_ok=True)

    def test_update_applies_to_owner_without_launching_or_replacing_launcher(self) -> None:
        result = self.run_host("update", active="helio-isolated.scope")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / "applied").read_text(), "managed update")
        self.assertEqual(
            json.loads((self.home / "updater-args.json").read_text()),
            ["--home", str(self.home), "--apply"],
        )
        self.assertEqual(self.exec_args()[0:2], ["python3", str(self.updater)])
        self.assertFalse(self.systemctl_log.exists())

    def test_preview_invokes_updater_without_applying(self) -> None:
        result = self.run_host("update", "--preview")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / "updater-args.json").exists())
        self.assertFalse((self.home / "applied").exists())
        self.assertFalse(self.systemctl_log.exists())

    def test_conflicts_propagate_without_adoption_retry_or_prompt_changes(self) -> None:
        (self.home / "conflict").touch()
        prompts = self.home / ".dori/elobot"
        prompts.mkdir(parents=True)
        for name in ("work-policy.md", "setup-prompt.md"):
            (prompts / name).write_text("intentional owner policy")

        result = self.run_host("update")

        self.assertEqual(result.returncode, 1)
        self.assertIn("work-policy.md", result.stdout)
        self.assertIn("setup-prompt.md", result.stdout)
        self.assertEqual(
            self.exec_args(),
            ["python3", str(self.updater), "--home", str(self.home), "--apply"],
        )
        self.assertFalse((self.home / "applied").exists())
        for name in ("work-policy.md", "setup-prompt.md"):
            self.assertEqual((prompts / name).read_text(), "intentional owner policy")

    def test_missing_checkout_fails_without_launching(self) -> None:
        self.updater.unlink()

        result = self.run_host("update")

        self.assertEqual(result.returncode, 1)
        self.assertIn(str(self.updater), result.stderr)
        self.assertEqual(self.exec_args(), [])
        self.assertFalse(self.systemctl_log.exists())

    def test_update_rejects_adoption_launcher_and_arbitrary_updater_options(self) -> None:
        for options in (
            ("--adopt",), ("--update-launcher",), ("--apply",),
            ("--home", "/another/home"), ("--preview", "--adopt"),
            ("--preview", "extra"),
        ):
            with self.subTest(options=options):
                result = self.run_host("update", *options)

                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.exec_args(), [])
                self.assertFalse((self.home / "updater-args.json").exists())

    def test_launch_modes_preserve_wsl_command_and_exit_status(self) -> None:
        for args, suffix in (
            ((), []), (("start",), ["--start"]),
            (("resume",), ["--resume"]), (("--check",), ["--check"]),
        ):
            with self.subTest(args=args):
                self.reset_logs()
                result = self.run_host(*args, launch_exit=23)

                self.assertEqual(result.returncode, 23, result.stderr)
                self.assertEqual(self.exec_args(), LAUNCH + suffix)
                self.assertEqual(
                    self.systemctl_log.read_text().splitlines(),
                    ["is-active --quiet helio-isolated.scope"],
                )

    def test_running_scope_blocks_every_launch_mode(self) -> None:
        for args in ((), ("start",), ("resume",), ("--check",)):
            with self.subTest(args=args):
                self.reset_logs()
                result = self.run_host(*args, active="helio-isolated.scope")

                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.exec_args(), [])
                self.assertFalse((self.home / "updater-args.json").exists())

    def test_status_reports_each_service_without_launching(self) -> None:
        for active in (
            "", "helio-isolated.scope", "helio-beta-maintenance.service",
            "helio-release.service",
        ):
            with self.subTest(active=active):
                self.reset_logs()
                result = self.run_host("status", active=active)

                self.assertEqual(result.returncode, 0)
                states = [line.rsplit(": ", 1)[1] for line in result.stdout.splitlines()]
                self.assertEqual(states, [
                    "running" if service == active else "stopped"
                    for service in (
                        "helio-isolated.scope", "helio-beta-maintenance.service",
                        "helio-release.service",
                    )
                ])
                self.assertEqual(len(self.systemctl_log.read_text().splitlines()), 3)
                self.assertEqual(self.exec_args(), [])

    def test_permissions_uses_owner_home_without_commands(self) -> None:
        result = self.run_host("permissions")

        self.assertEqual(result.returncode, 0)
        self.assertIn(str(self.home / ".config/helio/helio.env"), result.stdout)
        self.assertIn("HELIO_TRUSTED_USERS", result.stdout)
        self.assertEqual(self.exec_args(), [])
        self.assertFalse(self.systemctl_log.exists())

    def test_deploy_updates_owner_home_then_the_isolated_runtime(self) -> None:
        for args, admin in ((("deploy",), ["deploy"]), (("deploy", "--restart"), ["deploy", "--restart"])):
            with self.subTest(args=args):
                self.reset_logs()
                result = self.run_host(*args, active="helio-isolated.scope")

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.home / "applied").read_text(), "managed update")
                self.assertEqual(self.exec_args(), ADMIN + admin)

    def test_deploy_stops_when_the_owner_update_needs_review(self) -> None:
        (self.home / "conflict").write_text("")
        result = self.run_host("deploy")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.exec_args(), [])

    def test_restart_and_version_use_the_root_admin_tool(self) -> None:
        for command, admin in (("restart", ["restart"]), ("version", ["status"])):
            with self.subTest(command=command):
                self.reset_logs()
                result = self.run_host(command, active="helio-isolated.scope")

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.exec_args(), ADMIN + admin)
                self.assertFalse(self.systemctl_log.exists())

    def test_unknown_commands_and_extra_launch_arguments_are_rejected(self) -> None:
        for args in (
            ("doctor", "--fix"), ("beta",), ("browser",), ("release",), ("bogus",),
            ("start", "extra"), ("status", "extra"), ("permissions", "extra"),
            ("deploy", "--force"), ("restart", "now"), ("version", "extra"),
        ):
            with self.subTest(args=args):
                result = self.run_host(*args)

                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.exec_args(), [])
                self.assertFalse(self.systemctl_log.exists())


if __name__ == "__main__":
    unittest.main()
