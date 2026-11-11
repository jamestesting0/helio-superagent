"""Bot-owned PR publication recovery using the existing issue operation journal."""
from __future__ import annotations

from contextlib import AbstractContextManager
import hashlib
import json
from pathlib import Path
import re
import runpy
import sqlite3
import tempfile
import time
from typing import Callable, Protocol
from urllib.parse import quote

BODY = runpy.run_path(str(Path(__file__).with_name("helio_github_body.py")))
LINK = runpy.run_path(str(Path(__file__).with_name("helio_issue_link.py")))
AUTHORITY = runpy.run_path(str(Path(__file__).with_name("helio_pr_authority.py")))
FINALIZE = runpy.run_path(str(Path(__file__).with_name("helio_pr_finalize.py")))
SYNC = runpy.run_path(str(Path(__file__).with_name("helio_issue_sync.py")))
VERIFICATION = runpy.run_path(str(Path(__file__).with_name("helio_pr_verification.py")))


class Refused(ValueError):
    def __init__(self, message: str, stage: str = "pr_review", uncertain: bool = False) -> None:
        super().__init__(message)
        self.stage, self.uncertain = stage, uncertain


class Store(Protocol):
    repo: str
    state: Path
    def command(self, argv: list[str], stdin: str | None = None) -> str: ...
    def operations(self) -> AbstractContextManager[sqlite3.Connection]: ...


def view(store: Store, url: str) -> dict:
    return json.loads(store.command(["gh", "pr", "view", url, "--repo", store.repo, "--json",
        "state,headRefOid,headRefName,baseRefName,isCrossRepository,body,closingIssuesReferences"]))


def identity(pull: dict, change: dict, landed: bool = False) -> None:
    if pull.get("state") not in (("OPEN", "CLOSED", "MERGED") if landed else ("OPEN",)) or (
            pull.get("headRefName"), pull.get("baseRefName"), pull.get("isCrossRepository")) != (change["branch"], "main", False):
        raise Refused("The canonical PR changed identity; the bot must inspect its current task.")
    if pull.get("headRefOid") != change["head"]:
        raise Refused("PR head changed; refresh the verified report under the existing task authority.")


def relationship(pull: dict, issue: int) -> None:
    if len(LINK["MARKER"].findall(pull.get("body") or "")) != 1:
        raise Refused("PR implementation metadata is ambiguous; the bot must review its current body.")
    try:
        marker = LINK["parse"](pull.get("body") or "")
        if marker is None or marker.issue != issue:
            raise Refused("PR implementation metadata does not match this task.")
        LINK["require_link"](pull["body"], {item["number"] for item in pull.get("closingIssuesReferences", [])}, "main")
    except LINK["Refused"] as error:
        raise Refused(str(error), "pr_relationship", True) from error


def canonical(store: Store, change: dict, attempted: bool) -> str | None:
    pulls = json.loads(store.command(["gh", "pr", "list", "--repo", store.repo, "--head", change["branch"],
                                      "--base", "main", "--state", "all" if attempted else "open", "--json", "url"]))
    if len(pulls) <= 1:
        return pulls[0]["url"] if pulls else None
    matches, opened = [], []
    for item in pulls:
        pull = view(store, item["url"])
        if pull.get("headRefName") != change["branch"] or pull.get("baseRefName") != "main" or pull.get("isCrossRepository"):
            continue
        if pull.get("state") == "OPEN":
            opened.append(item["url"])
        try:
            marker = LINK["parse"](pull.get("body") or "")
            if pull.get("headRefOid") == change["head"] and marker and marker.issue == change["issue"] and (
                    BODY["merge"](pull["body"], change["generated"]) == pull["body"]):
                matches.append(item["url"])
        except (LINK["Refused"], BODY["Refused"]):
            continue
    if len(matches) == 1:
        return matches[0]
    if not matches and len(opened) == 1:
        return opened[0]
    raise Refused("Canonical PR history is ambiguous; the bot must inspect its recorded task.")


def write(store: Store, change: dict, body: str, create: bool) -> str:
    with tempfile.TemporaryDirectory(prefix="helio-pr-publication-") as temporary:
        path = Path(temporary) / "body.md"
        path.write_text(body)
        if create:
            return store.command(["gh", "pr", "create", "--repo", store.repo, "--base", "main",
                "--head", change["branch"], "--title", change["title"], "--body-file", str(path),
                *(["--label", ",".join(change["labels"])] if change["labels"] else [])])
        store.command(["gh", "pr", "edit", change["url"], "--repo", store.repo, "--body-file", str(path)])
        return change["url"]


def write_error(db: sqlite3.Connection, operation: str, error: RuntimeError | OSError) -> tuple[str, str | None]:
    detail = SYNC["safe_detail"](str(error))
    rejected = re.search(r"\bHTTP (400|401|403|404|410|422)\b", detail)
    if rejected:
        db.execute("UPDATE operations SET written=0 WHERE id=?", (operation,)); db.commit()
    return detail, rejected[1] if rejected else None


def finish(store: Store, db: sqlite3.Connection, operation: str, change: dict,
           authorize: Callable[[], None] | None = None) -> str:
    if change.get("verification") is not None:
        VERIFICATION["bound"](db, store.repo, change)
    before, after, attempted, completed = db.execute(
        "SELECT before_body,after_body,written,completed FROM operations WHERE id=?", (operation,)).fetchone()
    if completed == 2:
        raise Refused("Publication was cancelled locally; inspect the recorded task before continuing.")
    if completed == 1:
        return change["url"]
    permitted = lambda: AUTHORITY["publication"](change, store.command, store.repo, authorize)
    if not change.get("url"):
        found = canonical(store, change, bool(attempted))
        if found:
            change["url"] = found
        else:
            permitted()
            remote = store.command(["gh", "api", f"repos/{store.repo}/git/ref/heads/{quote(change['branch'], safe='/')}",
                                    "--jq", ".object.sha"]).strip()
            if remote != change["head"]:
                raise Refused("Task branch advanced; the bot must refresh its verified publication.")
            db.execute("UPDATE operations SET written=1 WHERE id=?", (operation,)); db.commit()
            try:
                change["url"] = write(store, change, after, True)
            except (RuntimeError, OSError) as error:
                detail, rejected = write_error(db, operation, error)
                if rejected == "422":
                    found = canonical(store, change, False)
                    if found:
                        change["url"] = found
                    else:
                        raise Refused(detail, "pr_input", False) from error
                else:
                    raise Refused(detail, "pr_write", not bool(rejected)) from error
        if not re.fullmatch(rf"https://github\.com/{re.escape(store.repo)}/pull/[1-9]\d*", change["url"]):
            raise Refused("GitHub returned a noncanonical PR URL.", "pr_write", True)
        db.execute("UPDATE operations SET change=? WHERE id=?", (json.dumps(change), operation)); db.commit()
    pull = view(store, change["url"])
    current = pull.get("body") or ""
    identity(pull, change, current == after)
    if current != after and not before and change["create"]:
        try:
            if BODY["merge"](current, change["generated"]) == current:
                after = current
                db.execute("UPDATE operations SET after_body=? WHERE id=?", (after, operation)); db.commit()
        except BODY["Refused"]:
            raise Refused("A canonical PR exists with different content; the bot must review its body before adoption.") from None
    if current != after:
        if not before and change["create"]:
            raise Refused("A canonical PR exists with different content; the bot must review its body before adoption.")
        try:
            merged = BODY["merge"](current, change["generated"], change.get("adopt") if current == before else None)
        except BODY["Refused"] as error:
            raise Refused(str(error)) from error
        if current != before:
            before, after = current, merged
            db.execute("UPDATE operations SET before_body=?,after_body=? WHERE id=?",
                       (before, after, operation)); db.commit()
        if current != after:
            permitted()
            db.execute("UPDATE operations SET written=1 WHERE id=?", (operation,)); db.commit()
            try:
                write(store, change, after, False)
            except (RuntimeError, OSError) as error:
                detail, rejected = write_error(db, operation, error)
                raise Refused(detail, "pr_input" if rejected else "pr_write", not bool(rejected)) from error
            pull = view(store, change["url"])
            identity(pull, change)
            if pull.get("body") != after:
                raise Refused("PR body read-back is pending; the bot will reconcile the saved publication.", "pr_read", True)
    relationship(pull, change["issue"])
    try:
        FINALIZE["finish"](store.repo, store.command, change, pull, permitted)
    except (RuntimeError, OSError) as error:
        raise Refused(SYNC["safe_detail"](str(error)), "pr_finalize", True) from error
    if change.get("verification") is not None:
        VERIFICATION["published"](db, store.repo, operation, change, pull)
    db.execute("UPDATE operations SET written=1,completed=1,completed_at=? WHERE id=?",
               (int(time.time()), operation)); db.commit()
    SYNC["publication_complete"](store.state, store.repo, change["issue"])
    return change["url"]


def publish(store: Store, issue: int, branch: str, head: str, generated: str, title: str,
            authority: dict, scope: str, existing: str | None = None, adopt: str | None = None,
            labels: tuple[str, ...] = (), plan_body: str = "", authorize: Callable[[], None] | None = None,
            verification: str | None = None) -> str:
    change = {"kind": "pr", "issue": issue, "branch": branch, "head": head, "generated": generated,
              "title": title, "url": existing, "adopt": adopt, "labels": list(labels), "authority": authority,
              "scope": scope, "plan_body": plan_body, "create": existing is None}
    if verification is not None:
        change["verification"] = verification
    with store.operations() as db:
        for operation, raw in db.execute("SELECT id,change FROM operations WHERE repo=? AND completed=0 ORDER BY rowid",
                                          (store.repo,)).fetchall():
            pending = json.loads(raw)
            if pending.get("kind") == "pr" and pending["branch"] == branch:
                if pending.get("url") and (pending["head"] != head or pending["scope"] != scope or pending["plan_body"] != plan_body):
                    current = view(store, pending["url"])
                    identity(current, change)
                    BODY["merge"](current.get("body") or "", generated, adopt)
                    try:
                        landed = BODY["merge"](current.get("body") or "", pending["generated"]) == (current.get("body") or "")
                    except BODY["Refused"]:
                        landed = False
                    if landed:
                        FINALIZE["account"](store.repo, pending)
                    db.execute("UPDATE operations SET completed=2,completed_at=? WHERE id=?",
                               (int(time.time()), operation)); db.commit()
                    existing = change["url"] = pending["url"]
                    change["create"] = False
                    continue
                attempted = db.execute("SELECT written FROM operations WHERE id=?", (operation,)).fetchone()[0]
                if not attempted and (pending["head"] != head or pending["scope"] != scope or pending["generated"] != generated):
                    db.execute("UPDATE operations SET completed=2,completed_at=? WHERE id=?",
                               (int(time.time()), operation)); db.commit()
                    continue
                if adopt and pending.get("url"):
                    current = view(store, pending["url"])
                    identity(current, change)
                    if BODY["digest"](current.get("body") or "") == adopt:
                        db.execute("UPDATE operations SET completed=2,completed_at=? WHERE id=?",
                                   (int(time.time()), operation)); db.commit()
                        existing = change["url"] = pending["url"]
                        continue
                recovered = finish(store, db, operation, pending, authorize if pending["authority"] == authority else None)
                if not existing:
                    existing = change["url"] = recovered
                    change["create"] = False
        before = ""
        after = generated
        if existing:
            pull = view(store, existing)
            identity(pull, change)
            before = pull.get("body") or ""
            try:
                after = BODY["merge"](before, generated, adopt)
            except BODY["Refused"] as error:
                raise Refused(str(error)) from error
        operation = hashlib.sha256(json.dumps([store.repo, change, before], sort_keys=True).encode()).hexdigest()
        previous = db.execute("SELECT completed FROM operations WHERE id=?", (operation,)).fetchone()
        if previous and previous[0] and before != after:
            raise Refused(f"PR changed after this publication; the bot must review its current body. reviewed_sha256={BODY['digest'](before)}")
        db.execute("INSERT OR IGNORE INTO operations(id,repo,issue,before_body,after_body,change,before_meta) VALUES (?,?,?,?,?,?,?)",
                   (operation, store.repo, issue, before, after, json.dumps(change), "{}")); db.commit()
        if previous and previous[0] == 1:
            db.execute("UPDATE operations SET completed=0 WHERE id=?", (operation,)); db.commit()
        SYNC["enqueue"](store.state, store.repo, issue)
        return finish(store, db, operation, change, authorize)
