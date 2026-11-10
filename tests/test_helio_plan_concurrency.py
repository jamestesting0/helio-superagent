"""Process-level acceptance commit and publication ownership checks."""
import json
import os
import selectors
import sqlite3
import subprocess
import sys

from plan_fixture import stage_source
from test_helio_plan import ROOT, PLAN, REPO, PlanCase, discord


IMPORTS = f"""
import json, os, signal, sqlite3, sys
from pathlib import Path
sys.path.insert(0, {str(ROOT / "tests")!r})
from test_helio_plan import P, POSTED, REPO, discord
"""


class PlanProcessTests(PlanCase):
    def checkpoint(self, process):
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(10), "process did not reach its fixture checkpoint")
            line = process.stdout.readline().strip()
        self.assertTrue(line, "process exited before the fixture checkpoint")
        return line

    def stop(self, process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)

    def test_receipt_and_acceptance_are_atomic_across_process_death_at_commit(self):
        for phase in ("before", "after"):
            with self.subTest(phase=phase):
                case = PlanCase()
                case.setUp()
                try:
                    state = case.dir / "state"
                    stage_source(state, json.dumps(discord()("555")["payload"]))
                    script = case.dir / "acceptor.py"
                    script.write_text(IMPORTS + """
class Boundary(sqlite3.Connection):
    def __exit__(self, kind, value, traceback):
        active = kind is None and self.in_transaction
        if active and os.environ["COMMIT_PHASE"] == "before":
            print("COMMIT_BEFORE " + str(os.getpid()), flush=True)
            os.kill(os.getpid(), signal.SIGSTOP)
        result = super().__exit__(kind, value, traceback)
        if active and os.environ["COMMIT_PHASE"] == "after":
            print("COMMIT_AFTER " + str(os.getpid()), flush=True)
            os.kill(os.getpid(), signal.SIGSTOP)
        return result
connect = sqlite3.connect
def observed(*args, **kwargs):
    return connect(*args, **kwargs, factory=Boundary)
sqlite3.connect = observed
raise SystemExit(P["main"](["request","record","--issue","12","--message","555","--channel","1"],
                          discord=discord(),now=POSTED))
""")
                    process = subprocess.Popen([sys.executable, str(script)], text=True, stdout=subprocess.PIPE,
                                               stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                               env={**os.environ, "COMMIT_PHASE": phase, "HELIO_GITHUB_REPO": REPO})
                    try:
                        self.assertEqual(self.checkpoint(process), f"COMMIT_{phase.upper()} {process.pid}")
                        process.kill()
                        process.communicate(timeout=5)
                        with sqlite3.connect(state / "discord-delivery.sqlite") as db:
                            receipts = db.execute("SELECT count(*) FROM plan_requests").fetchone()[0]
                            acceptance = db.execute("SELECT count(*) FROM acceptance").fetchone()[0]
                            self.assertEqual((receipts, acceptance), (0, 0) if phase == "before" else (1, 1))
                            self.assertIsNotNone(db.execute("SELECT payload FROM delivery WHERE id='555'").fetchone()[0])
                        code, output = case.run_cli("request", "record", "--issue", "12",
                                                    "--message", "555", "--channel", "1")
                        self.assertEqual(code, 0, output)
                        print("ACCEPTANCE_COMMIT_PROBE", json.dumps({
                            "phase": phase, "killed_pid": process.pid, "receipts": receipts,
                            "acceptance": acceptance, "resume": code}))
                    finally:
                        self.stop(process)
                finally:
                    case.doCleanups()

    def test_two_poster_processes_share_one_revision_and_one_remote_comment(self):
        stage_source(self.dir / "state", json.dumps(discord()("555")["payload"]))
        draft = self.dir / "plan.json"
        draft.write_text(json.dumps(PLAN))
        remote = self.dir / "remote.json"
        remote.write_text(json.dumps({"state": "OPEN", "title": "Fixture", "body": "Confirmed issue",
                                      "comments": [], "labels": []}))
        script = self.dir / "poster.py"
        script.write_text(IMPORTS + """
remote = Path(os.environ["REMOTE_FIXTURE"])
def github(argv, stdin=None, cwd=None):
    state = json.loads(remote.read_text())
    if argv[:3] == ["gh","issue","view"]:
        return json.dumps(state)
    if argv[:3] == ["gh","api","user"]:
        return "helio-bot"
    if argv[:3] == ["gh","pr","list"]:
        return "[]"
    if argv[:2] == ["gh","api"] and "--paginate" in argv:
        return json.dumps([[{"body":row["body"],"html_url":row["url"],"user":row["author"]}
                            for row in state["comments"]]])
    if argv[:3] == ["gh","label","create"]:
        return ""
    if argv[:3] == ["gh","issue","edit"]:
        state["labels"] = [{"name":"helio-plan"}] if "--add-label" in argv else []
        remote.write_text(json.dumps(state))
        return ""
    if argv[:2] == ["gh","api"] and "POST" in argv:
        if os.environ.get("POST_BARRIER") == "1":
            print("POST_READY " + str(os.getpid()),flush=True)
            sys.stdin.readline()
        state = json.loads(remote.read_text())
        row = {"author":{"login":"helio-bot"},"body":json.loads(stdin)["body"],
               "url":f"https://github.com/{REPO}/issues/12#issuecomment-{len(state['comments'])+1}"}
        state["comments"].append(row)
        remote.write_text(json.dumps(state))
        return json.dumps({"html_url":row["url"]})
    raise AssertionError(argv)
raise SystemExit(P["main"](["post","--issue","12","--request-message","555","--file",sys.argv[1],
    "--announcement-file",str(Path(sys.argv[1]).with_suffix(".announcement"))],
    gh=P["GitHub"](REPO,run=github),discord=discord(),now=POSTED))
""")
        command = [sys.executable, str(script), str(draft)]
        environment = {**os.environ, "REMOTE_FIXTURE": str(remote), "HELIO_GITHUB_REPO": REPO}
        first = subprocess.Popen(command, env={**environment, "POST_BARRIER": "1"}, text=True,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(self.checkpoint(first), f"POST_READY {first.pid}")
            second = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=10)
            self.assertEqual(second.returncode, 2, second.stdout + second.stderr)
            self.assertIn("busy", second.stdout)
            first_output, first_error = first.communicate("continue\n", timeout=10)
            self.assertEqual(first.returncode, 0, first_output + first_error)
            retried = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=10)
            self.assertEqual(retried.returncode, 0, retried.stdout + retried.stderr)
            self.assertIn("revision=1", retried.stdout)
            comments = json.loads(remote.read_text())["comments"]
            self.assertEqual(len(comments), 1)
            with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
                self.assertEqual(db.execute("SELECT count(*) FROM plan_publications WHERE kind='comment' AND state='confirmed'").fetchone()[0], 1)
            print("POSTER_PROCESS_PROBE", json.dumps({"first_pid": first.pid, "first": first.returncode,
                                                      "competing": second.returncode, "retry": retried.returncode,
                                                      "comment_count": len(comments)}))
        finally:
            self.stop(first)
