"""Durable requester obligations, settled only by a delivery receipt or a recorded waiver."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import time

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
        CREATE TABLE IF NOT EXISTS surfaced (key TEXT PRIMARY KEY, at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS obligations (key TEXT PRIMARY KEY, data TEXT NOT NULL,
            active INTEGER NOT NULL, relay_settled INTEGER NOT NULL DEFAULT 0, settled INTEGER NOT NULL DEFAULT 0);""")
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
    if topic:
        _record(state, {"key": f"question:{question}", "kind": "question-relay", "question": question,
                       "topic": topic, "channel": link["channel"], "requester": link["requester"],
                       "event": relay_event(question), "since": time.time()}, active=False)
    return link


def question_link(state: Path, question: str) -> dict | None:
    with closing(_own(state)) as db:
        row = db.execute("SELECT * FROM question_links WHERE question=?", (question,)).fetchone()
    return dict(row) if row else None


def relay_event(question: str) -> str:
    return f"question-{question}"


def pr_key(repo: str, issue: int, pr: str | None = None) -> str:
    return f"pr-ready:{repo}#{issue}" + (f":{pr.rsplit('/', 1)[-1]}" if pr else "")


def completion_event(repo: str, pr: str) -> str:
    return f"completion-pr-{repo.replace('/', '-')}-{pr.rsplit('/', 1)[-1]}"


def _record(state: Path, item: dict, active: bool = True) -> None:
    with closing(_own(state)) as db, db:
        db.execute("INSERT INTO obligations(key,data,active) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING",
                   (item["key"], json.dumps(item), int(active)))


def record_pr(state: Path, repo: str, issue: int, data: dict) -> None:
    """Called by custody persistence; notices may later be compacted without losing this debt."""
    authority = data.get("authority") or {}
    reached = [n for n in data.get("notices", []) if n.get("status") in ("ready", "settled")]
    pr = data.get("pr")
    if not reached or not pr or not authority.get("channel") or not authority.get("message"):
        return
    _record(state, {"key": pr_key(repo, issue, pr), "kind": "pr-ready", "repo": repo, "issue": issue, "pr": pr,
                    "channel": authority["channel"], "target": authority["message"], "event": completion_event(repo, pr),
                    "since": min(n["at"] for n in reached)})


def activate_question(state: Path, question: str) -> None:
    with closing(_own(state)) as db, db:
        db.execute("UPDATE obligations SET active=1 WHERE key=?", (f"question:{question}",))


def pr_completion_owed(state: Path, repo: str, issue: int, authority: dict, pr: str) -> bool:
    key = pr_key(repo, issue, pr)
    with closing(_own(state)) as db:
        row = db.execute("SELECT settled FROM obligations WHERE key=?", (key,)).fetchone()
    return not ((row and row["settled"]) or delivered(state, authority["channel"], completion_event(repo, pr),
                                                    authority["message"]) or waived(state, key))


def owed(state: Path, repo: str) -> list[dict]:
    """Backfill existing sources, then reconcile persistent debts against receipts."""
    for row in _read(state / "issue-updates.sqlite", "SELECT issue, data FROM pr_waits WHERE repo=?", (repo,)):
        record_pr(state, repo, row["issue"], json.loads(row["data"]))
    answered = {row["id"]: row for row in _read(state / "discord-questions.sqlite",
                                               "SELECT id, status, updated FROM questions WHERE status IN ('answered','done')")}
    with closing(_own(state)) as db:
        links = db.execute("SELECT * FROM question_links WHERE topic IS NOT NULL").fetchall()
    for link in links:
        question = answered.get(link["question"])
        if question:
            _record(state, {"key": f"question:{link['question']}", "kind": "question-relay",
                           "question": link["question"], "channel": link["channel"], "topic": link["topic"],
                           "requester": link["requester"], "event": relay_event(link["question"]),
                           "since": question["updated"] / 1000 if question["updated"] > 1e11 else question["updated"]})
            activate_question(state, link["question"])
    with closing(_own(state)) as db:
        rows = db.execute("SELECT * FROM obligations WHERE active=1 AND settled=0").fetchall()
    items = []
    for row in rows:
        item = json.loads(row["data"])
        if item.get("repo", repo) != repo:
            continue
        sent = bool(row["relay_settled"]) or delivered(state, item["channel"], item["event"], item.get("target")) or waived(state, item["key"])
        topic = conversation(state, item["topic"]) if item.get("topic") else None
        settled = sent and (not topic or topic["status"] not in ("open", "on_hold"))
        with closing(_own(state)) as db, db:
            db.execute("UPDATE obligations SET relay_settled=?,settled=? WHERE key=?", (int(sent), int(settled), item["key"]))
        if settled:
            continue
        item["send"] = (f"close conversation {item['topic']}; the relay is already settled" if sent else
                        f"reply once in channel {item['channel']} " +
                        (f"to message {item['target']} about PR {item['pr']}" if item.get("target") else
                         f"to the requester in topic {item['topic']}, then close that conversation") +
                        f" with --event {item['event']} (evidence.ts or reply.ts)")
        items.append(item)
    return sorted(items, key=lambda item: -item["since"])


def surface(state: Path, repo: str, now: float | None = None) -> list[str]:
    """OBLIGATION_DUE lines for the monitor: each open obligation at most once per hour, until it is discharged."""
    now = time.time() if now is None else now
    lines = []
    items = owed(state, repo)
    with closing(_own(state)) as db, db:
        for item in items:
            last = db.execute("SELECT at FROM surfaced WHERE key=?", (item["key"],)).fetchone()
            if last and now - last["at"] < SURFACE_EVERY_S:
                continue
            db.execute("INSERT INTO surfaced VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at", (item["key"], now))
            lines.append("OBLIGATION_DUE " + json.dumps(item, sort_keys=True))
    return lines
