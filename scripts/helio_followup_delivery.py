"""Topic issue subscriptions: verified terminal outcomes, delivered once per channel group."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
from typing import Callable

OUTCOMES = {"FOLLOWUP_LIVE": "the fix is live.", "FOLLOWUP_DONE": "it was resolved.",
            "FOLLOWUP_DECLINED": "it was declined."}


def migrate(state: Path) -> None:
    """The TypeScript conversation store owns the schema; run its migration before the first read."""
    path = state / "discord-conversations.sqlite"
    if path.is_file():
        with sqlite3.connect(path) as db:
            if db.execute("PRAGMA user_version").fetchone()[0] >= 7:
                return
    script = Path(__file__).resolve().parent.parent / "discord-inbound/conversation.ts"
    result = subprocess.run(["bun", str(script), "migrate"], capture_output=True, text=True, timeout=60,
                            env={**os.environ, "DORI_STATE_DIR": str(state)})
    if result.returncode or "CONVERSATION_MIGRATED" not in result.stdout:
        raise RuntimeError((result.stdout + result.stderr).strip()[-300:] or "conversation migration failed")


def text(repo: str, issue: int, current: dict) -> str:
    url = f"https://github.com/{repo}/issues/{issue}"
    title = str(current.get("title") or f"Issue #{issue}").replace("\n", " ")[:180]
    message = f"[Issue #{issue}](<{url}>), {title}: {OUTCOMES[current['event']]}"
    if current["event"] == "FOLLOWUP_DECLINED" and current.get("reason"):
        message += "\n" + str(current["reason"])[:500]
    return message


def deliver(db: sqlite3.Connection, state: Path, repo: str, issue: int, topic: str,
            news: Callable[[tuple, dict], dict | None]) -> int:
    row = db.execute("""SELECT issue,anchor_message_id,kind,created_at,status,announcement FROM followups
        WHERE repo=? AND issue=? AND anchor_message_id=?""", (repo, issue, topic)).fetchone()
    if row is None:
        print(f"FOLLOWUP_REFUSED issue={issue} topic={topic}: unknown subscription")
        return 1
    if row[4] == "done":
        print(f"FOLLOWUP_CLOSED issue={issue} topic={topic}")
        return 0
    started = db.execute("""SELECT 1 FROM followup_groups WHERE repo=? AND issue=? AND anchor_message_id=?""",
                         (repo, issue, topic)).fetchone() is not None
    current = json.loads(row[5]) if started and row[5] else news(row[:4], {})
    if current and current["event"] == "FOLLOWUP_ALREADY_CLOSED":
        db.execute("UPDATE followups SET status='done' WHERE repo=? AND issue=? AND anchor_message_id=?", (repo, issue, topic))
        db.commit()
        print(f"FOLLOWUP_CLOSED issue={issue} topic={topic}: closed before it was linked; nothing to send")
        return 0
    if not current:
        db.execute("UPDATE followups SET status='open',announcement=NULL WHERE repo=? AND issue=? AND anchor_message_id=?",
                   (repo, issue, topic))
        db.commit()
        print(f"FOLLOWUP_WAIT issue={issue} topic={topic}: current issue is not terminal")
        return 2
    db.execute("""UPDATE followups SET status='announced',announcement=?,observed_at=?
        WHERE repo=? AND issue=? AND anchor_message_id=?""", (json.dumps(current), int(time.time()), repo, issue, topic))
    db.commit()
    with tempfile.TemporaryDirectory(prefix="helio-notification-") as temporary:
        text_file = Path(temporary) / "notification.txt"
        text_file.write_text(text(repo, issue, current))
        result = subprocess.run(["bun", str(Path(__file__).resolve().parent.parent / "discord-inbound/notification.ts"),
                                 str(issue), topic, str(text_file)], capture_output=True, text=True, timeout=90)
    for line in result.stdout.strip().splitlines():
        print(line)
    if result.stderr:
        print(f"FOLLOWUP_PENDING detail={result.stderr.strip()[:1000]}")
    if result.returncode:
        return 1 if result.returncode == 1 else 2
    print(f"FOLLOWUP_CLOSED issue={issue} topic={topic}")
    return 0
