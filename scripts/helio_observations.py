"""Durable Oracle observations and transitions consumed by the existing watcher."""
from __future__ import annotations

import json
import sqlite3
import time


def poll(db: sqlite3.Connection, inspect) -> dict:
    db.execute("CREATE TABLE IF NOT EXISTS oracle_observations (singleton INTEGER PRIMARY KEY, data TEXT NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS oracle_events (
        id INTEGER PRIMARY KEY, data TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0)""")
    before = db.execute("SELECT data FROM oracle_observations WHERE singleton=1").fetchone()
    try:
        state = inspect()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        state = {"phase": "unavailable", "reason": type(error).__name__}
    previous = json.loads(before[0]) if before else None
    history = (previous or {}).get("restart_history", [])
    now = int(time.time())
    history = [item for item in history if item["at"] > now - 600]
    if previous and "restart_count" in previous and "restart_count" in state and state["restart_count"] > previous["restart_count"]:
        history.append({"at": now, "count": state["restart_count"] - previous.get("restart_count", 0)})
    state["restart_history"] = history
    state["crash_loop"] = sum(item["count"] for item in history) > 2
    key = lambda item: (item.get("phase"), item.get("running_revision"), item.get("crash_loop", False))
    if previous and key(previous) != key(state):
        db.execute("INSERT INTO oracle_events(data) VALUES (?)", (json.dumps(state),))
    db.execute("INSERT INTO oracle_observations VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET data=excluded.data", (json.dumps(state),))
    db.commit()
    return state


def pending(db: sqlite3.Connection) -> list[int]:
    return [row[0] for row in db.execute("SELECT id FROM oracle_events WHERE handled=0 ORDER BY id")]
