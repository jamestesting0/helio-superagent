# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Bounded stops for managed issue lanes: the stop clock, one owner question per decision, parking.

Used by the PR controller (helio_pr_recovery.py) and `helio pr phase decide` (helio-plan.py).
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_recovery_store import Store, Wait

HERE = Path(__file__).resolve().parent
S = runpy.run_path(str(HERE / "helio_pr_recovery_store.py"))
Runner = Callable[[list[str]], str]
Condition = tuple[str, str] | None

LEAD_AFTER, OWNER_AFTER = 30 * 60, 90 * 60
CI_PENDING_BOUND, WORKER_QUIET = 3 * 3600, 30 * 60
STOP, TAKE, TRY = "Stop this work", "I'll take it over", "Try again"
BUSY = "Stop the worker and keep its checkpoint, then try again"
CI = ("Retry CI now", "I'll fix CI", STOP)
OPTIONS: dict[str, tuple[str, ...]] = {
    "repair-exhausted": ("Try once more", TAKE, STOP),
    "startup-failed": (TRY, TAKE, STOP),
    "pr-closed": ("Reopen the PR and continue", STOP),
    "issue-closed": ("Continue under a linked follow-up issue", STOP),
    "authority": (STOP, "Park it"),
    "ci-budget": CI, "ci-identity": CI, "ci-rejected": CI,
    "scope-authority": ("Include the new requirements in this PR", "Leave them for a related issue"),
    "stalled": (TRY, TAKE, STOP),
    "no-progress": (TRY, TAKE, STOP),
    "worker-blocked": ("Unblock and continue", TAKE, STOP),
    "follow-up": ("Create the follow-up issue", "No follow-up"),
}
PARK = {TAKE, "Park it", "I'll fix CI"}
NEXT = {
    "no-progress": "the lead inspects the worker pane and nudges it with a fact or records a blocker",
    "worker-blocked": "the worker's blocker needs its answer or an owner decision",
    "stalled": "the lead diagnoses it within its authority (helio pr phase show, dori show)",
}
RECORDED = ("queued", "send_failed", "delivery_unknown", "sending", "awaiting_answer", "answered")


def lane_key(issue: int) -> str:
    return f"custody-issue{issue}"


def question(store: Store, qid: str) -> dict | None:
    path = store.state / "discord-questions.sqlite"
    if not path.is_file():
        return None
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
    return dict(row) if row else None


def ask(store: Store, issue: int, text: str, options: tuple[str, ...] | list[str]) -> tuple[str, str]:
    """The real question command; a recorded but undelivered question exits 1 and still counts (it is retried)."""
    argv = [sys.executable, str(HERE / "helio-questions.py"), "ask", "--lane", lane_key(issue), "--audience", "owner",
            "--text", text]
    for option in options:
        argv += ["--option", option]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120,
                            env={**os.environ, "DORI_STATE_DIR": str(store.state)})
    try:
        recorded = json.loads(result.stdout)
    except ValueError:
        recorded = None
    if not isinstance(recorded, dict) or not recorded.get("id") or recorded.get("status") not in RECORDED:
        raise RuntimeError("owner question was not recorded: " + (result.stderr or result.stdout).strip()[-300:])
    return recorded["id"], recorded["status"]


def wording(wait: Wait, detail: str, options: list[str], again: bool = False) -> str:
    pr = f" (PR {wait.data['pr']})" if wait.data["pr"] else ""
    lines = [f"Issue #{wait.issue}, {wait.data['title']}{pr}, needs your decision.", detail.strip()[:900],
             "Options: " + "; ".join(f"{index}) {option}" + (" (recommended)" if index == 1 else "")
                                     for index, option in enumerate(options, 1)),
             "Tap an option or reply to this message."]
    if again:
        lines.append("(asked again: no answer in 72 hours)")
    return "\n".join(lines)[:1500]


def escalate(store: Store, wait: Wait, kind: str, detail: str, now: float, *, busy: bool = False) -> Wait:
    """Ask the owner once. The escalation is durable before the message; a worker's own blocker is never replaced."""
    current = wait.data.get("escalation")
    if current and current.get("kind") == kind and current.get("question"):
        return wait
    if not current or current.get("kind") != kind:
        options = list((BUSY, TAKE, STOP) if busy and kind in ("stalled", "no-progress", "worker-blocked") else OPTIONS[kind])
        blocked = wait.data.get("blocked") or {"reason": detail[:300], "at": now, "stage": "controller",
                                               "kind": kind, "question": None}
        wait = S["save"](store, S["notice"](replace(wait, data={
            **wait.data, "blocked": blocked,
            "escalation": {"kind": kind, "at": now, "question": None, "options": options, "detail": detail[:900]},
        }), "decision", f"Escalating to the owner: {detail[:300]}", now))
    escalation = wait.data["escalation"]
    qid, status = ask(store, wait.issue, wording(wait, escalation["detail"], escalation["options"]), escalation["options"])
    summary = (f"Owner answered {qid}; apply it with helio pr phase decide --issue {wait.issue} --question {qid}"
               if status == "answered" else
               f"Asked owner ({qid}): {escalation['detail'][:200]}; recommended: {escalation['options'][0]}")
    return S["save"](store, S["notice"](replace(wait, data={**wait.data, "escalation": {**escalation, "question": qid}}),
                                        "decision", summary, now))


def park(store: Store, wait: Wait, reason: str, now: float) -> Wait:
    blocked = wait.data.get("blocked") or {"reason": reason[:300], "at": now, "stage": "controller",
                                           "kind": (wait.data.get("escalation") or {}).get("kind", "stalled"),
                                           "question": None}
    stop, stops = wait.data.get("stop"), list(wait.data.get("stops") or [])
    if stop:
        stops = [*stops, {"kind": stop["kind"], "since": stop["since"], "until": now}][-20:]
    return S["save"](store, S["notice"](replace(wait, data={**wait.data, "blocked": {**blocked, "parked": True}, "stop": None,
                                                             "stops": stops}),
        "decision", f"Parked until the owner decides: {reason[:200]}. A later owner message applies with "
                    f"helio pr phase decide --issue {wait.issue} --message M --channel C --option LABEL", now))


def follow(store: Store, wait: Wait, now: float) -> Wait:
    """An asked question: report its answer, re-ask once after expiry, then park (no clock, no wakes)."""
    escalation = wait.data.get("escalation")
    if not escalation or not escalation.get("question") or (wait.data.get("blocked") or {}).get("parked"):
        return wait
    row = question(store, escalation["question"])
    status = row["status"] if row else "expired"
    if status == "answered":
        return S["save"](store, S["notice"](wait, "decision", f"Owner answered {escalation['question']}; apply it with "
                                            f"helio pr phase decide --issue {wait.issue} --question {escalation['question']}", now))
    if status not in ("expired", "withdrawn", "cancelled"):
        return wait
    if escalation.get("reasked"):
        return park(store, wait, f"no answer to two questions (last {escalation['question']})", now)
    qid, _ = ask(store, wait.issue, wording(wait, escalation["detail"], escalation["options"], again=True), escalation["options"])
    return S["save"](store, S["notice"](replace(wait, data={**wait.data, "escalation": {**escalation, "question": qid, "reasked": True}}),
                                        "decision", f"Asked owner again ({qid}) after 72 hours without an answer", now))


def progress_key(wait: Wait) -> str:
    data = wait.data
    incidents = sorted((key, len(item["retries"]), item["resolved"]) for key, item in data["incidents"].items())
    worker = (data.get("worker_progress") or {}).get("at")
    return hashlib.sha256(json.dumps([wait.generation, data["pr"], data["head"], data["verification"], data["acknowledgment"],
                                      incidents, worker, data["terminal"]]).encode()).hexdigest()


def clock(store: Store, wait: Wait, condition: Condition, now: float, *, busy: bool = False) -> Wait:
    """Deadlines run from the stop itself, never from the last notice: lead at 30 minutes, owner at 90."""
    data = dict(wait.data)
    stops = list(data.get("stops") or [])

    def close(stop: dict | None) -> None:
        if stop:
            stops.append({"kind": stop["kind"], "since": stop["since"], "until": now})
            del stops[:-20]

    key = progress_key(wait)
    if data.get("progress_key") != key:
        data["progress_key"], data["progress_at"] = key, now
        if condition is None or (data.get("stop") or {}).get("kind") != "no-progress":
            close(data.get("stop"))
            data["stop"] = None
    if condition is None or data["terminal"]:
        close(data.get("stop"))
        data["stop"] = None
    else:
        kind, detail = condition
        stop = data.get("stop")
        if not stop or stop["kind"] != kind:
            close(stop)
            since = (data.get("worker_progress") or {}).get("at", now) if kind == "no-progress" else now
            data["stop"] = {"kind": kind, "since": since, "detail": detail[:500], "lead_at": None, "owner_at": None}
    data["stops"] = stops
    if data != wait.data:
        wait = S["save"](store, replace(wait, data=data))
    stop = wait.data.get("stop")
    if not stop:
        return wait
    elapsed = now - stop["since"]
    if elapsed >= LEAD_AFTER and stop["lead_at"] is None:
        wait = S["save"](store, S["notice"](replace(wait, data={**wait.data, "stop": {**stop, "lead_at": now}}), "diagnosis",
            f"Stopped {int(elapsed // 60)} min: {stop['detail'][:300]}; next: {NEXT.get(stop['kind'], NEXT['stalled'])}", now))
        stop = wait.data["stop"]
    asked = bool((wait.data.get("escalation") or {}).get("question"))
    if elapsed >= OWNER_AFTER and stop["owner_at"] is None and not asked:
        wait = S["save"](store, replace(wait, data={**wait.data, "stop": {**stop, "owner_at": now}}))
        if stop["kind"] == "no-progress" and not wait.data.get("blocked"):
            wait = S["save"](store, replace(wait, data={**wait.data, "blocked": {
                "reason": stop["detail"][:300], "at": now, "stage": "controller", "kind": "no-progress", "question": None}}))
        kind = stop["kind"] if stop["kind"] in OPTIONS else "stalled"
        wait = escalate(store, wait, kind, f"Stopped {int(elapsed // 60)} min: {stop['detail']}", now, busy=busy)
    return wait


def worker_tree(run: Runner, cwd: str) -> tuple[str, str]:
    """Branch head and a digest of every uncommitted change, including further edits to already-dirty files."""
    head = run(["git", "-C", cwd, "rev-parse", "HEAD"]).strip()
    diff = run(["git", "-C", cwd, "diff", "HEAD"])
    names = sorted(name for name in run(["git", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"]).split("\0") if name)
    untracked = []
    for name in names:
        try:
            info = (Path(cwd) / name).stat()
            untracked.append([name, info.st_size, info.st_mtime_ns])
        except OSError:
            untracked.append([name, None, None])
    return head, hashlib.sha256(json.dumps([diff, untracked]).encode()).hexdigest()


def continuations(checkpoint: Path | None) -> int:
    if checkpoint is None or not checkpoint.is_file():
        return 0
    with checkpoint.open(encoding="utf-8", errors="replace") as lines:
        return sum('"goal-continuation"' in line for line in lines)


def worker(store: Store, wait: Wait, run: Runner, cwd: str, checkpoint: Path | None, now: float) -> tuple[Wait, Condition]:
    """W2: an active worker is bounded by time without a branch, worktree or verification change."""
    head, tree = worker_tree(run, cwd)
    count = continuations(checkpoint)
    previous = wait.data.get("worker_progress")
    marker = [head, tree, wait.data["verification"]]
    if previous is None or [previous["head"], previous["tree"], previous.get("verification")] != marker:
        wait = S["save"](store, replace(wait, data={**wait.data, "worker_progress": {
            "head": head, "tree": tree, "verification": wait.data["verification"], "continuations": count, "at": now}}))
    progress = wait.data["worker_progress"]
    quiet = now - progress["at"]
    if quiet < WORKER_QUIET:
        return wait, None
    return wait, ("no-progress", f"Worker {wait.data['lane']} made no change for {int(quiet // 60)} min "
                                 f"({max(0, count - progress['continuations'])} goal continuations)")
