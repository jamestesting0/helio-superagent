#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Durable issue work authorization, used by helio plan and helio pr submit."""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import datetime
import os
from pathlib import Path
import sqlite3

class Refused(Exception):
    """The issue has no usable recorded authorization."""


@dataclass(frozen=True, slots=True)
class Authorization:
    repo: str
    issue: int
    message: str
    channel: str
    author: str
    recorded_at: datetime.datetime
    source_hash: str | None = None


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
        if "source_hash" not in {row[1] for row in db.execute("PRAGMA table_info(authorizations)")}:
            db.execute("ALTER TABLE authorizations ADD COLUMN source_hash TEXT")
    return db


def record(authorization: Authorization) -> bool:
    with closing(connect()) as db, db:
        db.execute("""INSERT INTO authorizations(repo,issue,message,channel,author,recorded_at,source_hash)
                      VALUES (?,?,?,?,?,?,?) ON CONFLICT(repo,issue,message) DO NOTHING""",
                   (authorization.repo, authorization.issue, authorization.message, authorization.channel,
                    authorization.author, authorization.recorded_at.isoformat(), authorization.source_hash))
        channel, author, used = db.execute("SELECT channel,author,used FROM authorizations WHERE repo=? AND issue=? AND message=?",
                                          (authorization.repo, authorization.issue, authorization.message)).fetchone()
        if (channel, author) != (authorization.channel, authorization.author):
            raise Refused("recorded work source identity differs; inspect the original request")
        if not used:
            db.execute("UPDATE authorizations SET source_hash=? WHERE repo=? AND issue=? AND message=?",
                       (authorization.source_hash, authorization.repo, authorization.issue, authorization.message))
        return not used


def available(repo: str, issue: int, now: datetime.datetime) -> Authorization:
    with closing(connect()) as db:
        rows = db.execute("SELECT message,channel,author,recorded_at,source_hash FROM authorizations WHERE repo=? AND issue=? AND used=0 ORDER BY recorded_at DESC",
                          (repo, issue)).fetchall()
    for message, channel, author, recorded, fingerprint in rows:
        recorded_at = datetime.datetime.fromisoformat(recorded)
        if recorded_at <= now:
            return Authorization(repo, issue, message, channel, author, recorded_at, fingerprint)
    raise Refused(f"issue #{issue} has no recorded work request; inspect the existing conversation before asking for a new decision")


def consume(repo: str, issue: int, message: str) -> None:
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT used FROM authorizations WHERE repo=? AND issue=? AND message=?", (repo, issue, message)).fetchone()
        if row is None:
            raise Refused("work request was not recorded")
        if not row[0]:
            db.execute("UPDATE authorizations SET used=1 WHERE repo=? AND issue=? AND used=0", (repo, issue))
