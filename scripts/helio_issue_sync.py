"""Bounded issue reconciliation queue shared by workflow events and upkeep."""
from __future__ import annotations

import os
from contextlib import closing
from dataclasses import dataclass
import json
from pathlib import Path
import re
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


@dataclass(frozen=True, slots=True)
class SyncFailure:
    category: str
    stage: str
    detail: str
    uncertain: bool = False
    review_required: bool = False


def safe_detail(detail: str) -> str:
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
        if token := os.environ.get(name):
            detail = detail.replace(token, "[redacted]")
    detail = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+)\b", "[redacted]", detail)
    detail = re.sub(r"(?i)(authorization:\s*(?:bearer|token)\s+)\S+", r"\1[redacted]", detail)
    return detail[-1000:]


def failure_kind(detail: str) -> str:
    lowered = detail.lower()
    for tokens, kind in (
        (("issue_edited_outside_helio", "pr_edited_outside_helio", "reviewed body changed", "issue changed", "labels or state changed"), "human_edit_conflict"),
        (("issue_link_review", "implementation metadata", "closing-issue links disagree"), "review_required"),
        (("rate limit", "http 429"), "rate_limit"),
        (("http 401", "bad credentials", "not logged"), "authentication"),
        (("http 403", "forbidden", "resource not accessible"), "permission"),
        (("resolve", "dns", "tls", "ssl", "certificate", "connecting", "connection", "network", "timed out"), "transport"),
    ):
        if any(token in lowered for token in tokens):
            return kind
    return "unexpected"


def failure(detail: str) -> SyncFailure:
    stages = re.findall(r"(?m)^ISSUE_SYNC_STAGE ([a-z_]{1,50})$", detail)
    category = failure_kind(detail)
    review_required = category in ("human_edit_conflict", "review_required")
    stage = stages[-1] if stages else ("issue_review" if category == "human_edit_conflict" else
        "linked_relationship_review" if category == "review_required" else "comment_write" if "ISSUE_LOG_PENDING " in detail else "issue_sync")
    for line in reversed(detail.splitlines()):
        if line.startswith(("ISSUE_SYNC_FAILURE ", "ISSUE_SYNC_PARTIAL ")):
            try:
                saved = json.loads(line.partition(" ")[2])
            except json.JSONDecodeError:
                continue
            if isinstance(saved, dict) and all(isinstance(saved.get(key), str) for key in ("category", "stage", "detail")):
                return SyncFailure(saved["category"], saved["stage"], safe_detail(saved["detail"]), saved.get("uncertain") is True,
                                   review_required or saved["category"] in ("human_edit_conflict", "review_required"))
    message = "\n".join(line for line in detail.splitlines() if not line.startswith("ISSUE_SYNC_STAGE "))
    return SyncFailure(category, stage, safe_detail(message), review_required=review_required)


def _tracked(db: sqlite3.Connection) -> None:
    db.execute("CREATE TABLE IF NOT EXISTS tracked (repo TEXT, issue INTEGER, checked_at INTEGER DEFAULT 0, PRIMARY KEY(repo,issue))")
    columns = {row[1] for row in db.execute("PRAGMA table_info(tracked)")}
    for name, declaration in (("last_warning", "TEXT"), ("last_outcome", "TEXT"), ("failure_kind", "TEXT"), ("failure_stage", "TEXT"),
                              ("attempted_at", "INTEGER NOT NULL DEFAULT 0"), ("completed_at", "INTEGER NOT NULL DEFAULT 0"),
                              ("attempt_finished_at", "INTEGER NOT NULL DEFAULT 0"), ("next_attempt_at", "INTEGER NOT NULL DEFAULT 0"),
                              ("review_required", "INTEGER NOT NULL DEFAULT 0")):
        if name not in columns:
            db.execute(f"ALTER TABLE tracked ADD COLUMN {name} {declaration}")
    db.execute("UPDATE tracked SET next_attempt_at=checked_at+300 WHERE next_attempt_at=0 AND checked_at>0 AND review_required=0")


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
        _tracked(db)
        db.execute("UPDATE tracked SET review_required=0,checked_at=0,next_attempt_at=0 WHERE repo=? AND issue=?", (repo, issue))


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
        _tracked(db)
        db.execute("""INSERT INTO tracked(repo,issue,last_outcome) VALUES (?,?,'queued') ON CONFLICT(repo,issue)
            DO UPDATE SET checked_at=CASE WHEN review_required THEN checked_at ELSE 0 END,
            next_attempt_at=CASE WHEN review_required THEN next_attempt_at ELSE 0 END,
            last_outcome=CASE WHEN review_required THEN last_outcome ELSE 'queued' END""", (repo, issue))


def schedule(repo: str, issue: int) -> None:
    state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    enqueue(state, repo, issue)


def publication_complete(state: Path, repo: str, issue: int) -> None:
    """A bot-reviewed PR repair releases only its publication retry hold."""
    with closing(_reviews(state)) as db:
        _tracked(db)
        db.execute("""UPDATE tracked SET review_required=0,next_attempt_at=0,last_outcome='queued'
                      WHERE repo=? AND issue=? AND failure_stage LIKE 'pr_%'""", (repo, issue))
        db.commit()


def reconcile(state: Path, repo: str) -> list[str]:
    path = state / "issue-sync.sqlite"
    if not path.exists():
        return []
    warnings = []
    with closing(sqlite3.connect(path)) as db, db:
        _tracked(db)
        rows = db.execute("""SELECT issue FROM tracked WHERE repo=? AND review_required=0 AND next_attempt_at<=?
                             ORDER BY next_attempt_at,issue LIMIT 5""", (repo, int(time.time()))).fetchall()
        for row in rows:
            attempted = int(time.time())
            previous = db.execute("SELECT last_warning FROM tracked WHERE repo=? AND issue=?", (repo, row[0])).fetchone()[0]
            db.execute("""UPDATE tracked SET checked_at=?,attempted_at=?,attempt_finished_at=0,last_outcome='running',next_attempt_at=?
                          WHERE repo=? AND issue=?""", (attempted, attempted, attempted + 300, repo, row[0]))
            db.commit()
            try:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("helio-issue.py")), "sync", "--issue", str(row[0])],
                                        capture_output=True, text=True, timeout=120, env={**os.environ, "HELIO_SYNC_DIAGNOSTICS": "1"})
                if result.returncode:
                    problem = failure("\n".join((result.stdout, result.stderr)))
                    outcome, notice = "uncertain" if problem.uncertain else "failed", problem.detail
                    warnings.append(f"issue={row[0]}: {notice}")
                else:
                    notice = safe_detail("\n".join(line for line in result.stdout.splitlines()
                                       if line.startswith(("ISSUE_LINK_REVIEW ", "ISSUE_LOG_PENDING ", "ISSUE_UPDATE_PENDING "))))
                    outcome = "partial" if notice else "complete"
                    problem = failure(result.stdout) if notice else SyncFailure("", "", "")
                    if notice and notice != previous:
                        warnings.append(notice)
            except subprocess.TimeoutExpired as error:
                captured = "\n".join(stream.decode(errors="replace") if isinstance(stream, bytes) else stream
                                     for stream in (error.stdout, error.stderr) if stream)
                observed = failure(captured)
                problem = SyncFailure("transport", observed.stage, "reconciliation timed out; inspect pending operations", True,
                                      observed.review_required)
                outcome, notice = "uncertain", "reconciliation timed out; inspect pending operations"
                warnings.append(f"issue={row[0]}: {notice}")
            held = problem.review_required
            ended = int(time.time())
            db.execute("""UPDATE tracked SET last_outcome=?,last_warning=?,failure_kind=?,failure_stage=?,
                          attempt_finished_at=?,review_required=?,next_attempt_at=?,
                          completed_at=CASE WHEN ?='complete' THEN ? ELSE completed_at END
                          WHERE repo=? AND issue=?""",
                       (outcome, notice, problem.category, problem.stage, ended, held, 0 if held else attempted + 300,
                        outcome, ended, repo, row[0]))
            db.commit()
    return warnings
