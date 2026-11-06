"""New task identity linked to closed history, with durable creation recovery."""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass
import hashlib
import json
import re
import sqlite3
from typing import Protocol, TypedDict

MARKER = re.compile(r"<!-- helio-followup:(.*?) -->")


class Refused(Exception):
    """Follow-up creation needs reviewed input or an uncertain write reconciled."""


class User(TypedDict):
    login: str


class Issue(TypedDict, total=False):
    number: int
    body: str | None
    state: str
    user: User


class IssueStore(Protocol):
    repo: str

    def get(self, issue: int) -> Issue: ...
    def command(self, argv: list[str], stdin: str | None = None) -> str: ...
    def operations(self) -> AbstractContextManager[sqlite3.Connection]: ...


@dataclass(frozen=True, slots=True)
class Request:
    previous: int
    channel: str
    message: str
    title: str
    body: str
    labels: tuple[str, ...]


def predecessor(body: str) -> int | None:
    matches = MARKER.findall(body)
    if not matches:
        return None
    try:
        data = json.loads(matches[0])
    except ValueError as error:
        raise Refused("Follow-up metadata is malformed; review the issue body.") from error
    if (len(matches) != 1 or not isinstance(data, dict) or set(data) != {"previous", "request"}
            or type(data["previous"]) is not int or data["previous"] < 1
            or not isinstance(data["request"], str) or not re.fullmatch(r"[0-9a-f]{64}", data["request"])):
        raise Refused("Follow-up metadata is invalid; review the issue body.")
    return data["previous"]


def create(gh: IssueStore, request: Request) -> tuple[int, str]:
    """One current request creates one follow-up; history is never edited."""
    if (request.previous < 1 or not request.channel.isdigit() or not request.message.isdigit()
            or not request.title.strip() or not request.body.strip() or not request.labels):
        raise Refused("Follow-up needs a closed issue, current source IDs, title, scope and labels.")
    if "<!-- helio-followup:" in request.body:
        raise Refused("Supply new scope without copied follow-up metadata.")
    key = hashlib.sha256(json.dumps([gh.repo, request.previous, request.channel, request.message]).encode()).hexdigest()
    fingerprint = hashlib.sha256(json.dumps(asdict(request), sort_keys=True).encode()).hexdigest()
    marker = "<!-- helio-followup:" + json.dumps({"previous": request.previous, "request": key}, sort_keys=True) + " -->"
    with gh.operations() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS followup_creations (
            key TEXT PRIMARY KEY, repo TEXT NOT NULL, previous INTEGER NOT NULL,
            channel TEXT NOT NULL, message TEXT NOT NULL, fingerprint TEXT NOT NULL,
            attempted INTEGER NOT NULL DEFAULT 0, issue INTEGER)""")
        row = db.execute("SELECT fingerprint,attempted,issue FROM followup_creations WHERE key=?", (key,)).fetchone()
        if row and row[0] != fingerprint:
            target = f"issue #{row[2]}" if row[2] else f"creation {key}"
            raise Refused(f"This request already has a different creation intent; inspect {target} before changing scope.")
        if row and row[2]:
            gh.get(row[2])
            return row[2], f"https://github.com/{gh.repo}/issues/{row[2]}"
        login = gh.command(["gh", "api", "user", "--jq", ".login"]).strip()
        pages = json.loads(gh.command(["gh", "api", "--paginate", "--slurp",
                                      f"repos/{gh.repo}/issues?state=all&per_page=100&creator={login}"]))
        matches: list[Issue] = [
            issue for page in pages for issue in page
            if "pull_request" not in issue and marker in (issue.get("body") or "")
            and issue.get("user", {}).get("login") == login
        ]
        if len(matches) > 1:
            raise Refused("Multiple issues claim this request; inspect them before continuing.")
        # Recovery belongs to the new issue, even if a person changed its predecessor.
        if not matches and not (row and row[1]):
            source = gh.get(request.previous)
            if source.get("state", "").lower() != "closed" or "pull_request" in source:
                raise Refused("The predecessor must be a closed issue; reuse related open work instead.")
        if not row:
            db.execute("INSERT INTO followup_creations(key,repo,previous,channel,message,fingerprint) VALUES (?,?,?,?,?,?)",
                       (key, gh.repo, request.previous, request.channel, request.message, fingerprint))
            db.commit()
        if matches:
            number = matches[0]["number"]
        elif row and row[1]:
            raise Refused(f"Follow-up creation {key} remains uncertain; no matching issue was found. Inspect GitHub before another POST.")
        else:
            db.execute("UPDATE followup_creations SET attempted=1 WHERE key=?", (key,))
            db.commit()
            body = (request.body.rstrip() + f"\n\nRelated history: https://github.com/{gh.repo}/issues/{request.previous}\n\n"
                    + marker)
            created: Issue = json.loads(gh.command(
                ["gh", "api", f"repos/{gh.repo}/issues", "--method", "POST", "--input", "-"],
                json.dumps({"title": request.title.strip(), "body": body, "labels": list(request.labels)})))
            number = created["number"]
        db.execute("UPDATE followup_creations SET issue=? WHERE key=?", (number, key))
        db.commit()
        verified = gh.get(number)
        if marker not in (verified.get("body") or ""):
            raise Refused(f"Created issue #{number} changed before read-back; inspect it without creating another.")
        return number, f"https://github.com/{gh.repo}/issues/{number}"
