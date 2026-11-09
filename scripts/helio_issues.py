"""Issue body projections and durable, resumable GitHub updates."""
from __future__ import annotations

import datetime
from contextlib import closing, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import time

FORMAT = runpy.run_path(str(Path(__file__).with_name("helio_issue_format.py")))
START, END, HASH = (FORMAT[key] for key in ("START", "END", "HASH"))
split, render, without_timestamp, only_status_refreshed = (FORMAT[key] for key in (
    "split", "render", "without_timestamp", "only_status_refreshed"))
SYNC = runpy.run_path(str(Path(__file__).with_name("helio_issue_sync.py")))


class Refused(RuntimeError):
    """An issue edit cannot safely proceed."""
    def __init__(self, message: str, stage: str = "issue_review", uncertain: bool = False) -> None:
        super().__init__(message)
        self.stage = stage
        self.uncertain = uncertain

def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def metadata(issue: dict) -> dict:
    return {"state": issue.get("state"), "state_reason": issue.get("state_reason"),
            "labels": sorted(label["name"] for label in issue.get("labels") or [])}


def intended_metadata(change: dict) -> dict:
    intended: dict = {}
    if change.get("labels") is not None:
        intended["labels"] = sorted(change["labels"])
    if change.get("close"):
        intended.update(state="closed", state_reason=change["close"])
    return intended


def run(argv: list[str], stdin: str | None = None) -> str:
    method = "GET" if argv[1] == "api" or argv[1:3] in (["issue", "view"], ["pr", "view"]) else "UNKNOWN"
    explicit = next((part.partition("=")[2] for part in argv if part.startswith("--method=")), None)
    if explicit is not None:
        method = explicit.upper()
    elif "--method" in argv or "-X" in argv:
        option = "--method" if "--method" in argv else "-X"
        method = argv[argv.index(option) + 1].upper()
    elif any(part.startswith("-X") for part in argv):
        method = next(part[2:].upper() for part in argv if part.startswith("-X"))
    elif argv[1] == "api" and any(part.split("=", 1)[0] in ("--input", "--field", "--raw-field") or part.startswith(("-f", "-F")) for part in argv):
        method = "POST"
    readonly = method in ("GET", "HEAD")
    endpoint = next((part for part in argv if part.startswith("repos/")), "")
    resource = "comment" if "/comments" in endpoint else "issue_timeline" if endpoint.endswith("/timeline") else \
        "issue" if "/issues" in endpoint or argv[1:3] == ["issue", "view"] else \
        "pr" if argv[1:3] == ["pr", "view"] else "identity" if argv[1:3] == ["api", "user"] else "github"
    stage = resource + ("_read" if readonly else "_write")
    if os.environ.get("HELIO_SYNC_DIAGNOSTICS") == "1":
        print(f"ISSUE_SYNC_STAGE {stage}", file=sys.stderr, flush=True)
    deadline = time.monotonic() + 45
    attempts = 3 if readonly else 1
    detail = "GitHub request timed out; inspect its saved operation before retrying"
    for attempt in range(attempts):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            result = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=remaining)
        except subprocess.TimeoutExpired as error:
            raise Refused("GitHub request timed out; inspect its saved operation before retrying", stage, not readonly) from error
        if result.returncode == 0:
            return result.stdout
        detail = (result.stderr or result.stdout).strip()[-2000:] or "GitHub unavailable"
        if SYNC["failure_kind"](detail) != "transport" or attempt + 1 == attempts:
            break
        delay = min(2 ** attempt, deadline - time.monotonic())
        if delay <= 0:
            break
        time.sleep(delay)
    raise Refused(detail, stage, not readonly and SYNC["failure_kind"](detail) == "transport")


class Issues:
    def __init__(self, repo: str, state: Path, command=run):
        self.repo, self.state, self.command = repo, state, command

    def api(self, suffix: str, data: dict | None = None) -> dict | list:
        argv = ["gh", "api", f"repos/{self.repo}/{suffix}"]
        if data is not None:
            argv += ["--method", "PATCH", "--input", "-"]
        return json.loads(self.command(argv, json.dumps(data) if data is not None else None))

    def get(self, issue: int) -> dict:
        return self.api(f"issues/{issue}")

    @contextmanager
    def operations(self):
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / "issue-updates.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = self.state / "issue-updates.sqlite"
            with closing(sqlite3.connect(path)) as db, db:
                path.chmod(0o600)
                db.execute("""CREATE TABLE IF NOT EXISTS operations (
                    id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue INTEGER NOT NULL,
                    before_body TEXT NOT NULL, after_body TEXT NOT NULL, change TEXT NOT NULL,
                    written INTEGER NOT NULL DEFAULT 0, commented INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0)""")
                columns = {row[1] for row in db.execute("PRAGMA table_info(operations)")}
                if "before_meta" not in columns:
                    db.execute("ALTER TABLE operations ADD COLUMN before_meta TEXT")
                if "completed_at" not in columns:
                    # Retention ages finished operations from here; ones finished before this column start their clock now.
                    db.execute("ALTER TABLE operations ADD COLUMN completed_at INTEGER")
                    db.execute("UPDATE operations SET completed_at=? WHERE completed IN (1,2)", (int(time.time()),))
                for operation, change in db.execute("SELECT id,change FROM operations WHERE completed=0").fetchall():
                    if json.loads(change).get("reopen"):
                        db.execute("UPDATE operations SET completed=2,completed_at=? WHERE id=?", (int(time.time()), operation))
                db.commit()
                yield db

    def update(self, issue: int, change: dict) -> str:
        """Persist intended operations before writes; an interrupted earlier operation on the issue finishes first."""
        if change.get("reopen"):
            raise Refused("Closed issues stay closed; create a linked follow-up issue for new work.")
        with self.operations() as db:
            for pending, pending_change in db.execute(
                    "SELECT id,change FROM operations WHERE repo=? AND issue=? AND completed=0 ORDER BY rowid",
                    (self.repo, issue)).fetchall():
                if json.loads(pending_change).get("kind") != "pr":
                    self._finish(db, issue, pending, json.loads(pending_change))
            current = self.get(issue)
            body = current.get("body") or ""
            # A plain status sync is tied to the description it starts from; an intent (note, body, close, labels) is not,
            # so repeating one never posts its note twice.
            intent = any(change.get(key) for key in ("body", "note", "close")) or change.get("labels") is not None
            operation = digest(json.dumps([self.repo, issue, change] + ([] if intent else [digest(body)]), sort_keys=True))
            old = db.execute("SELECT after_body,completed,change FROM operations WHERE id=?", (operation,)).fetchone()
            if old:
                if old[1] == 2:
                    raise Refused("This operation was cancelled locally; review the current issue before a new update.")
                if old[2] == "":
                    return operation  # finished long enough ago that retention erased its body; it stays done
                if body != old[0] and not only_status_refreshed(body, old[0]):
                    raise Refused("Issue changed after the previous update; read and adopt its current body.")
                return operation
            content, recorded = split(body)
            if not FORMAT["valid"](body) and (change.get("adopt") != digest(body) or change.get("body") is None):
                raise Refused(f"ISSUE_EDITED_OUTSIDE_HELIO reviewed_sha256={digest(body)}; review ambiguous body markers.")
            unsigned = body[:HASH.search(body).start()] if HASH.search(body) else body
            expected = change.get("adopt")
            if (recorded and digest(unsigned) != recorded) or (not recorded and change.get("body") is not None):
                if expected != digest(body):
                    raise Refused(f"ISSUE_EDITED_OUTSIDE_HELIO reviewed_sha256={digest(body)}; read then adopt this exact body.")
            if expected and expected != digest(body):
                raise Refused("Reviewed body changed; read it again.")
            if change.get("body") is not None:
                if change["body"].strip() != content.strip() and not change.get("note"):
                    raise Refused("ISSUE_NOTE_REQUIRED: a description change needs --note-file with a short public summary of what changed")
                content = change["body"]
            observed = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            closed = change.get("close")
            status = f"Closed: {closed}" if closed else current.get("state", "unknown")
            status += " · " + change.get("projection", "implementation/live state unverified")
            after = render(content, {"status": status, "note": change.get("note", ""), "observed": observed,
                                    "summary": change.get("summary") or current.get("title") or "See current scope below.",
                                    "links": change.get("links") or [f"https://github.com/{self.repo}/issues/{issue}"],
                                    "delivery": change.get("delivery", [])})
            if not intent and recorded and without_timestamp(after) == without_timestamp(body):
                return operation
            db.execute("INSERT INTO operations(id,repo,issue,before_body,after_body,change,before_meta) VALUES (?,?,?,?,?,?,?)",
                       (operation, self.repo, issue, body, after, json.dumps(change), json.dumps(metadata(current))))
            db.commit()
            return self._finish(db, issue, operation, change)

    def resume(self, operation: str) -> tuple[int, str]:
        with self.operations() as db:
            row = db.execute("SELECT issue,change,completed FROM operations WHERE id=? AND repo=?", (operation, self.repo)).fetchone()
            if row is None:
                raise Refused("Unknown operation.")
            return row[0], self._finish(db, row[0], operation, json.loads(row[1]) if row[2] == 0 else {})

    def resource(self, operation: str) -> str:
        with self.operations() as db:
            row = db.execute("SELECT change FROM operations WHERE id=? AND repo=?", (operation, self.repo)).fetchone()
            return json.loads(row[0]).get("kind", "issue") if row and row[0] else "issue"

    def publications(self, issue: int) -> None:
        """Finish pending publication work in the bot's normal reconciliation cycle."""
        with self.operations() as db:
            for operation, raw in db.execute("SELECT id,change FROM operations WHERE repo=? AND issue=? AND completed=0 ORDER BY rowid",
                                              (self.repo, issue)).fetchall():
                change = json.loads(raw)
                if change.get("kind") == "pr":
                    self._finish(db, issue, operation, change)

    def cancel(self, operation: str) -> None:
        """Waits for any update in flight, so a cancel is never reported for an operation that then completes."""
        with self.operations() as db:
            row = db.execute("SELECT completed FROM operations WHERE id=? AND repo=?", (operation, self.repo)).fetchone()
            if row is None:
                raise Refused("Unknown operation.")
            if row[0] == 1:
                raise Refused("Operation already completed; nothing to cancel. Review the issue and make a new update if needed.")
            db.execute("UPDATE operations SET completed=2,completed_at=? WHERE id=?", (int(time.time()), operation))
            db.commit()

    def _finish(self, db: sqlite3.Connection, issue: int, operation: str, change: dict) -> str:
        if change.get("kind") == "pr":
            publication = runpy.run_path(str(Path(__file__).with_name("helio_pr_publication.py")))
            publication["finish"](self, db, operation, change)
            return operation
        before, after, written, commented, completed, before_meta = db.execute(
            "SELECT before_body,after_body,written,commented,completed,before_meta FROM operations WHERE id=?", (operation,)).fetchone()
        if completed == 2:
            raise Refused("This operation was cancelled locally; review the current issue before a new update.")
        if completed == 1:
            return operation
        # This re-fetch narrows the external edit race; GitHub provides no body CAS here.
        latest = self.get(issue)
        if latest.get("body", "") not in (before, after):
            raise Refused("Issue changed during the update; preserve it and review the saved operation.")
        if not written:
            intended = intended_metadata(change)
            now = metadata(latest)
            landed = latest.get("body", "") == after and all(now[key] == value for key, value in intended.items())
            untouched = before_meta is not None and all(now[key] == json.loads(before_meta)[key] for key in intended)
            if not landed and intended and not untouched:
                raise Refused("Issue labels or state changed during the update; preserve them and review the saved operation.")
            if not landed:
                data = {"body": after}
                if change.get("labels") is not None:
                    data["labels"] = change["labels"]
                if change.get("close"):
                    data.update(state="closed", state_reason=change["close"])
                self.api(f"issues/{issue}", data)
            db.execute("UPDATE operations SET written=1 WHERE id=?", (operation,));db.commit()
        if change.get("note") and not commented:
            marker = f"<!-- helio-issue-operation:{operation} -->"
            comments = json.loads(self.command(["gh", "api", "--paginate", f"repos/{self.repo}/issues/{issue}/comments", "--slurp"]))
            seen = any(marker in (comment.get("body") or "") for page in comments for comment in page)
            if not seen:
                text = FORMAT["POSTS"]["update_note"](change["note"]) + f"\n<!-- helio-issue-log -->\n{marker}"
                self.command(["gh", "api", f"repos/{self.repo}/issues/{issue}/comments", "--method", "POST", "--input", "-"], json.dumps({"body": text}))
            db.execute("UPDATE operations SET commented=1 WHERE id=?", (operation,));db.commit()
        db.execute("UPDATE operations SET completed=1,completed_at=? WHERE id=?", (int(time.time()), operation));db.commit()
        return operation

    def log_milestones(self, issue: int, events: list[tuple[str, str, float]], now: float | None = None) -> list[str]:
        """Post one public progress comment for milestones that happened after this log began."""
        now = datetime.datetime.now(datetime.timezone.utc).timestamp() if now is None else now
        self.state.mkdir(parents=True, exist_ok=True)
        path = self.state / "issue-updates.sqlite"
        with closing(sqlite3.connect(path)) as db, db:
            path.chmod(0o600)
            db.execute("CREATE TABLE IF NOT EXISTS milestones (repo TEXT, issue INTEGER, key TEXT, PRIMARY KEY(repo,issue,key))")
            db.execute("CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value REAL)")
            db.execute("INSERT OR IGNORE INTO meta VALUES ('milestones_since', ?)", (now,))
            since = db.execute("SELECT value FROM meta WHERE name='milestones_since'").fetchone()[0]
            new = [event for event in events if not db.execute(
                "SELECT 1 FROM milestones WHERE repo=? AND issue=? AND key=?", (self.repo, issue, event[0])).fetchone()]
            fresh = [text for _, text, at in new if at >= since]
            if fresh:
                marker = f"<!-- helio-issue-log:{digest(json.dumps([self.repo, issue, [key for key, _, _ in new]]))} -->"
                comments = json.loads(self.command(["gh", "api", "--paginate", f"repos/{self.repo}/issues/{issue}/comments", "--slurp"]))
                if not any(marker in (comment.get("body") or "") for page in comments for comment in page):
                    text = "**Progress:** " + "; ".join(fresh) + f"\n{marker}"
                    self.command(["gh", "api", f"repos/{self.repo}/issues/{issue}/comments", "--method", "POST", "--input", "-"], json.dumps({"body": text}))
            db.executemany("INSERT OR IGNORE INTO milestones VALUES (?,?,?)", [(self.repo, issue, key) for key, _, _ in new])
        return fresh
