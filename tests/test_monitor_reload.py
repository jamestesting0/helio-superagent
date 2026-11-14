import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import os
import selectors
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FAKE_BUN = """#!{python}
import os, signal, sys
from pathlib import Path
code = Path(sys.argv[1]).read_text().strip()
def stop(signum, frame):
    print('STOP ' + str(os.getpid()), flush=True)
    sys.exit(0)
def fail(signum, frame):
    sys.exit(1)
signal.signal(signal.SIGUSR1, fail)
if code == 'stubborn':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    signal.signal(signal.SIGTERM, stop)
print('START ' + code + ' ' + str(os.getpid()), flush=True)
if code == 'exit2':
    sys.exit(2)
if code == 'error':
    Path(sys.argv[1]).write_text('stable')
    sys.exit(1)
while True:
    signal.pause()
"""


class MonitorReloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.stamp = self.home / ".dori/elobot/monitors-version"
        self.stamp.parent.mkdir(parents=True)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "DORI_STATE_DIR": str(self.home / "state"),
            "HELIO_STAMP_CHECK_SECONDS": "0.05",
        }

    def executable(self, name: str, source: str) -> None:
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def wrapper(self, name: str, code: str = "old") -> tuple[list[str], Path]:
        shutil.copyfile(ROOT / "agent/bin" / name, self.bin / name)
        (self.bin / "env").write_text(
            "\n".join(f"export {key}=test" for key in (
                "DORI_DISCORD_TOKEN", "DORI_DISCORD_ALLOWED",
                "DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS",
                "DORI_DISCORD_BUG_REPORT_SOURCE", "DORI_DISCORD_CONTEXT",
                "DORI_DISCORD_CONTEXT_EXCLUDED",
            ))
        )
        for filename in ("trusted-users", "report-channels"):
            (self.bin / filename).write_text("123\n")
        self.executable("bun", FAKE_BUN.format(python=sys.executable))
        script = self.home / ".dori/discord-inbound" / f"{name}.ts"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(code)
        return ["bash", str(self.bin / name), *(["--loop"] if name == "context" else [])], script

    def launch(self, argv: list[str]) -> subprocess.Popen:
        process = subprocess.Popen(
            argv, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True,
        )
        self.addCleanup(self.stop, process)
        return process

    def stop(self, process: subprocess.Popen) -> None:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=2)

    def line(self, process: subprocess.Popen, timeout: float = 3) -> str:
        # Read unbuffered bytes so readiness cannot hide behind a TextIO buffer.
        deadline = time.monotonic() + timeout
        result = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                self.assertTrue(selector.select(max(0, deadline - time.monotonic())),
                                f"timed out waiting for output: {result!r}")
                char = os.read(process.stdout.fileno(), 1)
                self.assertTrue(char, f"monitor exited with {process.poll()}: {result!r}")
                if char == b"\n":
                    return result.decode()
                result.extend(char)

    def quiet(self, process: subprocess.Popen) -> None:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if selector.select(0.2):
                self.fail("unexpected restart or warning: " + self.line(process))
        self.assertIsNone(process.poll(), "persistent monitor exited")

    def test_wrappers_reload_new_code_once_and_keep_the_supervisor(self) -> None:
        for name in ("inbound", "context"):
            with self.subTest(wrapper=name):
                argv, script = self.wrapper(name)
                self.stamp.unlink(missing_ok=True)
                process = self.launch(argv)
                start = self.line(process).split()
                self.assertEqual(start[:2], ["START", "old"])
                self.quiet(process)  # Missing stamp remains unchanged.
                script.write_text("new")
                self.stamp.write_text("b5dd1d4 2026-11-03T15:00:00Z\n")
                self.assertEqual(self.line(process),
                                 f"{name.upper()}_WARN updated to b5dd1d4; restarting to load it")
                self.assertEqual(self.line(process), f"STOP {start[2]}")
                restarted = self.line(process).split()
                self.assertEqual(restarted[:2], ["START", "new"])
                self.assertNotEqual(start[2], restarted[2])
                self.stamp.write_text("")
                self.quiet(process)  # An incomplete write is not a new deployed version.
                self.stamp.write_text("b5dd1d4 2026-11-03T15:00:00Z\n")
                self.quiet(process)  # Rewriting equal content must not restart.
                process.send_signal(signal.SIGTERM)
                self.assertEqual(self.line(process), f"STOP {restarted[2]}")
                self.assertEqual(process.wait(timeout=2), 143)

    def test_wrappers_preserve_exit_two_without_waiting_for_stamp_check(self) -> None:
        self.env["HELIO_STAMP_CHECK_SECONDS"] = "30"
        for name in ("inbound", "context"):
            with self.subTest(wrapper=name):
                argv, _ = self.wrapper(name, "exit2")
                process = self.launch(argv)
                output, _ = process.communicate(timeout=2)
                self.assertEqual(process.returncode, 2)
                self.assertEqual(len(output.splitlines()), 1)
                self.assertTrue(output.startswith(b"START exit2 "))

    def test_wrappers_back_off_runtime_errors_and_reset_delay_on_update(self) -> None:
        # Compress retry delays without altering the wrapper's delay calculation.
        self.executable("sleep", '#!/bin/sh\ncase "$1" in\n'
                        '5|10|20|40|80|160|300) exec /bin/sleep 0.05 ;;\n'
                        '*) exec /bin/sleep "$@" ;;\nesac\n')
        for name in ("inbound", "context"):
            with self.subTest(wrapper=name):
                self.stamp.unlink(missing_ok=True)
                argv, script = self.wrapper(name, "error")
                process = self.launch(argv)
                self.assertTrue(self.line(process).startswith("START error "))
                suffix = " and catching up from the saved cursor" if name == "inbound" else ""
                self.assertEqual(self.line(process),
                                 f"{name.upper()}_WARN {name} stopped after a runtime error; restarting in 5s{suffix}")
                stable = self.line(process).split()
                self.assertEqual(stable[:2], ["START", "stable"])
                os.kill(int(stable[2]), signal.SIGUSR1)
                self.assertEqual(self.line(process),
                                 f"{name.upper()}_WARN {name} stopped after a runtime error; restarting in 10s{suffix}")
                stable = self.line(process).split()
                self.assertEqual(stable[:2], ["START", "stable"])
                script.write_text("new")
                self.stamp.write_text("reset timestamp\n")
                self.assertEqual(self.line(process),
                                 f"{name.upper()}_WARN updated to reset; restarting to load it")
                self.assertEqual(self.line(process), f"STOP {stable[2]}")
                fresh = self.line(process).split()
                self.assertEqual(fresh[:2], ["START", "new"])
                os.kill(int(fresh[2]), signal.SIGUSR1)
                self.assertEqual(self.line(process),
                                 f"{name.upper()}_WARN {name} stopped after a runtime error; restarting in 5s{suffix}")
                self.stop(process)

    def test_wrappers_kill_children_that_ignore_term_after_grace_period(self) -> None:
        self.env["HELIO_STOP_GRACE_SECONDS"] = "1"
        for name in ("inbound", "context"):
            with self.subTest(wrapper=name):
                argv, script = self.wrapper(name, "stubborn")
                self.stamp.unlink(missing_ok=True)
                process = self.launch(argv)
                pid = int(self.line(process).split()[2])
                script.write_text("new")
                self.stamp.write_text("next timestamp\n")
                self.assertEqual(self.line(process),
                                 f"{name.upper()}_WARN updated to next; restarting to load it")
                # Bash may report its killed background job on stderr.
                line = self.line(process, timeout=4)
                if not line.startswith("START "):
                    self.assertIn("Killed", line)
                    line = self.line(process)
                self.assertTrue(line.startswith("START new "), line)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
                self.stop(process)

    def test_context_one_shot_still_exits_without_supervision(self) -> None:
        argv, _ = self.wrapper("context", "error")
        process = self.launch(argv[:-1])
        output, _ = process.communicate(timeout=2)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(len(output.splitlines()), 1)

    def test_zero_check_interval_is_rejected_instead_of_busy_looping(self) -> None:
        self.env["HELIO_STAMP_CHECK_SECONDS"] = "0"
        for name in ("inbound", "context"):
            with self.subTest(wrapper=name):
                argv, _ = self.wrapper(name)
                process = self.launch(argv)
                output, _ = process.communicate(timeout=2)
                self.assertEqual(process.returncode, 2)
                self.assertEqual(output.decode().strip(),
                                 "HELIO_STAMP_CHECK_SECONDS must be positive")

    def test_python_watchers_reexec_new_source_once_with_same_pid_and_arguments(self) -> None:
        for name, prefix in (("followups", "FOLLOWUP"), ("questions", "QUESTION")):
            with self.subTest(watcher=name):
                self.stamp.unlink(missing_ok=True)
                source = (ROOT / "scripts" / f"helio-{name}.py").read_text()
                # A marker in the copied source proves exec loads fresh Python code.
                marker = '\nprint("START old " + str(os.getpid()), flush=True)\n'
                source = source.replace("from pathlib import Path", "from pathlib import Path" + marker)
                helpers = self.home / "scripts"
                helpers.mkdir(exist_ok=True)
                script = helpers / f"helio-{name}.py"
                script.write_text(source)
                (helpers / "helio_discord_text.py").write_text((ROOT / "scripts/helio_discord_text.py").read_text())
                if name == "followups":
                    for helper in ("helio_observations.py", "helio_decision_upkeep.py", "helio_decisions.py", "helio_issue_sync.py", "helio-issue.py", "helio_issues.py", "helio-plan.py", "helio-work.py", "helio_issue_link.py", "helio_housekeeping.py", "helio_retention.py", "helio_state_backup.py", "helio_pr_readiness.py", "helio_issue_followup.py", "helio_github_posts.py", "helio_github_body.py", "helio_issue_format.py", "helio_pr_publication.py", "helio_pr_authority.py", "helio_pr_finalize.py",
                                   "helio_task_lane.py", "helio_regression_proof.py", "helio_cli.py"):
                        (helpers / helper).write_text((ROOT / "scripts" / helper).read_text())
                    for helper in ("helio_followup_delivery.py", "helio_plan_publication.py",
                                   "helio_plan_request_cli.py", "helio_plan_requests.py", "helio_approval.py",
                                   "helio_plan_source.py", "helio_runtime_policy.py",
                                   "helio_pr_verification.py", "helio_pr_recovery_store.py", "helio_pr_recovery_ci.py",
                                   "helio_pr_phase.py", "helio_pr_recovery_actions.py", "helio_pr_recovery.py",
                                   "helio_pr_recovery_cli.py", "helio_pr_escalation.py", "helio_health.py", "helio_doctor.py", "helio_merge_train.py"):
                        (helpers / helper).write_text((ROOT / "scripts" / helper).read_text())
                    for relative in ("delivery/plan-requests.sql",):
                        destination = self.home / "discord-inbound" / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(ROOT / "discord-inbound" / relative, destination)
                    self.executable("dori", "#!/bin/sh\necho '[]'\n")
                argv = [sys.executable, str(script)]
                if name == "followups":
                    self.executable("gh", '#!/bin/sh\ncase "$*" in\n*--slurp*|*"pr list"*|*"issue list"*) echo \'[]\';;\n*"api user"*) echo helio-bot;;\n*"api -i"*) printf \'HTTP/2.0 200 OK\\r\\n\\r\\n{"permissions":{"push":true}}\\n\';;\n*) echo \'{"state":"CLOSED","stateReason":"COMPLETED"}\';;\nesac\n')
                    # One open topic subscription, created through the real conversation schema.
                    subprocess.run(["bun", str(ROOT / "discord-inbound/conversation.ts"), "migrate"],
                                   env=self.env, capture_output=True, check=True, timeout=60)
                    with sqlite3.connect(self.home / "state/discord-conversations.sqlite") as db:
                        db.execute("""INSERT INTO conversations(channel_id,user_id,opened_at,last_activity,anchor_message_id,topic,status)
                            VALUES('100','7',1,1,'9','report','open')""")
                        db.execute("INSERT INTO topic_participants VALUES('9','7',0,'opened','100','9',1)")
                        db.execute("INSERT INTO followups(repo,issue,anchor_message_id,kind,created_at) VALUES('jamestesting0/elo-bot',1,'9','bug',0)")
                    argv.extend(["watch", "--interval", "1800"])
                else:
                    (helpers / "helio_runtime_policy.py").write_text((ROOT / "scripts/helio_runtime_policy.py").read_text())
                    argv.extend(["watch", "--lane", "lane-one"])
                process = self.launch(argv)
                self.assertEqual(self.line(process), f"START old {process.pid}")
                ready = self.line(process)
                self.assertTrue(ready.startswith(f"{prefix}_DONE " if name == "followups" else "QUESTION_READY "))
                self.quiet(process)
                script.write_text(source.replace('print("START old ', 'print("START new '))
                self.stamp.write_text("fresh 2026-11-03T15:00:00Z\n")
                self.assertEqual(self.line(process),
                                 f"{prefix}_WARN updated to fresh; restarting to load it")
                self.assertEqual(self.line(process), f"START new {process.pid}")
                self.assertEqual(self.line(process), 'FOLLOWUP_PENDING count=1 read="helio followups list"' if name == "followups" else ready)
                self.stamp.write_text("")
                self.quiet(process)
                self.stamp.write_text("fresh 2026-11-03T15:00:00Z\n")
                self.quiet(process)
                self.stop(process)


if __name__ == "__main__":
    unittest.main()
