"""What Helio still owes a person, derived from the records that already prove it.

An obligation is open while its source record says someone must hear something and the reply ledger has no
matching send. The sources stay the single truth: a PR custody notice that reached ready or settled owes the
requester a `completion` reply; an answered question raised for someone's conversation owes them a relay. This
module stores only what no other record holds: which conversation a question was raised for, recorded waivers,
and when each open obligation was last surfaced.
"""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import time

COMPLETION = "completion"
SURFACE_EVERY_S = 3600


def state_dir() -> Path:
    return Path(os.environ.get("DORI_STATE_DIR") or Path.home() / ".dori/elobot/state")


def _own(state: Path) -> sqlite3.Connection:
    db = sqlite3.connect(state / "obligations.sqlite", timeout=10)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS question_links (question TEXT PRIMARY KEY, channel TEXT, topic TEXT, requester TEXT,
            internal TEXT, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS waivers (key TEXT PRIMARY KEY, reason TEXT NOT NULL, at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS surfaced (key TEXT PRIMARY KEY, at REAL NOT NULL);""")
    return db


def _read(path: Path, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    if not path.is_file():
        return []
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        try:
            return db.execute(sql, params).fetchall()
        except sqlite3.OperationalError as error:
            if str(error).startswith("no such table:"):
                return []
            raise


def delivered(state: Path, channel: str, event: str, target: str | None = None) -> bool:
    """Whether reply.ts or evidence.ts recorded a completed send of this event (to this message, when given)."""
    rows = _read(state / "reply-sends.sqlite", "SELECT target FROM reply_sends WHERE text_hash=? AND state='sent'",
                 (f"event:{channel}:{event}",))
    return any(target is None or row["target"] == target for row in rows)


def waive(state: Path, key: str, reason: str) -> None:
    if not reason.strip():
        raise ValueError("a waiver needs a reason")
    with closing(_own(state)) as db, db:
        db.execute("INSERT INTO waivers VALUES (?,?,?) ON CONFLICT(key) DO NOTHING", (key, reason.strip()[:300], time.time()))


def waived(state: Path, key: str) -> bool:
    with closing(_own(state)) as db:
        return db.execute("SELECT 1 FROM waivers WHERE key=?", (key,)).fetchone() is not None


def conversation(state: Path, topic: str) -> dict | None:
    rows = _read(state / "discord-conversations.sqlite",
                 "SELECT channel_id, user_id, status FROM conversations WHERE anchor_message_id=?", (topic,))
    return dict(rows[0]) if rows else None


def link_question(state: Path, question: str, topic: str | None, internal: str | None) -> dict:
    if (topic is None) == (internal is None):
        raise ValueError("say who the answer is for: --for TOPIC (the requester's conversation) or --internal REASON")
    found = conversation(state, topic) if topic else None
    if topic and not found:
        raise ValueError(f"no conversation is anchored at {topic}; pass its anchor message ID or --internal REASON")
    if internal is not None and not internal.strip():
        raise ValueError("--internal needs a reason")
    link = {"question": question, "channel": found["channel_id"] if found else None, "topic": topic,
            "requester": found["user_id"] if found else None, "internal": internal.strip()[:300] if internal else None}
    with closing(_own(state)) as db, db:
        db.execute("INSERT INTO question_links VALUES (:question,:channel,:topic,:requester,:internal,:at) "
                   "ON CONFLICT(question) DO NOTHING", {**link, "at": time.time()})
    return link


def question_link(state: Path, question: str) -> dict | None:
    with closing(_own(state)) as db:
        row = db.execute("SELECT * FROM question_links WHERE question=?", (question,)).fetchone()
    return dict(row) if row else None


def relay_event(question: str) -> str:
    return f"question-{question}"


def pr_key(repo: str, issue: int) -> str:
    return f"pr-ready:{repo}#{issue}"


def pr_completion_owed(state: Path, repo: str, issue: int, authority: dict) -> bool:
    """A PR that reached ready or settled owes its requester one completion reply to the authorizing message."""
    return not (delivered(state, authority["channel"], COMPLETION, authority["message"]) or waived(state, pr_key(repo, issue)))


def owed(state: Path, repo: str) -> list[dict]:
    """Every open obligation, newest first, with the exact send that discharges it."""
    items: list[dict] = []
    for row in _read(state / "issue-updates.sqlite", "SELECT issue, data FROM pr_waits WHERE repo=?", (repo,)):
        data = json.loads(row["data"])
        authority = data.get("authority") or {}
        reached = [n for n in data.get("notices", []) if n.get("status") in ("ready", "settled")]
        if not reached or not authority.get("channel") or not authority.get("message"):
            continue
        if pr_completion_owed(state, repo, row["issue"], authority):
            items.append({"key": pr_key(repo, row["issue"]), "kind": "pr-ready", "issue": row["issue"], "pr": data.get("pr"),
                          "since": max(n["at"] for n in reached),
                          "send": f"reply once to message {authority['message']} in channel {authority['channel']} with "
                                  f"--event {COMPLETION} (evidence.ts or reply.ts): the PR is ready"})
    answered = {row["id"]: row for row in _read(state / "discord-questions.sqlite",
                                               "SELECT id, status, updated FROM questions WHERE status IN ('answered','done')")}
    with closing(_own(state)) as db:
        links = db.execute("SELECT * FROM question_links WHERE topic IS NOT NULL").fetchall()
    for link in links:
        question = answered.get(link["question"])
        key = f"question:{link['question']}"
        if not question:
            continue
        sent = delivered(state, link["channel"], relay_event(link["question"])) or waived(state, key)
        topic = conversation(state, link["topic"])
        if sent and (not topic or topic["status"] not in ("open", "on_hold")):
            continue
        items.append({"key": key, "kind": "question-relay", "question": link["question"], "topic": link["topic"],
                      "requester": link["requester"], "since": question["updated"] / 1000 if question["updated"] > 1e11 else question["updated"],
                      "send": (f"close conversation {link['topic']}; the relay is already settled" if sent else
                               f"tell the requester the decision in channel {link['channel']} (topic {link['topic']}) with "
                               f"--event {relay_event(link['question'])}, then close the conversation")})
    return sorted(items, key=lambda item: -item["since"])


def surface(state: Path, repo: str, now: float | None = None) -> list[str]:
    """OBLIGATION_DUE lines for the monitor: each open obligation at most once per hour, until it is discharged."""
    now = time.time() if now is None else now
    lines = []
    with closing(_own(state)) as db, db:
        for item in owed(state, repo):
            last = db.execute("SELECT at FROM surfaced WHERE key=?", (item["key"],)).fetchone()
            if last and now - last["at"] < SURFACE_EVERY_S:
                continue
            db.execute("INSERT INTO surfaced VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at", (item["key"], now))
            lines.append("OBLIGATION_DUE " + json.dumps(item, sort_keys=True))
    return lines
