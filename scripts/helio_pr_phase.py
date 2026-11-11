# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Source-bound worker phase acknowledgment and custody; called by helio pr phase."""
from __future__ import annotations

from dataclasses import replace
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import time
from typing import Callable, TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from helio_pr_recovery_store import Data, Store, Wait

HERE = Path(__file__).resolve().parent
S = runpy.run_path(str(HERE / "helio_pr_recovery_store.py"))
V = runpy.run_path(str(HERE / "helio_pr_verification.py"))
AUTH = runpy.run_path(str(HERE / "helio_pr_authority.py"))
WORK = runpy.run_path(str(HERE / "helio-work.py"))
FORMAT = runpy.run_path(str(HERE / "helio_issue_format.py"))
Runner = Callable[[list[str]], str]


class Lane(TypedDict, total=False):
    key: str
    job: str
    source: str
    revision: int
    pane: str
    launchState: str
    status: str
    cwd: str
    session: str
    phase: dict[str, str | int]
    closedAt: str
    receipt: dict[str, str]


def lane(store: Store, wait: Wait) -> Lane:
    key = wait.data["lane"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,60}", key) or ".." in key:
        raise S["Refused"]("invalid managed lane key")
    paths = [store.state / "lanes" / f"{key}.json", store.state / "lanes/archive" / f"{key}.json"]
    path = next((candidate for candidate in paths if candidate.is_file()), None)
    if path is None:
        raise S["Refused"]("managed lane record is missing")
    value: Lane = json.loads(path.read_text())
    if (value.get("key"), value.get("job"), value.get("source")) != (key, wait.job, wait.data["source"]):
        raise S["Refused"]("managed lane source or job binding changed")
    return value


def objective(wait: Wait) -> str:
    return (f"Complete Helio job {wait.job} phase {wait.generation} under scope {wait.data['scope']}. "
            f"Execute this phase's generated brief, verify and publish through its authorized submit path, "
            f"then transfer external waiting with helio pr wait --issue {wait.issue} --generation {wait.generation} "
            "--verification VERIFIED_ID. Finish this worker goal only when "
            f"helio pr phase check --issue {wait.issue} --generation {wait.generation} prints "
            "PHASE_HANDED_OFF or PHASE_READY. Custody is not issue completion, merge or deployment authority.")


def access(store: Store, wait: Wait, run: Runner, *, merged: bool = False) -> None:
    issue = json.loads(run(["gh", "issue", "view", str(wait.issue), "--repo", store.repo,
                           "--json", "state,body,labels"]))
    scope = FORMAT["digest"](FORMAT["split"](issue.get("body") or "")[0])
    if scope != wait.data["scope"] or (issue["state"] != "OPEN" and not merged):
        raise S["Refused"]("issue scope or open task identity changed")
    AUTH["require_unheld"](store.repo, wait.issue)
    try:
        grant = WORK["available"](store.repo, wait.issue, datetime.datetime.now(datetime.timezone.utc), include_used=True)
    except WORK["Refused"]:
        grant = None
    if grant and (grant.holds or grant.blocked):
        raise S["Refused"]("requester holds or blocks this task")
    proof = wait.data["authority"]
    if proof is not None:
        AUTH["verify"](proof)
    elif wait.data["route"] == "autofix":
        if os.environ.get("HELIO_AUTOFIX", "on") != "on" or not {"bug", "confirmed"} <= {
                item["name"] for item in issue.get("labels", [])}:
            raise S["Refused"]("standing automatic-fix authority no longer applies")
    else:
        if grant is None or f"discord:{grant.channel}:{grant.message}" != wait.data["source"]:
            raise S["Refused"]("recorded work source changed")
        AUTH["verify"]({"message": grant.message, "channel": grant.channel,
                        "author": grant.author, "source_hash": grant.source_hash})


def initialize(store: Store, task, key: str, branch: str, run: Runner) -> Wait:
    current = S["load"](store, task.issue)
    if current is not None:
        if current.data["source"] != task.source or current.job != f"issue-{task.issue}":
            raise S["Refused"]("existing managed task needs explicit source reconciliation")
        return current
    issue = json.loads(run(["gh", "issue", "view", str(task.issue), "--repo", store.repo, "--json", "body"]))
    data: Data = {
        "lane": key, "source": task.source, "route": task.route, "title": task.title, "branch": branch,
        "scope": FORMAT["digest"](FORMAT["split"](issue.get("body") or "")[0]), "authority": None,
        "pr": None, "head": None, "base": None, "verification": None, "status": "starting", "terminal": False,
        "acknowledgment": None, "receipt": None, "started_session": None, "pending": None,
        "last_action": None, "intent": {"kind": "wake", "generation": 1, "observation": "initial"},
        "incidents": {}, "notices": [], "last_observation": None, "last_progress": time.time(),
    }
    wait = S["Wait"](store.repo, task.issue, f"issue-{task.issue}", 1, 0, data)
    access(store, wait, run)
    return S["save"](store, wait)


def checkpoint(current: Lane) -> tuple[Path, str]:
    config_path = Path(os.environ.get("DORI_CONFIG", str(Path.home() / ".dori/elobot/config.json")))
    config = json.loads(config_path.read_text()) if config_path.is_file() else {}
    root = Path(config.get("sessionsDir", str(Path.home() / ".omo/agent/sessions"))).expanduser().resolve()
    session = current.get("session")
    if not session:
        raise S["Refused"]("worker has no registered session checkpoint")
    matches = [Path(session)] if "/" in session else list(root.rglob(f"*_{session}.jsonl"))
    if len(matches) != 1:
        raise S["Refused"]("worker checkpoint is missing or ambiguous")
    path = matches[0]
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not path.resolve().is_relative_to(root):
        raise S["Refused"]("checkpoint is not an owned session file")
    with path.open() as source:
        header = json.loads(next(source))
    if header.get("type") != "session" or header.get("cwd") != current.get("cwd") or (
            "/" not in session and header.get("id") != session):
        raise S["Refused"]("checkpoint does not belong to this lane")
    return path, header["id"]


def start(store: Store, wait: Wait, run: Runner) -> Wait:
    access(store, wait, run)
    current = lane(store, wait)
    if current.get("phase") != {"owner": "helio-pr", "version": 1, "generation": wait.generation}:
        raise S["Refused"]("worker generation does not match its registered phase")
    if current.get("status", "working") not in ("working", "not-done"):
        raise S["Refused"]("worker is not in an active phase")
    path, session = checkpoint(current)
    goal = None
    with path.open() as source:
        for line in source:
            entry = json.loads(line)
            message = entry.get("message", {})
            if (message.get("role") == "toolResult" and message.get("toolName") in ("create_goal", "update_goal")
                    and not message.get("isError")):
                observed = (message.get("details") or {}).get("goal")
                if observed is not None:
                    goal = observed
    if not goal or (goal.get("threadId"), goal.get("status"), goal.get("objective")) != (
            session, "active", objective(wait)):
        raise S["Refused"]("create the exact active phase goal directly before acknowledging phase start")
    if wait.data["started_session"] == session:
        return wait
    intent = wait.data["intent"]
    if intent is None or intent["kind"] != "wake" or intent["generation"] != wait.generation:
        raise S["Refused"]("this phase has no pending wake intent")
    return S["save"](store, replace(wait, data={
        **wait.data, "started_session": session, "status": "implementing",
        "last_action": intent["observation"], "pending": None, "intent": None, "last_progress": time.time(),
    }))


def handoff(store: Store, wait: Wait, identity: str, run: Runner) -> Wait:
    if wait.data["started_session"] is None:
        raise S["Refused"]("phase start has not been acknowledged")
    evidence = V["read"](store, identity)
    context = evidence["context"]
    if (context["issue"], context["job"], context["branch"], context["scope"]) != (
            wait.issue, wait.job, wait.data["branch"], wait.data["scope"]):
        raise S["Refused"]("verification belongs to another task or scope")
    if context["generation"] != wait.generation and wait.data["verification"] != identity:
        raise S["Refused"]("verification belongs to another phase")
    with store.operations() as db:
        pr = db.execute("SELECT pr FROM pr_verifications WHERE id=?", (identity,)).fetchone()[0]
    updated = replace(wait, data={**wait.data, "authority": context["authority_proof"]})
    access(store, updated, run)
    pull = json.loads(run(["gh", "pr", "view", pr, "--repo", store.repo, "--json",
                           "state,headRefOid,headRefName,baseRefName,isCrossRepository,closingIssuesReferences"]))
    if (pull["state"], pull["headRefOid"], pull["headRefName"], pull["baseRefName"], pull["isCrossRepository"]) != (
            "OPEN", context["head"], context["branch"], "main", False) or wait.issue not in {
                item["number"] for item in pull.get("closingIssuesReferences", [])}:
        raise S["Refused"]("canonical PR no longer represents this verified task")
    current = lane(store, wait)
    tree = current["cwd"]
    dirty = run(["git", "-C", tree, "status", "--porcelain", "--untracked-files=all"])
    head = run(["git", "-C", tree, "rev-parse", "HEAD"]).strip()
    remote = run(["git", "-C", tree, "ls-remote", "--heads", "origin", f"refs/heads/{context['branch']}"]).split()
    if dirty.strip() or head != context["head"] or not remote or remote[0] != head:
        raise S["Refused"]("worktree is not the clean, pushed and tested head")
    project = Path(os.environ["HELIO_PROJECT"]).expanduser().resolve()
    if V["snapshot"](project, head, V["PROOF"]["RUNNER"]) != evidence["suite"]["inputs"]:
        raise S["Refused"]("verification environment changed before custody acknowledgment")
    receipt = hashlib.sha256(f"{store.repo}:{wait.issue}:{wait.generation}:{identity}:{pr}".encode()).hexdigest()
    updated = replace(updated, data={
        **updated.data, "pr": pr, "head": head, "base": context["base"], "verification": identity,
        "acknowledgment": wait.generation, "receipt": receipt, "intent": None,
    })
    return S["save"](store, S["notice"](updated, "waiting", "Implementation verified; controller owns CI waiting", time.time()))
