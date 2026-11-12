# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Durable PR custody records used by helio pr phase and the follow-up controller."""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass, replace
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from typing import Literal, Protocol, TypedDict

Json = str | int | float | bool | None | list["Json"] | dict[str, "Json"]
Status = Literal["starting", "implementing", "waiting", "repair", "diagnosis", "ready",
                 "decision", "unknown", "held", "settled"]


class Refused(RuntimeError):
    """Custody state cannot safely advance."""


class Changed(Refused):
    """A concurrent owner changed the record before this transition."""


class NoticeOptional(TypedDict, total=False):
    at: float


class Notice(NoticeOptional):
    id: str
    key: str
    generation: int
    status: str
    detail: str
    acknowledged: bool


class Retry(TypedDict):
    slot: int
    run: int
    job: int
    attempt: int
    status: Literal["reserved", "accepted", "rejected", "finished"]
    requested_at: float
    finished_at: float | None


class Incident(TypedDict):
    first_at: float
    retries: list[Retry]
    resolved: bool
    resolved_at: float | None


class Intent(TypedDict):
    kind: Literal["wake", "complete"]
    observation: str
    generation: int


class BlockerOptional(TypedDict, total=False):
    kind: str          # controller and watchdog blockers name their escalation kind; worker blockers have none
    parked: bool       # the owner chose to hold it; no clock, no wakes
    transferred: str   # the worker's question moved to the custody lane


class Blocker(BlockerOptional):
    reason: str
    at: float
    stage: Literal["pre-submit", "post-submit", "controller"]
    question: str | None


class Stop(TypedDict):
    kind: str
    since: float
    detail: str
    lead_at: float | None
    owner_at: float | None


class Escalation(TypedDict, total=False):
    observation: str
    parked: bool
    kind: str
    at: float
    question: str | None
    options: list[str]
    detail: str
    reasked: bool


class WorkerProgress(TypedDict):
    head: str
    tree: str
    verification: str | None
    continuations: int
    at: float


class OptionalData(TypedDict, total=False):
    blocked: Blocker | None
    stop: Stop | None
    stops: list[dict[str, Json]]
    progress_at: float
    progress_key: str
    rescope: str | None
    scope_grant: str | None
    expected_head: str | None
    release_refusal: str | None
    reworked: list[str]
    attempts: dict[str, int]
    startup_failures: list[float]
    startup_failed_revision: int | None
    worker_progress: WorkerProgress | None
    escalation: Escalation | None
    ci_pending_since: float | None
    followup_handled: str | None


class Data(OptionalData):
    lane: str
    source: str
    route: str
    title: str
    branch: str
    scope: str
    authority: dict[str, Json] | None
    pr: str | None
    head: str | None
    base: str | None
    verification: str | None
    status: Status
    terminal: bool
    acknowledgment: int | None
    receipt: str | None
    started_session: str | None
    pending: str | None
    last_action: str | None
    intent: Intent | None
    incidents: dict[str, Incident]
    notices: list[Notice]
    last_observation: str | None
    last_progress: float


@dataclass(frozen=True, slots=True)
class Wait:
    repo: str
    issue: int
    job: str
    generation: int
    revision: int
    data: Data


class Store(Protocol):
    repo: str
    state: Path

    def operations(self) -> AbstractContextManager[sqlite3.Connection]: ...


def migrate(db: sqlite3.Connection) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS pr_waits (
        repo TEXT NOT NULL, issue INTEGER NOT NULL, job TEXT NOT NULL,
        generation INTEGER NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(repo,issue))""")


def decode(row: tuple[str, int, str, int, int, str]) -> Wait:
    try:
        data: Data = json.loads(row[5])
    except ValueError as error:
        raise Refused("custody record is not valid JSON") from error
    if not isinstance(data, dict) or not isinstance(data.get("notices"), list) or not isinstance(data.get("incidents"), dict):
        raise Refused("custody record has an invalid shape")
    shapes = {"blocked": dict, "escalation": dict, "stop": dict, "intent": dict, "worker_progress": dict,
              "stops": list, "reworked": list, "startup_failures": list, "attempts": dict}
    if any(data.get(name) is not None and not isinstance(data[name], kind) for name, kind in shapes.items()):
        raise Refused("custody record has a field of the wrong type")
    if data.get("status") not in ("starting", "implementing", "waiting", "repair", "diagnosis",
                             "ready", "decision", "unknown", "held", "settled"):
        raise Refused("unknown custody state; keep the managed lane closed to new effects")
    if row[3] < 1 or row[4] < 1 or not data.get("lane") or not data.get("source"):
        raise Refused("invalid custody identity")
    return Wait(row[0], row[1], row[2], row[3], row[4], data)


def load(store: Store, issue: int) -> Wait | None:
    with store.operations() as db:
        row = db.execute("SELECT repo,issue,job,generation,revision,data FROM pr_waits WHERE repo=? AND issue=?",
                         (store.repo, issue)).fetchone()
    return decode(row) if row else None


def rows(store: Store) -> list[Wait]:
    with store.operations() as db:
        values = db.execute("SELECT repo,issue,job,generation,revision,data FROM pr_waits WHERE repo=?",
                            (store.repo,)).fetchall()
    return [decode(row) for row in values]


def issues(store: Store) -> list[int]:
    with store.operations() as db:
        return [row[0] for row in db.execute("SELECT issue FROM pr_waits WHERE repo=?", (store.repo,))]


def save(store: Store, wait: Wait) -> Wait:
    """Compare-and-swap before effects; no network operation holds this transaction."""
    data = json.dumps(wait.data, sort_keys=True, separators=(",", ":"))
    with store.operations() as db:
        if wait.revision == 0:
            try:
                db.execute("INSERT INTO pr_waits VALUES (?,?,?,?,?,?,?)",
                           (wait.repo, wait.issue, wait.job, wait.generation, 1, data, time.time()))
            except sqlite3.IntegrityError as error:
                raise Changed("custody was allocated concurrently") from error
        else:
            changed = db.execute("""UPDATE pr_waits SET generation=?,revision=revision+1,data=?,updated_at=?
                WHERE repo=? AND issue=? AND revision=?""",
                                 (wait.generation, data, time.time(), wait.repo, wait.issue, wait.revision))
            if changed.rowcount != 1:
                raise Changed("custody changed before its effect; reconcile the existing intent")
    return replace(wait, revision=wait.revision + 1)


def notice(wait: Wait, status: Status, detail: str, now: float) -> Wait:
    semantic = hashlib.sha256(json.dumps([wait.job, wait.generation, wait.data["pr"],
                                         wait.data["head"], status, detail]).encode()).hexdigest()
    notices = wait.data["notices"]
    previous = next((item for item in notices if item["id"] == wait.data["last_observation"]), None)
    if previous is not None and previous["key"] == semantic:
        return wait
    identity = hashlib.sha256(f"{semantic}:{wait.data['last_observation']}".encode()).hexdigest()
    # The predecessor distinguishes a genuinely new blockage after recovery.
    kept = [item for item in notices if not item["acknowledged"]]
    kept += [item for item in notices if item["acknowledged"]][-16:]
    notices = [*kept, {"id": identity, "key": semantic, "generation": wait.generation,
                     "status": status, "detail": detail, "acknowledged": False, "at": now}]
    return replace(wait, data={**wait.data, "status": status, "notices": notices,
                               "last_observation": identity, "last_progress": now})


def notices(wait: Wait, seen: set[str]) -> list[str]:
    """Replay unacknowledged events once per monitor lifetime, including after restart."""
    lines = []
    for item in wait.data["notices"]:
        if item["acknowledged"] or item["id"] in seen:
            continue
        fields = {"issue": wait.issue, "id": item["id"], "state": item["status"],
                  "generation": item.get("generation"), "preview": item["detail"][:200],
                  "read": f"helio pr phase show --issue {wait.issue}",
                  "ack": f"helio pr phase ack --issue {wait.issue} --event {item['id']}"}
        lines.append(f"FOLLOWUP_PR_CUSTODY {json.dumps(fields)}")
        seen.add(item["id"])
    return lines
