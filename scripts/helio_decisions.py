"""Scoped, sourced decisions with atomic supersession and recoverable history."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import sqlite3
import time


class Refused(Exception):
    """A decision violates the ledger contract."""


@dataclass(frozen=True, slots=True)
class Decision:
    repo: str
    kind: str
    topic: str
    scope: str
    statement: str
    quote: str
    author_id: str
    author_role: str
    channel_id: str
    message_id: str
    visibility: str
    action: str = "merge"
    until: int | None = None
    source: str = ""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    path.chmod(0o600)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, topic TEXT NOT NULL, scope TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, invalid_at INTEGER,
        superseded_by TEXT, data TEXT NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS decisions_scope ON decisions(repo, status, scope)")
    db.execute("""CREATE TABLE IF NOT EXISTS decision_events (
        sequence INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, event TEXT NOT NULL,
        message_id TEXT NOT NULL, created_at INTEGER NOT NULL)""")
    db.commit()
    return db


def overlaps(left: str, right: str) -> bool:
    return left in ("global", "project") or right in ("global", "project") or left == right


def active(db: sqlite3.Connection, repo: str, now: int | None = None) -> list[dict]:
    now = int(time.time()) if now is None else now
    result = []
    for row in db.execute("SELECT * FROM decisions WHERE status='active' AND (repo=? OR scope='global') ORDER BY created_at,id", (repo,)):
        data = json.loads(row["data"])
        if data["until"] is None or data["until"] > now:
            result.append({**dict(row), **data})
    return result


def record(db: sqlite3.Connection, decision: Decision, replaces: str | None = None) -> str:
    data = asdict(decision)
    identity = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:20]
    if db.execute("SELECT id FROM decisions WHERE id=?", (identity,)).fetchone():
        return identity
    now = int(time.time())
    db.execute("BEGIN IMMEDIATE")
    try:
        if db.execute("SELECT id FROM decisions WHERE id=?", (identity,)).fetchone():
            db.rollback()
            return identity
        related = [item for item in active(db, decision.repo) if overlaps(item["scope"], decision.scope)]
        old = next((item for item in related if item["id"] == replaces), None)
        if replaces and old is None:
            raise Refused("Replacement is not an active overlapping decision; read the current ledger.")
        for item in related:
            if item["topic"] == decision.topic and item["id"] != replaces:
                raise Refused(f"DECISION_CONFLICT {item['id']}: review the existing decision before recording.")
        if old:
            if old["author_role"] == "owner" and decision.author_role != "owner":
                raise Refused("Only the owner can replace an owner's decision.")
            if old["kind"] == "hold" and decision.author_id != old["author_id"] and decision.author_role != "owner":
                raise Refused("Only the hold author or owner can replace a hold.")
            if decision.author_role != "owner" and decision.until and (not old["until"] or decision.until < old["until"]):
                raise Refused("Only the owner can shorten another decision's lifetime through replacement.")
            db.execute("UPDATE decisions SET status='superseded',invalid_at=?,superseded_by=? WHERE id=?", (now, identity, replaces))
        db.execute("INSERT INTO decisions VALUES (?,?,?,?,?,?,NULL,NULL,?)",
                   (identity, decision.repo, decision.topic, decision.scope, "active", now, json.dumps(data)))
        db.execute("INSERT INTO decision_events(decision_id,event,message_id,created_at) VALUES (?,?,?,?)",
                   (identity, f"recorded replaces:{replaces}" if replaces else "recorded", decision.message_id, now))
        db.commit()
    except (Refused, sqlite3.Error):
        db.rollback()
        raise
    return identity


def revoke(db: sqlite3.Connection, identity: str, author: str, owner: str, message: str) -> None:
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT * FROM decisions WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise Refused("Unknown decision; list the ledger first.")
        data = json.loads(row["data"])
        if author not in (owner, data["author_id"]):
            raise Refused("Only the author or owner can undo this decision.")
        if row["status"] == "revoked":
            db.rollback()
            return
        if row["status"] != "active":
            raise Refused("The decision chain changed; review its history before undoing.")
        previous = db.execute("SELECT * FROM decisions WHERE superseded_by=?", (identity,)).fetchall()
        if len(previous) > 1:
            raise Refused("Multiple predecessor decisions need owner review.")
        now = int(time.time())
        db.execute("UPDATE decisions SET status='revoked',invalid_at=? WHERE id=?", (now, identity))
        for item in previous:
            db.execute("UPDATE decisions SET status='active',invalid_at=NULL,superseded_by=NULL WHERE id=?", (item["id"],))
        db.execute("INSERT INTO decision_events(decision_id,event,message_id,created_at) VALUES (?,?,?,?)", (identity, "revoked", message, now))
        db.commit()
    except (Refused, sqlite3.Error):
        db.rollback()
        raise


def holds(db: sqlite3.Connection, repo: str, issues: set[int], action: str) -> list[dict]:
    return [item for item in active(db, repo) if item["kind"] == "hold" and item["action"] == action
            and item["scope"] in {f"issue#{issue}" for issue in issues}]


def upkeep(db: sqlite3.Connection, repo: str, authorized: set[str], closed_lanes: set[str]) -> list[str]:
    """Expire bounded guidance and flag trust changes without erasing history."""
    now = int(time.time())
    reviews = []
    for row in db.execute("SELECT * FROM decisions WHERE status='active' AND repo=?", (repo,)).fetchall():
        data = json.loads(row["data"])
        expiry = data["until"] is not None and data["until"] <= now
        lane_closed = data["scope"].startswith("lane:") and data["scope"][5:] in closed_lanes
        if expiry or lane_closed:
            db.execute("UPDATE decisions SET status='expired',invalid_at=? WHERE id=?", (now, row["id"]))
            db.execute("INSERT INTO decision_events(decision_id,event,message_id,created_at) VALUES (?,?,?,?)",
                       (row["id"], "expired", "", now))
        elif data["author_id"] not in authorized:
            reviews.append(row["id"])
    db.commit()
    return reviews
