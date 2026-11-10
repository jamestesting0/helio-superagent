"""Planning-only source receipts, committed atomically with intake acceptance."""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
from typing import Callable, Protocol, TypedDict

HERE = Path(__file__).resolve().parent
APPROVAL = runpy.run_path(str(HERE / "helio_approval.py"))
UTC = datetime.timezone.utc


class Refused(RuntimeError):
    """The planning request lacks current, immutable source proof."""


class Origin(TypedDict):
    content_sha256: str


class Payload(TypedDict, total=False):
    message_id: str
    channel_id: str
    author_id: str
    author: str
    content: str
    for_owner: bool
    discord_origin: Origin


class Actor(TypedDict, total=False):
    id: str
    bot: bool
    username: str


class Live(TypedDict):
    id: str
    channel_id: str
    author: Actor
    content: str
    timestamp: str


class Source(TypedDict):
    payload: Payload
    live: Live
    owner: str
    trusted: set[str]
    channel_ok: bool
    verify_source: Callable[[Payload, Live, str, set[str], bool], str]
    Refused: type[Exception]


class Reader(Protocol):
    def __call__(self, message: str, channel: str | None = None,
                 fingerprint: str | None = None) -> Source: ...


@dataclass(frozen=True, slots=True)
class Request:
    repo: str
    issue: int
    message: str
    channel: str


@dataclass(frozen=True, slots=True)
class Receipt:
    request: Request
    author: str
    author_name: str
    source_hash: str
    accepted_at: str
    state: str
    comment_id: str | None
    settled_at: str | None


@dataclass(frozen=True, slots=True)
class Cancellation:
    request: Request
    message: str
    channel: str


def path() -> Path:
    return Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))) / "discord-delivery.sqlite"


def connect() -> sqlite3.Connection:
    if not path().is_file():
        raise Refused("planning source queue is unavailable; retain the request")
    db = sqlite3.connect(path().as_uri() + "?mode=rw", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    db.executescript((HERE.parent / "discord-inbound/delivery/plan-requests.sql").read_text())
    return db


def get(repo: str, issue: int, message: str) -> Receipt | None:
    if not path().is_file():
        return None
    with closing(connect()) as db:
        row = db.execute("SELECT * FROM plan_requests WHERE repo=? AND issue=? AND message=?",
                         (repo, issue, message)).fetchone()
    if row is None:
        return None
    return from_row(row)


def from_row(row: sqlite3.Row) -> Receipt:
    return Receipt(Request(row["repo"], row["issue"], row["message"], row["channel"]),
                   row["author"], row["author_name"], row["source_hash"], row["accepted_at"],
                   row["state"], row["comment_id"], row["settled_at"])

def for_post(repo: str, issue: int, message: str) -> Request:
    receipt = get(repo, issue, message)
    if receipt:
        return receipt.request
    with closing(connect()) as db:
        row = db.execute("SELECT payload FROM delivery WHERE stream='inbound' AND id=?", (message,)).fetchone()
    if row is None or row["payload"] is None:
        raise Refused("acknowledged planning source has no recorded receipt; inspect the current request")
    payload = json.loads(row["payload"])
    channel = payload.get("channel_id")
    if not isinstance(channel, str) or not channel.isdigit():
        raise Refused("pending planning source has no valid channel")
    return Request(repo, issue, message, channel)


def verified(request: Request, reader: Reader, receipt: Receipt | None = None) -> Source:
    if receipt:
        if receipt.request != request or receipt.state == "cancelled":
            raise Refused("planning request is cancelled or bound to a different location")
    source = reader(request.message, request.channel, receipt.source_hash if receipt else None)
    payload = source["payload"]
    if receipt:
        payload = {**payload, "message_id": request.message, "channel_id": request.channel,
                   "author_id": receipt.author, "discord_origin": {"content_sha256": receipt.source_hash}}
    try:
        author = source["verify_source"](payload, source["live"], source["owner"], source["trusted"], source["channel_ok"])
    except source["Refused"] as error:
        raise Refused(str(error)) from error
    if payload.get("message_id") != request.message or payload.get("channel_id") != request.channel:
        raise Refused("planning source identity does not match the selected request")
    if receipt and author != receipt.author:
        raise Refused("planning source author changed")
    return {**source, "payload": payload}


def record(request: Request, reader: Reader, now: datetime.datetime) -> Receipt:
    if request.issue < 1 or not request.repo or not request.message.isdigit() or not request.channel.isdigit():
        raise Refused("planning request needs repository, positive issue and source IDs")
    previous = get(request.repo, request.issue, request.message)
    pending_payload = None
    if previous is None:
        with closing(connect()) as db:
            pending = db.execute("SELECT payload FROM delivery WHERE stream='inbound' AND id=?",
                                 (request.message,)).fetchone()
            pending_payload = pending["payload"] if pending else None
    source = verified(request, reader, previous)
    if previous:
        return previous
    sent = datetime.datetime.fromisoformat(source["live"]["timestamp"].replace("Z", "+00:00"))
    age = (now - sent).total_seconds()
    if age < -30 or age > 72 * 3600:
        raise Refused("plan request is outside the 72-hour acceptance window")
    text = APPROVAL["instruction_text"](source["live"]["content"])
    if not re.search(r"\b(?:plan|planning|finali[sz]e|finali[sz]ing)\b", text, re.I):
        raise Refused(f"that message does not ask for a plan for #{request.issue}")
    fingerprint = hashlib.sha256(source["live"]["content"].encode()).hexdigest()
    author = source["payload"]["author_id"]
    label = source["payload"].get("author") or source["live"]["author"].get("username") or author
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        concurrent = db.execute("SELECT * FROM plan_requests WHERE repo=? AND issue=? AND message=?",
                                (request.repo, request.issue, request.message)).fetchone()
        if concurrent is not None:
            receipt = from_row(concurrent)
            if (receipt.request, receipt.author, receipt.source_hash) != (request, author, fingerprint) or receipt.state == "cancelled":
                raise Refused("concurrent planning receipt changed binding or was cancelled")
            return receipt
        row = db.execute("SELECT payload FROM delivery WHERE stream='inbound' AND id=?", (request.message,)).fetchone()
        if row is None or row["payload"] is None:
            raise Refused("planning source is no longer pending; no receipt can be reconstructed")
        if row["payload"] != pending_payload:
            raise Refused("planning source payload changed during acceptance")
        saved = json.loads(row["payload"])
        saved_hash = (saved.get("discord_origin") or {}).get("content_sha256")
        saved_hash = saved_hash or hashlib.sha256(str(saved.get("content", "")).encode()).hexdigest()
        if (saved.get("channel_id"), saved.get("author_id"), saved_hash) != (request.channel, author, fingerprint):
            raise Refused("planning source changed during acceptance")
        if saved.get("for_owner"):
            raise Refused("a message addressed to the owner cannot start planning")
        db.execute("""INSERT OR IGNORE INTO plan_requests
            (repo,issue,message,channel,author,author_name,source_hash,accepted_at,state)
            VALUES (?,?,?,?,?,?,?,?,'accepted')""",
                   (request.repo, request.issue, request.message, request.channel, author, label[:100], fingerprint, now.isoformat()))
        bound = db.execute("SELECT * FROM plan_requests WHERE repo=? AND issue=? AND message=?",
                           (request.repo, request.issue, request.message)).fetchone()
        if (bound["channel"], bound["author"], bound["source_hash"], bound["state"]) != (request.channel, author, fingerprint, "accepted"):
            raise Refused("existing planning receipt has a different binding or state")
        db.execute("INSERT OR IGNORE INTO acceptance(stream,id) VALUES('inbound',?)", (request.message,))
        return from_row(bound)


def cancel(cancellation: Cancellation, reader: Reader, now: datetime.datetime) -> Receipt:
    request = cancellation.request
    receipt = get(request.repo, request.issue, request.message)
    if receipt is None:
        raise Refused("no planning receipt exists for this request")
    source = verified(Request(request.repo, request.issue, cancellation.message, cancellation.channel), reader)
    text = APPROVAL["instruction_text"](source["live"]["content"])
    if not re.search(r"\b(?:cancel|drop|stop)\b", text, re.I):
        raise Refused("cancellation source does not request cancellation")
    with closing(connect()) as db, db:
        db.execute("""UPDATE plan_requests SET state='cancelled',settled_at=coalesce(settled_at,?),cancel_message=?
                      WHERE repo=? AND issue=? AND message=?""",
                   (now.isoformat(), cancellation.message, request.repo, request.issue, request.message))
    return Receipt(request, receipt.author, receipt.author_name, receipt.source_hash, receipt.accepted_at,
                   "cancelled", receipt.comment_id, receipt.settled_at or now.isoformat())


def published(request: Request, comment_id: str) -> None:
    with closing(connect()) as db, db:
        changed = db.execute("""UPDATE plan_requests SET state='posted',comment_id=?
            WHERE repo=? AND issue=? AND message=? AND state IN ('accepted','posted')""",
                             (comment_id, request.repo, request.issue, request.message)).rowcount
        if changed != 1:
            raise Refused("planning request was cancelled before publication settlement")


def dropped(repo: str, issue: int, now: datetime.datetime) -> None:
    if not path().is_file():
        return
    with closing(connect()) as db, db:
        db.execute("""UPDATE plan_requests SET state='cancelled',settled_at=coalesce(settled_at,?)
            WHERE repo=? AND issue=?""", (now.isoformat(), repo, issue))


def closed(repo: str, issue: int, now: datetime.datetime) -> None:
    if not path().is_file():
        return
    with closing(connect()) as db, db:
        db.execute("UPDATE plan_requests SET settled_at=coalesce(settled_at,?) WHERE repo=? AND issue=?",
                   (now.isoformat(), repo, issue))
