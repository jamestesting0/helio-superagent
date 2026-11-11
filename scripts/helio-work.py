#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Durable issue work authorization, bug-fix records and backstop event state, used by helio plan, pr submit,
bugfix start and the follow-up watcher."""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import datetime
import os
from pathlib import Path
import sqlite3

class Refused(Exception):
    """The issue has no usable recorded authorization."""


# A hold exists only when the requester's own words ask for it; each one stops PR publication.
HOLDS = ("no-commit", "no-push", "no-pr")
KINDS = ("request", "bug-report")


@dataclass(frozen=True, slots=True)
class Authorization:
    repo: str
    issue: int
    message: str
    channel: str
    author: str
    recorded_at: datetime.datetime
    source_hash: str | None = None
    kind: str = "request"
    holds: tuple[str, ...] = ()
    blocked: str | None = None


def connect() -> sqlite3.Connection:
    path = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))) / "work-authorizations.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS authorizations (
        repo TEXT NOT NULL, issue INTEGER NOT NULL, message TEXT NOT NULL, channel TEXT NOT NULL,
        author TEXT NOT NULL, recorded_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, source_hash TEXT,
        PRIMARY KEY(repo, issue, message))""")
    with db:
        db.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in db.execute("PRAGMA table_info(authorizations)")}
        for name, ddl in (("source_hash", "source_hash TEXT"), ("kind", "kind TEXT NOT NULL DEFAULT 'request'"),
                          ("holds", "holds TEXT NOT NULL DEFAULT ''"), ("blocked", "blocked TEXT")):
            if name not in columns:
                db.execute(f"ALTER TABLE authorizations ADD COLUMN {ddl}")
        db.execute("""CREATE TABLE IF NOT EXISTS bugfixes (
            repo TEXT NOT NULL, issue INTEGER NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
            message TEXT, channel TEXT, lane TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(repo, issue))""")
        db.execute("""CREATE TABLE IF NOT EXISTS work_events (
            repo TEXT NOT NULL, issue INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, emitted_at TEXT NOT NULL,
            PRIMARY KEY(repo, issue, kind))""")
        db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        # Confirmed bugs filed before this existed are never flagged retroactively.
        db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES ('bugfix_cutoff', ?)",
                   (datetime.datetime.now(datetime.timezone.utc).isoformat(),))
    return db


def record(authorization: Authorization) -> bool:
    with closing(connect()) as db, db:
        if authorization.kind not in KINDS or set(authorization.holds) - set(HOLDS):
            raise Refused("unknown authorization kind or hold")
        db.execute("""INSERT INTO authorizations(repo,issue,message,channel,author,recorded_at,source_hash,kind,holds)
                      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,issue,message) DO NOTHING""",
                   (authorization.repo, authorization.issue, authorization.message, authorization.channel,
                    authorization.author, authorization.recorded_at.isoformat(), authorization.source_hash,
                    authorization.kind, ",".join(authorization.holds)))
        channel, author, used = db.execute("SELECT channel,author,used FROM authorizations WHERE repo=? AND issue=? AND message=?",
                                          (authorization.repo, authorization.issue, authorization.message)).fetchone()
        if (channel, author) != (authorization.channel, authorization.author):
            raise Refused("recorded work source identity differs; inspect the original request")
        if not used:
            db.execute("UPDATE authorizations SET source_hash=? WHERE repo=? AND issue=? AND message=?",
                       (authorization.source_hash, authorization.repo, authorization.issue, authorization.message))
        return not used


def available(repo: str, issue: int, now: datetime.datetime, *, include_used: bool = False) -> Authorization:
    with closing(connect()) as db:
        rows = db.execute("""SELECT message,channel,author,recorded_at,source_hash,kind,holds,blocked FROM authorizations
                             WHERE repo=? AND issue=? AND (used=0 OR ?) ORDER BY recorded_at DESC""",
                          (repo, issue, include_used)).fetchall()
    for message, channel, author, recorded, fingerprint, kind, holds, blocked in rows:
        recorded_at = datetime.datetime.fromisoformat(recorded)
        if recorded_at <= now:
            return Authorization(repo, issue, message, channel, author, recorded_at, fingerprint, kind,
                                 tuple(hold for hold in holds.split(",") if hold), blocked)
    raise Refused(f"issue #{issue} has no recorded work request; inspect the existing conversation before asking for a new decision")


def consume(repo: str, issue: int, message: str) -> None:
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT used FROM authorizations WHERE repo=? AND issue=? AND message=?", (repo, issue, message)).fetchone()
        if row is None:
            raise Refused("work request was not recorded")
        if not row[0]:
            # Requests recorded after the published one, holds included, stay in force.
            db.execute("""UPDATE authorizations SET used=1 WHERE repo=? AND issue=? AND used=0 AND recorded_at <=
                          (SELECT recorded_at FROM authorizations WHERE repo=? AND issue=? AND message=?)""",
                       (repo, issue, repo, issue, message))


def block(repo: str, issue: int, reason: str, now: datetime.datetime) -> bool:
    """Park unfinished work on a genuine blocker; any newer authorization supersedes it."""
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        newest = db.execute("""SELECT message FROM authorizations WHERE repo=? AND issue=? AND used=0
                               ORDER BY recorded_at DESC LIMIT 1""", (repo, issue)).fetchone()
        if newest:
            db.execute("UPDATE authorizations SET blocked=? WHERE repo=? AND issue=? AND message=?",
                       (reason, repo, issue, newest[0]))
        changed = db.execute("""UPDATE bugfixes SET status='blocked',reason=?,updated_at=? WHERE repo=? AND issue=?
                                AND status IN ('starting','started','queued')""",
                             (reason, now.isoformat(), repo, issue)).rowcount
        return bool(newest) or bool(changed)


def bugfix(repo: str, issue: int) -> dict | None:
    with closing(connect()) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM bugfixes WHERE repo=? AND issue=?", (repo, issue)).fetchone()
        return dict(row) if row else None


def save_bugfix(repo: str, issue: int, now: datetime.datetime, **fields: str | None) -> None:
    allowed = {"route", "status", "reason", "message", "channel", "lane"}
    if set(fields) - allowed:
        raise ValueError(f"unknown bugfix fields: {sorted(set(fields) - allowed)}")
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""INSERT INTO bugfixes(repo,issue,route,status,created_at,updated_at) VALUES (?,?,?,?,?,?)
                      ON CONFLICT(repo,issue) DO NOTHING""",
                   (repo, issue, fields.get("route") or "autofix", fields.get("status") or "starting", now.isoformat(), now.isoformat()))
        for key, value in fields.items():
            db.execute(f"UPDATE bugfixes SET {key}=?,updated_at=? WHERE repo=? AND issue=?", (value, now.isoformat(), repo, issue))


def pending_work(repo: str) -> tuple[list[Authorization], list[dict]]:
    """Newest unused authorization per issue, and bug-fix rows that still expect a lane or capacity."""
    with closing(connect()) as db:
        db.row_factory = sqlite3.Row
        issues = [row[0] for row in db.execute("SELECT DISTINCT issue FROM authorizations WHERE repo=? AND used=0", (repo,))]
        fixes = [dict(row) for row in db.execute(
            "SELECT * FROM bugfixes WHERE repo=? AND status IN ('starting','started','queued') ORDER BY issue", (repo,))]
    future = datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    return [available(repo, issue, future) for issue in sorted(issues)], fixes


def known_issues(repo: str) -> set[int]:
    """Issues that already have any authorization or bug-fix record."""
    with closing(connect()) as db:
        return {row[0] for row in db.execute(
            "SELECT issue FROM authorizations WHERE repo=? UNION SELECT issue FROM bugfixes WHERE repo=?", (repo, repo))}


def cutoff() -> datetime.datetime:
    with closing(connect()) as db:
        return datetime.datetime.fromisoformat(db.execute("SELECT value FROM meta WHERE key='bugfix_cutoff'").fetchone()[0])


def should_emit(repo: str, issue: int, kind: str, state: str, now: datetime.datetime,
                every: datetime.timedelta = datetime.timedelta(hours=6)) -> bool:
    """Once per state change, and again after `every` while the same state stays unresolved."""
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT state,emitted_at FROM work_events WHERE repo=? AND issue=? AND kind=?", (repo, issue, kind)).fetchone()
        if row and row[0] == state and now - datetime.datetime.fromisoformat(row[1]) < every:
            return False
        db.execute("""INSERT INTO work_events(repo,issue,kind,state,emitted_at) VALUES (?,?,?,?,?)
                      ON CONFLICT(repo,issue,kind) DO UPDATE SET state=excluded.state,emitted_at=excluded.emitted_at""",
                   (repo, issue, kind, state, now.isoformat()))
        return True


def settle_events(repo: str, live: set[tuple[int, str]]) -> None:
    """Forget event state that no longer applies, so a recurrence is reported again."""
    with closing(connect()) as db, db:
        for issue, kind in db.execute("SELECT issue,kind FROM work_events WHERE repo=?", (repo,)).fetchall():
            if (issue, kind) not in live:
                db.execute("DELETE FROM work_events WHERE repo=? AND issue=? AND kind=?", (repo, issue, kind))
