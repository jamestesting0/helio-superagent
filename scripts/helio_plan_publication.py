"""Plan effects have their own journal in the issue operation database."""
from __future__ import annotations

from contextlib import closing, contextmanager
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import re
import sqlite3
import time
from typing import Callable, Iterator, Protocol


class Pending(RuntimeError):
    """A retained operation needs a later read before another write is safe."""
    def __init__(self, message: str, cause: str = "write_uncertain") -> None:
        super().__init__(message)
        self.cause = cause


class Conflict(ValueError):
    """The current remote state no longer matches the saved operation."""


class GitHub(Protocol):
    repo: str
    def run(self, argv: list[str], stdin: str | None = None) -> str: ...
    def issue(self, number: int) -> dict: ...
    def plan_comment(self, number: int) -> tuple[dict, int | None, str, str]: ...
    def cleanup_cancelled(self, number: int) -> None: ...
    def resume_command(self, operation: sqlite3.Row) -> str: ...


def state_dir() -> Path:
    return Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))


def connect() -> sqlite3.Connection:
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "issue-updates.sqlite"
    db = sqlite3.connect(path, timeout=1)
    path.chmod(0o600)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS plan_publications (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue INTEGER NOT NULL,
        kind TEXT NOT NULL, before_body TEXT NOT NULL, after_body TEXT NOT NULL,
        before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
        request_binding TEXT NOT NULL, revision INTEGER,
        comment_id INTEGER, url TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL CHECK(state IN ('prepared','writing','uncertain','confirmed','cancelled')),
        created_at INTEGER NOT NULL, last_checked_at INTEGER NOT NULL,
        completed_at INTEGER)""")
    db.commit()
    return db


@contextmanager
def scope(repo: str, issue: int, *, serialize: bool = True) -> Iterator[None]:
    """Bound source reads, issue locking, and writes by one operation deadline."""
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(f"{repo}:{issue}".encode()).hexdigest()
    with (directory / f"plan-{key}.lock").open("a") as lock:
        try:
            if serialize:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Pending("plan issue is busy; retry the retained request", "busy") from None
        previous = signal.getsignal(signal.SIGALRM)
        timer = signal.getitimer(signal.ITIMER_REAL)
        started = time.monotonic()

        def expired(_signal: int, _frame: object) -> None:
            raise Pending("plan operation exceeded its 45-second deadline", "deadline")

        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, min(45, timer[0]) if timer[0] else 45)
        try:
            yield
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
            if timer[0]:
                signal.setitimer(signal.ITIMER_REAL, max(0.001, timer[0] - (time.monotonic() - started)), timer[1])


def operation(gh: GitHub, issue: int, kind: str, before: str, after: str,
              comment_id: int | None = None, authorize: Callable[[], object] | None = None) -> str:
    """Persist intent before dispatch; an uncertain POST is never sent twice."""
    marker = re.search(r"<!-- helio-plan-data:([A-Za-z0-9+/=]+) -->\s*$", after)
    data = json.loads(base64.b64decode(marker[1])) if marker else {}
    semantic = data.get("publication_id") or after
    key = hashlib.sha256(json.dumps([gh.repo, issue, kind, comment_id,
                                    hashlib.sha256(before.encode()).hexdigest(), semantic],
                                   ensure_ascii=False).encode()).hexdigest()
    now = int(time.time())
    with closing(connect()) as db:
        db.execute("BEGIN IMMEDIATE")
        if kind == "comment":
            unresolved = db.execute("""SELECT id FROM plan_publications WHERE repo=? AND issue=?
                AND kind='comment' AND state IN ('writing','uncertain') AND id!=? LIMIT 1""",
                                    (gh.repo, issue, key)).fetchone()
            if unresolved:
                raise Pending(f"older plan operation {unresolved['id']} must be reconciled before replacement")
            if after != before:
                db.execute("""UPDATE plan_publications SET state='cancelled',completed_at=?
                    WHERE repo=? AND issue=? AND kind='comment' AND state='prepared' AND id!=?""",
                           (now, gh.repo, issue, key))
        db.execute("""INSERT OR IGNORE INTO plan_publications
            (id,repo,issue,kind,before_body,after_body,comment_id,state,created_at,last_checked_at,
             before_hash,after_hash,request_binding,revision)
            VALUES (?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?)""",
                   (key, gh.repo, issue, kind, before, after, comment_id, now, now,
                    hashlib.sha256(before.encode()).hexdigest(), hashlib.sha256(after.encode()).hexdigest(),
                    json.dumps(data.get("planning_request") or {}, sort_keys=True), data.get("revision")))
        db.commit()
        row = db.execute("SELECT * FROM plan_publications WHERE id=?", (key,)).fetchone()
        after = row["after_body"] or after
        db.execute("UPDATE plan_publications SET last_checked_at=? WHERE id=?", (now, key))
        db.commit()
        try:
            if kind == "label":
                present = any(label["name"] == "helio-plan" for label in gh.issue(issue).get("labels", []))
                desired = after == "present"
                if present != desired:
                    if desired:
                        gh.run(["gh", "label", "create", "helio-plan", "--repo", gh.repo, "--force",
                                "--description", "Helio plan mode: build only after approval"])
                    db.execute("UPDATE plan_publications SET state='writing' WHERE id=?", (key,))
                    db.commit()
                    gh.run(["gh", "issue", "edit", str(issue), "--repo", gh.repo,
                            "--add-label" if desired else "--remove-label", "helio-plan"])
                    present = any(label["name"] == "helio-plan" for label in gh.issue(issue).get("labels", []))
                    if present != desired:
                        raise Pending("plan label has not been verified")
                url = ""
            else:
                remote, current_id, url, body = gh.plan_comment(issue)
                if remote.get("state") != "OPEN":
                    raise Conflict("plan issue is no longer open")
                if comment_id and current_id != comment_id:
                    raise Conflict("plan comment identity changed")
                if body != after:
                    if row["state"] in ("writing", "uncertain"):
                        raise Pending("plan write remains uncertain; no second write was sent")
                    if current_id != comment_id or body != row["before_body"]:
                        raise Conflict("plan comment changed before publication")
                    if authorize:
                        try:
                            authorize()
                        except Pending:
                            raise
                        except RuntimeError as error:
                            raise Conflict(str(error)) from error
                        latest, latest_id, _, latest_body = gh.plan_comment(issue)
                        if latest.get("state") != "OPEN" or latest_id != comment_id or latest_body != row["before_body"]:
                            raise Conflict("plan issue or comment changed during source revalidation")
                    db.execute("UPDATE plan_publications SET state='writing' WHERE id=?", (key,))
                    db.commit()
                    endpoint = (f"repos/{gh.repo}/issues/comments/{comment_id}" if comment_id else
                                f"repos/{gh.repo}/issues/{issue}/comments")
                    reply = json.loads(gh.run(["gh", "api", endpoint, "--method",
                                              "PATCH" if comment_id else "POST", "--input", "-"],
                                             json.dumps({"body": after})))
                    url = reply["html_url"]
                    _, verified_id, verified_url, verified_body = gh.plan_comment(issue)
                    # Drops remove the marker; check the exact owned comment directly.
                    if not after.startswith("<!-- helio-plan v1 -->"):
                        comments = gh.issue(issue).get("comments") or []
                        matches = [c for c in comments if c.get("url") == url and c.get("body") == after]
                        if len(matches) != 1:
                            raise Pending("dropped plan comment has not been verified")
                    elif verified_body != after or verified_url != url or not verified_id:
                        raise Pending("plan comment has not been verified")
            stored_id = int(url.rsplit("#issuecomment-", 1)[1]) if "#issuecomment-" in url else comment_id
            db.execute("""UPDATE plan_publications SET state='confirmed',url=?,completed_at=?,comment_id=?
                          WHERE id=?""", (url, now, stored_id, key))
            db.commit()
            return url
        except (Conflict, Pending):
            raise
        except (RuntimeError, OSError, ValueError) as error:
            if getattr(error, "stage", "").endswith("_write") and not getattr(error, "uncertain", True):
                db.execute("UPDATE plan_publications SET state='prepared' WHERE id=?", (key,))
                db.commit()
                raise Conflict(str(error)) from error
            db.execute("""UPDATE plan_publications SET state='uncertain'
                          WHERE id=? AND state='writing'""", (key,))
            db.commit()
            raise Pending(f"plan operation retained: {error}") from error


def save(gh: GitHub, issue: int, comment_id: int | None, body: str,
         expected_body: str, authorize: Callable[[], object] | None = None) -> str:
    return operation(gh, issue, "comment", expected_body, body, comment_id, authorize)


def reconcile(gh: GitHub, issue: int) -> None:
    """Read every unresolved effect on this issue before preparing another."""
    with closing(connect()) as db:
        rows = db.execute("""SELECT * FROM plan_publications WHERE repo=? AND issue=?
            AND state IN ('prepared','writing','uncertain') ORDER BY created_at,id""", (gh.repo, issue)).fetchall()
        for row in rows:
            db.execute("UPDATE plan_publications SET last_checked_at=? WHERE id=?",
                       (int(time.time()), row["id"]))
            db.commit()
            if row["kind"] == "label":
                if row["state"] == "prepared":
                    continue
                operation(gh, issue, "label", row["before_body"], row["after_body"])
                continue
            remote, comment_id, url, body = gh.plan_comment(issue)
            if row["state"] == "prepared" and body != row["after_body"]:
                if remote.get("state") != "OPEN" or body != row["before_body"] or comment_id != row["comment_id"]:
                    db.execute("UPDATE plan_publications SET state='cancelled',completed_at=? WHERE id=?",
                               (int(time.time()), row["id"]))
                    db.commit()
                continue
            if remote.get("state") != "OPEN":
                raise Conflict("pending publication issue is no longer open")
            if body != row["after_body"]:
                if row["comment_id"]:
                    matches = [c for c in remote.get("comments", [])
                               if c.get("url", "").endswith(f"#issuecomment-{row['comment_id']}")
                               and c.get("body") == row["after_body"]]
                    if len(matches) == 1:
                        url = matches[0]["url"]
                    else:
                        raise Pending("saved plan write is unresolved; no second write was sent")
                else:
                    raise Pending("saved plan POST is unresolved; no second POST was sent")
            elif row["comment_id"] and comment_id != row["comment_id"]:
                raise Conflict("pending publication changed comment identity")
            db.execute("""UPDATE plan_publications SET state='confirmed',url=?,completed_at=?
                WHERE id=?""", (url, int(time.time()), row["id"]))
            db.commit()


def watch(repo: str, github: GitHub) -> str | None:
    """One oldest unresolved issue per existing monitor pass."""
    if not (state_dir() / "issue-updates.sqlite").is_file():
        return None
    with closing(connect()) as db:
        row = db.execute("""SELECT * FROM plan_publications WHERE repo=?
            AND state IN ('prepared','writing','uncertain') ORDER BY last_checked_at,id LIMIT 1""", (repo,)).fetchone()
        if row is None:
            return None
        issue = row["issue"]
        db.execute("""UPDATE plan_publications SET last_checked_at=? WHERE repo=? AND issue=?
            AND state IN ('prepared','writing','uncertain')""", (int(time.time()), repo, issue))
        db.commit()
    try:
        with scope(repo, issue):
            reconcile(github, issue)
            github.cleanup_cancelled(issue)
    except (Pending, Conflict, RuntimeError, OSError, ValueError) as error:
        return f"PLAN_PENDING issue={issue} cause=reconciliation detail={error} resume={gh_resume(github, row)}"
    with closing(connect()) as db:
        pending = db.execute("""SELECT * FROM plan_publications WHERE repo=? AND issue=?
            AND state IN ('prepared','writing','uncertain') ORDER BY created_at,id LIMIT 1""", (repo, issue)).fetchone()
    if pending:
        return f"PLAN_PENDING issue={issue} cause=prepared resume={gh_resume(github, pending)}"
    return f"PLAN_RECONCILED issue={issue}"


def gh_resume(github: GitHub, row: sqlite3.Row) -> str:
    if row["kind"] != "comment":
        return json.dumps(f"helio plan show --issue {row['issue']}")
    return json.dumps(github.resume_command(row))


def cancel_prepared(repo: str, issue: int, message: str | None = None) -> None:
    with closing(connect()) as db, db:
        db.execute("""UPDATE plan_publications SET state='cancelled',completed_at=?
            WHERE repo=? AND issue=? AND state='prepared'
            AND (? IS NULL OR json_extract(request_binding,'$.message')=?)""",
                   (int(time.time()), repo, issue, message, message))
