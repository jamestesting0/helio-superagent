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
import hashlib
import json
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
                          ("holds", "holds TEXT NOT NULL DEFAULT ''"), ("blocked", "blocked TEXT"),
                          ("blocked_question", "blocked_question TEXT"), ("blocked_kind", "blocked_kind TEXT")):
            if name not in columns:
                db.execute(f"ALTER TABLE authorizations ADD COLUMN {ddl}")
        db.execute("""CREATE TABLE IF NOT EXISTS bugfixes (
            repo TEXT NOT NULL, issue INTEGER NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
            message TEXT, channel TEXT, lane TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(repo, issue))""")
        bugfix_columns = {row[1] for row in db.execute("PRAGMA table_info(bugfixes)")}
        if "blocked_question" not in bugfix_columns:
            db.execute("ALTER TABLE bugfixes ADD COLUMN blocked_question TEXT")
        if "blocked_kind" not in bugfix_columns:
            db.execute("ALTER TABLE bugfixes ADD COLUMN blocked_kind TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS work_events (
            repo TEXT NOT NULL, issue INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, emitted_at TEXT NOT NULL,
            PRIMARY KEY(repo, issue, kind))""")
        db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("""CREATE TABLE IF NOT EXISTS grants (
            id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue INTEGER NOT NULL, question TEXT NOT NULL, option TEXT NOT NULL,
            permissions TEXT NOT NULL, author TEXT NOT NULL, question_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
            target_issue INTEGER)""")
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


def block(repo: str, issue: int, reason: str, now: datetime.datetime, question: str | None = None,
          kind: str | None = None) -> bool:
    """Park unfinished work on a genuine blocker; `unblock` or a newer authorization clears it."""
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        newest = db.execute("""SELECT message FROM authorizations WHERE repo=? AND issue=? AND used=0
                               ORDER BY recorded_at DESC LIMIT 1""", (repo, issue)).fetchone()
        if newest:
            db.execute("UPDATE authorizations SET blocked=?,blocked_question=?,blocked_kind=? WHERE repo=? AND issue=? AND message=?",
                       (reason, question, kind, repo, issue, newest[0]))
        changed = db.execute("""UPDATE bugfixes SET status='blocked',reason=?,blocked_question=?,blocked_kind=?,updated_at=?
                                WHERE repo=? AND issue=? AND (status IN ('starting','started','queued')
                                  OR (status='blocked' AND ? IS NOT NULL))""",
                             (reason, question, kind, now.isoformat(), repo, issue, question)).rowcount
        # (an already-blocked bug fix may gain the requester's question, so its answer clears it)
        return bool(newest) or bool(changed)


def unblock(repo: str, issue: int, now: datetime.datetime, named: str | None = None, kind: str | None = None) -> bool:
    """Clear recorded blockers, including one left on a request that submit already used; with `named`, only those
    recorded with that question. Holds are untouched."""
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        cleared = db.execute("""UPDATE authorizations SET blocked=NULL,blocked_question=NULL,blocked_kind=NULL
                                WHERE repo=? AND issue=? AND blocked IS NOT NULL AND (? IS NULL OR blocked_question=?)
                                AND (? IS NULL OR blocked_kind=?)""",
                             (repo, issue, named, named, kind, kind)).rowcount
        resumed = db.execute("""UPDATE bugfixes SET status='started',reason=NULL,blocked_question=NULL,blocked_kind=NULL,
                                updated_at=? WHERE repo=? AND issue=? AND status='blocked' AND (? IS NULL OR blocked_question=?)
                                AND (? IS NULL OR blocked_kind=?)""",
                             (now.isoformat(), repo, issue, named, named, kind, kind)).rowcount
        return bool(cleared or resumed)


def clarification(repo: str, issue: int) -> str | None:
    """The reason of a recorded worker clarification (not a decision) that the lead may answer, if any."""
    with closing(connect()) as db:
        row = db.execute("""SELECT blocked FROM authorizations WHERE repo=? AND issue=? AND blocked IS NOT NULL
                            AND blocked_kind='clarification' AND blocked_question IS NULL ORDER BY recorded_at DESC LIMIT 1""",
                         (repo, issue)).fetchone()
    return row[0] if row else None


GRANT_PERMISSIONS = ("create", "implement")


def create_grant(repo: str, issue: int, question: str, option: str, permissions: tuple[str, ...], author: str,
                 question_sha256: str, now: datetime.datetime) -> str:
    """Snapshot an owner's answer to a custody question as durable authority; question cleanup cannot remove it."""
    if not permissions or set(permissions) - set(GRANT_PERMISSIONS):
        raise Refused("unknown grant permission")
    identity = hashlib.sha256(json.dumps([repo, issue, question, option]).encode()).hexdigest()[:32]
    with closing(connect()) as db, db:
        db.execute("""INSERT INTO grants(id,repo,issue,question,option,permissions,author,question_sha256,created_at)
                      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING""",
                   (identity, repo, issue, question, option, ",".join(permissions), author, question_sha256, now.isoformat()))
        stored = db.execute("SELECT permissions,author,question_sha256 FROM grants WHERE id=?", (identity,)).fetchone()
        if stored != (",".join(permissions), author, question_sha256):
            raise Refused("a different grant was already recorded for this answer")
    return identity


def grant(identity: str) -> dict | None:
    with closing(connect()) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM grants WHERE id=?", (identity,)).fetchone()
        return {**dict(row), "permissions": tuple(row["permissions"].split(","))} if row else None


def target_grant(identity: str, issue: int) -> None:
    """Bind a creation grant to the issue it created, once."""
    with closing(connect()) as db, db:
        changed = db.execute("UPDATE grants SET target_issue=? WHERE id=? AND (target_issue IS NULL OR target_issue=?)",
                             (issue, identity, issue)).rowcount
        if changed != 1:
            raise Refused("grant is unknown or already bound to another issue")


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
