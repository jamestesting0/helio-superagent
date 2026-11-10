"""Terminal subscription identity and verified native delivery receipts."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import subprocess
import time
from typing import Callable


def event(repo: str, issue: int, user: str, channel: str, target: str) -> str:
    encoded = json.dumps([repo, issue, user, channel, target], separators=(",", ":"))
    return "followup:" + hashlib.sha256(encoded.encode()).hexdigest()


def migrate(db: sqlite3.Connection) -> None:
    with db:
        db.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in db.execute("PRAGMA table_info(followups)")}
        for name, declaration in (
            ("delivery_version", "INTEGER NOT NULL DEFAULT 0"),
            ("delivered_reply_id", "TEXT"),
            ("delivery_disposition", "TEXT"),
            ("observed_at", "INTEGER"),
        ):
            if name not in columns:
                db.execute(f"ALTER TABLE followups ADD COLUMN {name} {declaration}")


def receipt(state: Path, repo: str, row: tuple) -> str | None:
    issue, user, channel, target = row[:4]
    path = state / "reply-sends.sqlite"
    if not path.is_file():
        return None
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='reply_sends'").fetchone():
            return None
        found = db.execute("""SELECT reply_id FROM reply_sends WHERE target=? AND text_hash=?
            AND state='sent' AND reply_id IS NOT NULL""",
                           (target, "event:" + event(repo, issue, user, channel, target))).fetchone()
    if found and str(found[0]).isdigit():
        return str(found[0])
    return None


def complete(db: sqlite3.Connection, state: Path, repo: str, issue: int, user: str) -> bool:
    row = db.execute("""SELECT issue,user_id,channel_id,reply_to,delivery_disposition,status
        FROM followups WHERE repo=? AND issue=? AND user_id=?""", (repo, issue, user)).fetchone()
    if row is None:
        return False
    if row[5] == "done":
        return True
    reply_id = receipt(state, repo, row)
    if not reply_id and row[4] != "undeliverable":
        return False
    db.execute("""UPDATE followups SET status='done',delivered_reply_id=?,
        delivery_disposition=? WHERE repo=? AND issue=? AND user_id=?""",
               (reply_id, "sent" if reply_id else "undeliverable", repo, issue, user))
    db.commit()
    return True


def deliver(db: sqlite3.Connection, state: Path, repo: str, issue: int, user: str,
            news: Callable[[tuple, dict], dict | None]) -> int:
    row = db.execute("""SELECT issue,user_id,channel_id,reply_to,kind,status,delivery_version,announcement
        FROM followups WHERE repo=? AND issue=? AND user_id=?""", (repo, issue, user)).fetchone()
    if row is None:
        print(f"FOLLOWUP_REFUSED issue={issue} user={user}: unknown subscription")
        return 1
    if complete(db, state, repo, issue, user):
        print(f"FOLLOWUP_CLOSED issue={issue} user={user}")
        return 0
    # The old sender had no purpose-specific identity. A historical announcement is not proof of no send.
    if row[5] == "announced" and row[6] == 0:
        print(f"FOLLOWUP_PENDING issue={issue} user={user}: legacy delivery remains uncertain")
        return 2
    current = news(row[:5], {})
    identity = "event:" + event(repo, issue, user, row[2], row[3])
    pending = False
    sends = state / "reply-sends.sqlite"
    if sends.is_file():
        with closing(sqlite3.connect(sends.as_uri() + "?mode=ro", uri=True)) as sent:
            if sent.execute("SELECT 1 FROM sqlite_master WHERE name='reply_sends'").fetchone():
                pending = sent.execute("SELECT 1 FROM reply_sends WHERE target=? AND text_hash=? AND state='sending'",
                                       (row[3], identity)).fetchone() is not None
    if not current:
        if pending:
            print(f"FOLLOWUP_PENDING issue={issue} user={user}: uncertain send retained after terminal state changed")
            return 2
        db.execute("UPDATE followups SET status='open',announcement=NULL WHERE repo=? AND issue=? AND user_id=?",
                   (repo, issue, user))
        db.commit()
        print(f"FOLLOWUP_WAIT issue={issue} user={user}: current issue is not terminal")
        return 2
    db.execute("""UPDATE followups SET delivery_version=CASE WHEN status='open' THEN 1 ELSE delivery_version END,
        status='announced',announcement=?,observed_at=?
        WHERE repo=? AND issue=? AND user_id=?""", (json.dumps(current), int(time.time()), repo, issue, user))
    db.commit()
    outcome = {"FOLLOWUP_LIVE": "The fix is now live.", "FOLLOWUP_DONE": "The issue was resolved.",
               "FOLLOWUP_DECLINED": "The issue was declined."}[current["event"]]
    title = str(current.get("title") or f"Issue #{issue}").replace("\n", " ")[:180]
    text = f"{title}: {outcome} https://github.com/{repo}/issues/{issue}"
    if current["event"] == "FOLLOWUP_DECLINED" and current.get("reason"):
        text += "\n" + str(current["reason"])[:500]
    with tempfile.TemporaryDirectory(prefix="helio-notification-") as temporary:
        text_file = Path(temporary) / "notification.txt"
        text_file.write_text(text)
        result = subprocess.run(["bun", str(Path(__file__).resolve().parent.parent / "discord-inbound/notification.ts"),
                                 str(issue), user, str(text_file)], capture_output=True, text=True, timeout=45)
    if result.stdout.startswith("NOTIFICATION_PERMISSION_DENIED"):
        changed = db.execute("""UPDATE followups SET delivery_disposition='permission_denied'
            WHERE repo=? AND issue=? AND user_id=? AND delivery_disposition IS NOT 'permission_denied'""",
                             (repo, issue, user)).rowcount
        db.commit()
        if changed:
            print(result.stdout.strip())
        else:
            print(f"FOLLOWUP_PENDING issue={issue} user={user} cause=permission_denied: existing denial retained")
    else:
        print(result.stdout.strip())
    if result.stderr:
        print(f"FOLLOWUP_PENDING detail={result.stderr.strip()[:1000]}")
    if result.returncode:
        return 1 if result.returncode == 1 else 2
    if not complete(db, state, repo, issue, user):
        print(f"FOLLOWUP_PENDING issue={issue} user={user}: native receipt not yet verified")
        return 2
    print(f"FOLLOWUP_CLOSED issue={issue} user={user}")
    return 0
