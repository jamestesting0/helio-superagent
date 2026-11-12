"""Issue-lane lifecycle through the real commands: issue update, autofix submit, pr wait, the controller, and the
blocker record/clear/resume cycle."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import socket
import socketserver
import subprocess
import threading
import unittest
from unittest.mock import patch

import pr_custody_fixture as fixture

ROOT = Path(__file__).resolve().parent.parent
S, P = fixture.S, fixture.P
REFUSED = P["S"]["Refused"]
FORMAT = runpy.run_path(str(ROOT / "scripts/helio_issue_format.py"))
DIGEST = fixture.publication.M["digest"]
OWNER = "100000000000000001"


class GitHub:
    def __init__(self, run):
        self.repo, self.run = "o/r", run

    def issue(self, number: int) -> dict:
        return json.loads(self.run(["gh", "issue", "view", str(number), "--repo", self.repo, "--json",
                                    "state,title,body,comments,labels"]))


class LifecycleCase(unittest.TestCase):
    def setUp(self):
        self.custody = fixture.Custody(self, handed_off=False)
        environment = patch.dict(os.environ, {"DORI_STATE_DIR": str(self.custody.store.state), "HELIO_GITHUB_REPO": "o/r",
                                              "DORI_DISCORD_OWNER_ID": OWNER})
        environment.start()
        self.addCleanup(environment.stop)
        self.plan = runpy.run_path(str(ROOT / "scripts/helio-plan.py"))

    def helio(self, *argv: str, discord=None) -> tuple[int, str]:
        output = io.StringIO()
        extra = {"discord": discord} if discord else {}
        with contextlib.redirect_stdout(output):
            code = self.plan["main"](list(argv), gh=GitHub(self.custody.run), **extra)
        return code, output.getvalue().strip()

    def wait(self):
        return S["load"](self.custody.store, 7)

    def issue_command(self, *argv: str) -> tuple[int, str]:
        """`helio issue ...` through its main(), against this world's GitHub."""
        cli = runpy.run_path(str(ROOT / "scripts/helio-issue.py"))
        issues = {**cli["ISSUES"], "Issues": lambda *_: self.custody.store}
        output = io.StringIO()
        with patch.dict(cli["main"].__globals__, {"ISSUES": issues}), patch("sys.argv", ["helio-issue.py", *argv]), \
                contextlib.redirect_stdout(output):
            code = cli["main"]()
        return code, output.getvalue().strip()

    def edit_issue(self, requirements: str, note: str, *source: str) -> None:
        """What the lead runs after an answered question changes the requirements."""
        files = self.custody.store.state.parent
        (files / "body.md").write_text(requirements)
        (files / "note.md").write_text(note)
        code, line = self.issue_command("update", "--issue", "7", "--body-file", str(files / "body.md"),
                                        "--note-file", str(files / "note.md"),
                                        "--adopt", DIGEST(self.custody.store.get(7)["body"]), *source)
        self.assertEqual((code, line.split()[0]), (0, "ISSUE_UPDATED"))

    def hand_off(self, verification: str, generation: int = 1) -> tuple[int, str]:
        return self.helio("pr", "wait", "--issue", "7", "--generation", str(generation), "--verification", verification)

    def native_dori(self, idle_session: bool = False) -> list[list[str]]:
        """Route the controller's Dori calls to the real Dori CLI. The fake herdr shows the worker pane w1:p2 while it
        is open; with `idle_session`, omo's control endpoint reports that pane's session idle, which Dori requires
        before it releases a worker. No worker slot is free, so a wake is queued."""
        state = self.custody.store.state
        herdr = state / "herdr"
        herdr.mkdir(exist_ok=True)
        (herdr / "herdr").write_text(f"""#!/bin/sh
d={herdr}
case "$1 $2" in
  "pane list") if [ -f $d/open ] && [ ! -f $d/closed ]; then
      printf '{{"result":{{"panes":[{{"pane_id":"w1:p2","workspace_id":"w1","agent":"pi","agent_status":"idle"}}]}}}}'
    else printf '{{"result":{{"panes":[]}}}}'; fi ;;
  "pane process-info") cat $d/process.json ;;
  "pane close"|"tab close") touch $d/closed ;;
esac
""")
        (herdr / "herdr").chmod(0o755)
        agent = state / "agent"
        environment = {**os.environ, "PATH": f"{herdr}:{os.environ['PATH']}", "PI_CODING_AGENT_DIR": str(agent)}
        if idle_session:
            (herdr / "open").touch()
            self.serve_idle_session(agent, herdr)
        config = json.loads(self.custody.config.read_text())
        self.custody.config.write_text(json.dumps({**config, "maxWorkers": 0, "stateDir": str(state)}))
        calls: list[list[str]] = []

        def run(argv: list[str]) -> str:
            if argv[0] != "dori":
                return self.custody.run(argv)
            calls.append(argv)
            result = subprocess.run(["bun", str(ROOT / "vendor/dori-mode/scripts/src/cli.ts"), *argv[1:]],
                                    capture_output=True, text=True, env=environment, timeout=60)
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
            return result.stdout
        self.dori = run
        return calls

    def serve_idle_session(self, agent: Path, herdr: Path) -> None:
        """omo's host record and control socket for the worker's session, answering get_state as idle."""
        secret, pid, session = bytes([7]) * 32, 4242, self.custody.session
        address = str(agent / "control.sock")
        host = agent / "rpc-host-daemon" / "0123456789abcdef"
        (host / "generations" / session).mkdir(parents=True)
        (host / "endpoint.json").write_text(json.dumps({"socket": address, "endpoint_kind": "tui"}))
        (host / "host.pid").write_text(json.dumps({"instance_id": session}))
        (host / "generations" / session / "host.pid").write_text(json.dumps({"pid": pid}))
        Path(address + ".secret").write_bytes(secret)
        (herdr / "process.json").write_text(json.dumps({"result": {"process_info": {"shell_pid": 1, "foreground_processes": [
            {"pid": pid, "argv": ["bun", "/senpi/dist/bundle/cli.js", "--session-id", session]}]}}}))
        state = {"sessionId": session, "sessionFile": str(self.custody.checkpoint), "isStreaming": False,
                 "isCompacting": False, "pendingMessageCount": 0,
                 "lifecycle": {"state": "waiting_background", "seq": 1, "since": "2026-11-12T00:00:00Z", "restoring": False,
                               "persisted": True, "waitingOn": {"children": 0, "human": [],
                                                                "background": [{"source": "terminal-monitors", "activeCount": 1}]}}}

        class Control(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                received = self.rfile.read(32)
                request = json.loads(self.rfile.readline())
                if received == secret:
                    self.wfile.write((json.dumps({"id": request["id"], "type": "response", "success": True,
                                                  "data": state}) + "\n").encode())

        server = socketserver.ThreadingUnixStreamServer(address, Control)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def queued(self) -> list[dict]:
        path = self.custody.store.state / "launch-queue.json"
        return json.loads(path.read_text()) if path.is_file() else []

    def held(self, minute: float) -> list[str]:
        return [line for line in self.custody.poll(minute) if '"state": "held"' in line]

    def lane(self, **fields):
        record = {**json.loads(self.custody.lane_path.read_text()), **fields}
        self.custody.lane_path.write_text(json.dumps(record))

    def answered_question(self, question: str = "q1", author: str = OWNER) -> None:
        with patch.dict(os.environ, {"HOME": str(self.custody.store.state.parent)}):
            questions = runpy.run_path(str(ROOT / "scripts/helio-questions.py"), run_name="lifecycle_questions")
        questions["db_connect"].__globals__["STATE"] = self.custody.store.state
        with contextlib.closing(questions["db_connect"]()) as db:
            db.execute("INSERT INTO questions (id,fingerprint,lane,audience,recipient,question,status,updated,answer_author) "
                       "VALUES (?,?,?,?,?,?,?,?,?)", (question, question, "issue7-regression", "staff", "", "Round?", "answered", 1, author))
            db.commit()


class LaneLifecycleTests(LifecycleCase):
    def test_issue_clarified_before_submit_hands_off_with_the_scope_submit_verified(self):
        self.edit_issue("Confirmed requirements\n- Round to whole seconds.", "Owner answered: whole seconds.")
        code, line = self.hand_off(self.custody.submit())
        self.assertEqual((code, line.split()[0]), (0, "PR_CUSTODY_ACK"))
        self.assertEqual(self.wait().data["scope"], FORMAT["digest"]("Confirmed requirements\n- Round to whole seconds."))
        self.assertEqual(self.held(1), [])
        self.edit_issue("Confirmed requirements\n- Round to whole seconds.\n- Something nobody asked for.", "Scope grew.")
        self.custody.poll(2)
        escalation = self.wait().data["escalation"]
        self.assertEqual((escalation["kind"], escalation["options"][0]), ("scope-authority", "Include the new requirements in this PR"))

    def test_helios_own_status_update_after_handoff_leaves_the_scope_unchanged(self):
        self.hand_off(self.custody.submit())
        scope = self.wait().data["scope"]
        self.assertEqual(self.issue_command("sync", "--issue", "7")[0], 0)
        self.assertNotEqual(self.custody.publication.github.issue["body"], "Confirmed requirements")
        self.assertEqual(self.held(1), [])
        self.assertEqual(self.wait().data["scope"], scope)

    def test_an_acknowledged_receipt_is_final_and_replaying_it_changes_nothing(self):
        first = self.custody.submit()
        _, acknowledged = self.hand_off(first)
        receipt = self.wait().data["receipt"]
        self.assertEqual(self.hand_off(first), (0, acknowledged))
        self.custody.auto.write("value.py", "def value():\n    return 2  # tidy\n")
        self.custody.auto.commit()
        self.custody.auto.git("push", "origin", "HEAD:helio/autofix-7")
        self.custody.head = self.custody.publication.github.head = self.custody.auto.git("rev-parse", "HEAD")
        second = self.custody.submit()
        self.assertNotEqual(second, first)
        code, line = self.hand_off(second)
        self.assertEqual(code, 2)
        self.assertIn("receipt is final", line)
        self.assertEqual((self.wait().data["receipt"], self.wait().data["verification"]), (receipt, first))

    def test_blocker_after_submit_finishes_the_phase_and_never_creates_custody_or_readiness(self):
        verification = self.custody.submit()
        code, line = self.helio("work", "block", "--issue", "7", "--reason", "needs the owner's rounding choice")
        self.assertEqual((code, line.split()[:3]), (0, ["WORK_BLOCKED", "issue=7", "stage=post-submit"]))
        code, line = self.helio("pr", "phase", "check", "--issue", "7", "--generation", "1")
        self.assertEqual((code, line.split()[0]), (0, "PHASE_BLOCKED"))
        code, line = self.hand_off(verification)
        self.assertEqual(code, 2)
        self.assertIn("recorded blocker", line)
        self.assertEqual((self.wait().data["receipt"], self.wait().data["pr"], self.wait().data["acknowledgment"]), (None, None, None))

    def test_answered_question_clears_a_live_workers_blocker_in_the_same_generation(self):
        self.lane(pane="w1:p2", launchState="started")
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        self.answered_question("q0")
        code, line = self.helio("work", "unblock", "--issue", "7", "--question", "q1")
        self.assertEqual((code, line), (1, "PLAN_REFUSED unknown question q1"))
        self.answered_question()
        code, line = self.helio("work", "unblock", "--issue", "7", "--question", "q1")
        self.assertEqual(code, 0, line)
        self.assertIn("changed=true generation=1", line)
        self.assertIsNone(self.wait().data["blocked"])
        code, line = self.hand_off(self.custody.submit())
        self.assertEqual((code, line.split()[0], self.wait().data["acknowledgment"]), (0, "PR_CUSTODY_ACK", 1))

    def test_a_trusted_answer_from_someone_else_does_not_clear_it(self):
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        self.answered_question(author="999999999999999999")
        code, line = self.helio("work", "unblock", "--issue", "7", "--question", "q1")
        self.assertEqual(code, 1)
        self.assertIn("not answered by the owner", line)
        self.assertIsNotNone(self.wait().data["blocked"])

    def test_a_blocked_worker_is_released_then_its_cleared_blocker_wakes_the_same_session_once(self):
        self.lane(pane="w1:p2", launchState="started")
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        calls = self.native_dori(idle_session=True)
        self.custody.poll(5, self.dori)
        released = json.loads(self.custody.lane_path.read_text())
        self.assertEqual((released["status"], released.get("pane"), released["session"]),
                         ("hibernated", None, str(self.custody.checkpoint)))
        self.answered_question()
        _, first = self.helio("work", "unblock", "--issue", "7", "--question", "q1")
        _, again = self.helio("work", "unblock", "--issue", "7", "--question", "q1")
        self.assertIn("changed=true generation=2", first)
        self.assertIn("changed=false generation=2", again)
        self.custody.poll(10, self.dori)
        self.custody.poll(15, self.dori)
        self.assertEqual([argv[:3] for argv in calls], [["dori", "reclaim", "issue7-regression"],
                                                         ["dori", "resume", "issue7-regression"]])
        [entry] = self.queued()
        self.assertEqual((entry["key"], entry["phase"]["generation"]), ("issue7-regression", 2))
        self.assertEqual(json.loads(self.custody.lane_path.read_text())["session"], str(self.custody.checkpoint))

    def test_without_an_authenticated_idle_session_dori_refuses_to_release_a_blocked_worker(self):
        self.lane(pane="w1:p2", launchState="started")
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        calls = self.native_dori()
        self.custody.poll(5, self.dori)
        self.assertEqual([argv[:3] for argv in calls], [["dori", "reclaim", "issue7-regression"]])
        lane = json.loads(self.custody.lane_path.read_text())
        self.assertEqual((lane["status"], lane["pane"]), ("working", "w1:p2"))
        self.assertEqual((self.wait().generation, self.wait().data["receipt"], self.queued()), (1, None, []))

    def test_a_clear_never_wakes_a_paused_lane(self):
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        self.lane(status="paused")
        self.answered_question()
        self.helio("work", "unblock", "--issue", "7", "--question", "q1")
        calls = self.native_dori()
        self.custody.poll(5, self.dori)
        self.assertFalse(any(argv[1] == "resume" for argv in calls))
        self.assertEqual(self.queued(), [])
        self.assertEqual(json.loads(self.custody.lane_path.read_text())["status"], "paused")

    def test_acknowledging_the_answer_clears_only_a_blocker_recorded_with_that_question(self):
        self.lane(pane="w1:p2", launchState="started")
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting a different answer", "--question", "q2")
        self.answered_question("q1")
        code, line = self.helio("work", "unblock", "--issue", "7", "--question", "q1", "--named")
        self.assertIn("changed=false", line)
        self.assertIsNotNone(self.wait().data["blocked"])


if __name__ == "__main__":
    unittest.main()
