"""Builds every Helio state database with the code that owns it, for tests that must see real schemas."""
import json
import os
import runpy
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
TS_STORES = """
import { Delivery } from "./delivery/delivery.ts";
import { Conversations } from "./conversations/conversations.ts";
import { PromptStore } from "./interactive/store.ts";
import { sendOnce } from "./conversations/reply-once.ts";
const state = process.env.DORI_STATE_DIR;
new Delivery(`${state}/discord-delivery.sqlite`).close();
new Conversations(`${state}/discord-conversations.sqlite`).dispose();
new PromptStore(`${state}/discord-prompts.sqlite`, 300).close();
await sendOnce({ path: `${state}/reply-sends.sqlite`, target: "1", text: "x", now: () => Date.now(),
  sleep: async () => {}, send: async () => "2", findSent: async () => undefined });
"""


def build_state(state: Path) -> None:
    state.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "DORI_STATE_DIR": str(state)}
    subprocess.run(["bun", "-e", TS_STORES], cwd=ROOT / "discord-inbound", env=env, check=True, capture_output=True)
    with mock.patch.dict(os.environ, {"DORI_STATE_DIR": str(state), "HOME": str(state.parent)}):
        questions = runpy.run_path(str(SCRIPTS / "helio-questions.py"), run_name="helio_questions_fixture")
        questions["STATE"] = state
        questions["db_connect"].__globals__["STATE"] = state
        questions["db_connect"]().close()
        followups = runpy.run_path(str(SCRIPTS / "helio-followups.py"), run_name="helio_followups_fixture")
        followups["connect"].__globals__["STATE"] = state
        followups["connect"]().close()
        decisions = runpy.run_path(str(SCRIPTS / "helio_decisions.py"))
        decisions["connect"](state / "decisions.sqlite").close()
        runpy.run_path(str(SCRIPTS / "helio_decision_upkeep.py"))["check"](state, "o/r")
        observations = runpy.run_path(str(SCRIPTS / "helio_observations.py"))
        with closing(sqlite3.connect(state / "discord-conversations.sqlite")) as db:
            observations["poll"](db, lambda: {"phase": "running"})
        sync = runpy.run_path(str(SCRIPTS / "helio_issue_sync.py"))
        sync["mark_discussed"](state, "o/r", 1, 1)
        sync["enqueue"](state, "o/r", 1)
        issues = runpy.run_path(str(SCRIPTS / "helio_issues.py"))
        body = {"body": "", "title": "t", "state": "open"}
        fake = lambda argv, stdin=None: json.dumps([] if "comments" in argv[2] else body)
        issues["Issues"]("o/r", state, command=fake).update(1, {"projection": "x"})
        issues["Issues"]("o/r", state, command=fake).log_milestones(1, [])
        created = {"state": "closed", "body": ""}
        def followup_command(argv, stdin=None):
            if argv[:3] == ["gh", "api", "user"]:
                return "helio"
            if "--slurp" in argv:
                return "[]"
            if stdin:
                created.update(json.loads(stdin), number=2)
            return json.dumps(created)
        followup = runpy.run_path(str(SCRIPTS / "helio_issue_followup.py"))
        followup["create"](issues["Issues"]("o/r", state, command=followup_command),
                           followup["Request"](1, "1", "2", "Follow-up", "New scope", ("bug",)))
        work = runpy.run_path(str(SCRIPTS / "helio-work.py"), run_name="helio_work_fixture")
        work["connect"]().close()


def tables(state: Path) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for path in sorted(state.glob("*.sqlite")):
        with closing(sqlite3.connect(path)) as db:
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        found[path.name] = sorted(names)
    return found
