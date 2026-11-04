"""Issue body projections and durable, resumable GitHub updates."""
from __future__ import annotations

import datetime
from contextlib import closing
import fcntl
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
from typing import TypedDict

START = "<!-- helio-status:start -->"
END = "<!-- helio-status:end -->"
HASH = re.compile(r"\n?<!-- helio-body-sha256:([0-9a-f]{64}) -->\s*\Z")


class Refused(Exception):
    """An issue edit cannot safely proceed."""

class StatusBlock(TypedDict):
    status: str
    note: str
    observed: str
    summary: str
    links: list[str]

def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def split(body: str) -> tuple[str, str | None]:
    marker = HASH.search(body)
    unsigned = body[:marker.start()] if marker else body
    content = unsigned.split(END, 1)[1].lstrip("\n") if unsigned.startswith(START) and END in unsigned else unsigned
    return content.rstrip(), marker.group(1) if marker else None


def render(content: str, block: StatusBlock) -> str:
    note = " ".join(block["note"].split())
    summary = " ".join(block["summary"].split())
    body = f"{START}\n**Status:** {block['status']}\n**In short:** {summary}\n**Links:** {' · '.join(block['links'])}\n**Updated:** {block['observed']}" + (f" · {note}" if note else "") + f"\n{END}\n\n{content.rstrip()}"
    return body + f"\n<!-- helio-body-sha256:{digest(body)} -->"


def run(argv: list[str], stdin: str | None = None) -> str:
    result = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise Refused((result.stderr or result.stdout).strip()[-300:] or "GitHub unavailable")
    return result.stdout


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

    def update(self, issue: int, change: dict) -> str:
        """Persist intended operations before writes; resume the same operation after failure."""
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
                operation = digest(json.dumps([self.repo, issue, change], sort_keys=True))
                old = db.execute("SELECT before_body,after_body,written,commented,completed FROM operations WHERE id=?", (operation,)).fetchone()
                if old and old[4]:
                    if old[4] == 2:
                        raise Refused("This operation was cancelled locally; review the current issue before a new update.")
                    if (self.get(issue).get("body") or "") != old[1]:
                        raise Refused("Issue changed after the previous update; read and adopt its current body.")
                    return operation
                current = self.get(issue)
                body = current.get("body") or ""
                if old is None:
                    active = db.execute("SELECT id FROM operations WHERE repo=? AND issue=? AND completed=0", (self.repo, issue)).fetchone()
                    if active:
                        raise Refused(f"Pending issue update {active[0]}; resume it before another change.")
                    content, recorded = split(body)
                    unsigned = body[:HASH.search(body).start()] if HASH.search(body) else body
                    expected = change.get("adopt")
                    if (recorded and digest(unsigned) != recorded) or (not recorded and change.get("body") is not None):
                        if expected != digest(body):
                            raise Refused(f"ISSUE_EDITED_OUTSIDE_HELIO reviewed_sha256={digest(body)}; read then adopt this exact body.")
                    if expected and expected != digest(body):
                        raise Refused("Reviewed body changed; read it again.")
                    if change.get("body") is not None:
                        content = change["body"]
                    observed = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
                    closed = change.get("close")
                    status = f"Closed: {closed}" if closed else ("open" if change.get("reopen") else current.get("state", "unknown"))
                    status += " · " + change.get("projection", "implementation/live state unverified")
                    after = render(content, {"status": status, "note": change.get("note", ""), "observed": observed,
                                            "summary": change.get("summary") or current.get("title") or "See current scope below.",
                                            "links": change.get("links") or [f"https://github.com/{self.repo}/issues/{issue}"]})
                    db.execute("INSERT INTO operations(id,repo,issue,before_body,after_body,change) VALUES (?,?,?,?,?,?)",
                               (operation, self.repo, issue, body, after, json.dumps(change)))
                    db.commit()
                    old = (body, after, 0, 0, 0)
                before, after, written, commented, _ = old
                # This re-fetch narrows the external edit race; GitHub provides no body CAS here.
                latest = self.get(issue)
                if latest.get("body", "") not in (before, after):
                    raise Refused("Issue changed during the update; preserve it and review the saved operation.")
                if not written:
                    data = {"body": after}
                    if change.get("labels") is not None:
                        data["labels"] = change["labels"]
                    if change.get("close"):
                        data.update(state="closed", state_reason=change["close"])
                    if change.get("reopen"):
                        data.update(state="open", state_reason="reopened")
                    self.api(f"issues/{issue}", data)
                    db.execute("UPDATE operations SET written=1 WHERE id=?", (operation,));db.commit()
                if change.get("note") and not commented:
                    marker = f"<!-- helio-issue-operation:{operation} -->"
                    comments = json.loads(self.command(["gh", "api", "--paginate", f"repos/{self.repo}/issues/{issue}/comments", "--slurp"]))
                    seen = any(marker in (comment.get("body") or "") for page in comments for comment in page)
                    if not seen:
                        text = f"Description updated: {change['note']}\n{marker}"
                        self.command(["gh", "api", f"repos/{self.repo}/issues/{issue}/comments", "--method", "POST", "--input", "-"], json.dumps({"body": text}))
                    db.execute("UPDATE operations SET commented=1 WHERE id=?", (operation,));db.commit()
                db.execute("UPDATE operations SET completed=1 WHERE id=?", (operation,));db.commit()
                return operation
