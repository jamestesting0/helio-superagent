"""Bounded issue reconciliation queue shared by workflow events and upkeep."""
from __future__ import annotations

import os
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import time


# Same table as discord-inbound/conversations/issue-review.ts, which records discussion at reply time.
REVIEWS = """CREATE TABLE IF NOT EXISTS reviews (repo TEXT NOT NULL, issue INTEGER NOT NULL,
  discussed_at INTEGER NOT NULL DEFAULT 0, reviewed_at INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER NOT NULL DEFAULT 0, reason TEXT, PRIMARY KEY (repo, issue))"""
REMIND_AFTER = 600
REMIND_EVERY = 1800


def _reviews(state: Path) -> sqlite3.Connection:
    state.mkdir(parents=True, exist_ok=True)
    path = state / "issue-sync.sqlite"
    db = sqlite3.connect(path, timeout=5)
    path.chmod(0o600)
    db.execute(REVIEWS)
    return db


def mark_discussed(state: Path, repo: str, issue: int, at: int) -> None:
    with closing(_reviews(state)) as db, db:
        db.execute("""INSERT INTO reviews(repo,issue,discussed_at) VALUES (?,?,?) ON CONFLICT(repo,issue)
                      DO UPDATE SET discussed_at=max(discussed_at,excluded.discussed_at)""", (repo, issue, at))


def mark_reviewed(state: Path, repo: str, issue: int, at: int, reason: str | None = None) -> None:
    with closing(_reviews(state)) as db, db:
        db.execute("""INSERT INTO reviews(repo,issue,reviewed_at,reason) VALUES (?,?,?,?) ON CONFLICT(repo,issue)
                      DO UPDATE SET reviewed_at=max(reviewed_at,excluded.reviewed_at),reason=excluded.reason""",
                   (repo, issue, at, reason))


def reviewed_at(state: Path, repo: str, issue: int) -> int:
    with closing(_reviews(state)) as db:
        row = db.execute("SELECT reviewed_at FROM reviews WHERE repo=? AND issue=?", (repo, issue)).fetchone()
    return row[0] if row else 0


def reminders(state: Path, repo: str, now: int) -> list[str]:
    """Repeat ISSUE_REVIEW_DUE for discussion the description has not absorbed; keep those issues synced."""
    if not (state / "issue-sync.sqlite").exists():
        return []
    with closing(_reviews(state)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS tracked (repo TEXT, issue INTEGER, checked_at INTEGER DEFAULT 0, PRIMARY KEY(repo,issue))")
        db.execute("INSERT OR IGNORE INTO tracked(repo,issue) SELECT repo,issue FROM reviews WHERE repo=?", (repo,))
        rows = db.execute("""SELECT issue FROM reviews WHERE repo=? AND discussed_at>reviewed_at AND discussed_at<=?
                             AND (notified_at<discussed_at OR notified_at<=?) ORDER BY discussed_at LIMIT 20""",
                          (repo, now - REMIND_AFTER, now - REMIND_EVERY)).fetchall()
        db.executemany("UPDATE reviews SET notified_at=? WHERE repo=? AND issue=?", [(now, repo, row[0]) for row in rows])
    return [f'ISSUE_REVIEW_DUE issue=https://github.com/{repo}/issues/{row[0]} read="helio issue show {row[0]}"' for row in rows]


def enqueue(state: Path, repo: str, issue: int) -> None:
    state.mkdir(parents=True, exist_ok=True)
    path = state / "issue-sync.sqlite"
    with closing(sqlite3.connect(path)) as db, db:
        path.chmod(0o600)
        db.execute("CREATE TABLE IF NOT EXISTS tracked (repo TEXT, issue INTEGER, checked_at INTEGER DEFAULT 0, PRIMARY KEY(repo,issue))")
        db.execute("INSERT INTO tracked(repo,issue) VALUES (?,?) ON CONFLICT(repo,issue) DO UPDATE SET checked_at=0", (repo, issue))


def schedule(repo: str, issue: int) -> None:
    state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    enqueue(state, repo, issue)


def reconcile(state: Path, repo: str) -> list[str]:
    path = state / "issue-sync.sqlite"
    if not path.exists():
        return []
    warnings = []
    with closing(sqlite3.connect(path)) as db, db:
        if "last_warning" not in {row[1] for row in db.execute("PRAGMA table_info(tracked)")}:
            db.execute("ALTER TABLE tracked ADD COLUMN last_warning TEXT")
        rows = db.execute("SELECT issue FROM tracked WHERE repo=? AND checked_at<? ORDER BY checked_at,issue LIMIT 5", (repo, int(time.time()) - 300)).fetchall()
        for row in rows:
            db.execute("UPDATE tracked SET checked_at=? WHERE repo=? AND issue=?", (int(time.time()), repo, row[0]));db.commit()
            try:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("helio-issue.py")), "sync", "--issue", str(row[0])],
                                        capture_output=True, text=True, timeout=120)
                if result.returncode:
                    warnings.append(f"issue={row[0]}: {result.stderr.strip()[-200:]}")
                else:
                    notices = "\n".join(line for line in result.stdout.splitlines() if line.startswith("ISSUE_LINK_REVIEW "))
                    previous = db.execute("SELECT last_warning FROM tracked WHERE repo=? AND issue=?", (repo, row[0])).fetchone()[0]
                    if notices and notices != previous:
                        warnings.append(notices[:800])
                    db.execute("UPDATE tracked SET last_warning=? WHERE repo=? AND issue=?", (notices, repo, row[0]))
                    db.commit()
            except subprocess.TimeoutExpired:
                warnings.append(f"issue={row[0]}: reconciliation timed out; inspect pending operations")
    return warnings
