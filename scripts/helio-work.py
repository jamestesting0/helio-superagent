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
from typing import Final

MAX_AGE: Final = datetime.timedelta(days=7)


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


def connect() -> sqlite3.Connection:
    path = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))) / "work-authorizations.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS authorizations (
        repo TEXT NOT NULL, issue INTEGER NOT NULL, message TEXT NOT NULL, channel TEXT NOT NULL,
        author TEXT NOT NULL, recorded_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(repo, issue, message))""")
    return db


def record(authorization: Authorization) -> None:
    with closing(connect()) as db, db:
        try:
            db.execute("INSERT INTO authorizations(repo,issue,message,channel,author,recorded_at) VALUES (?,?,?,?,?,?)",
                       (authorization.repo, authorization.issue, authorization.message, authorization.channel,
                        authorization.author, authorization.recorded_at.isoformat()))
        except sqlite3.IntegrityError:
            raise Refused(f"work authorization for issue #{authorization.issue} message {authorization.message} was already recorded") from None


def available(repo: str, issue: int, now: datetime.datetime) -> str:
    with closing(connect()) as db:
        rows = db.execute("SELECT message,recorded_at FROM authorizations WHERE repo=? AND issue=? AND used=0 ORDER BY recorded_at DESC",
                          (repo, issue)).fetchall()
    for message, recorded in rows:
        if datetime.timedelta(0) <= now - datetime.datetime.fromisoformat(recorded) <= MAX_AGE:
            return message
    raise Refused(f"issue #{issue} needs an approved plan or an unused work authorization recorded within 7 days")


def consume(repo: str, issue: int, message: str) -> None:
    with closing(connect()) as db, db:
        if db.execute("UPDATE authorizations SET used=1 WHERE repo=? AND issue=? AND message=? AND used=0",
                      (repo, issue, message)).rowcount != 1:
            raise Refused("work authorization was already used; inspect the existing PR before authorizing again")
