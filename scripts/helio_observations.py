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
    # An inspection outage says nothing about Oracle: compare against the last state actually observed.
    known = previous.get("last_known", previous) if previous and previous.get("phase") == "unavailable" else previous
    history = (previous or {}).get("restart_history", [])
    now = int(time.time())
    history = [item for item in history if item["at"] > now - 600]
    if previous and "restart_count" in previous and "restart_count" in state and state["restart_count"] > previous["restart_count"]:
        history.append({"at": now, "count": state["restart_count"] - previous.get("restart_count", 0)})
    state["restart_history"] = history
    state["crash_loop"] = sum(item["count"] for item in history) > 2
    key = lambda item: (item.get("phase"), item.get("running_revision"), item.get("crash_loop", False))
    if state.get("phase") == "unavailable":
        state["last_known"] = known
    elif known and key(known) != key(state):
        event = {"at": now, "from": _summary(known), "to": _summary(state), "changes": _changes(known, state), "snapshot": state}
        db.execute("INSERT INTO oracle_events(data) VALUES (?)", (json.dumps(event),))
    db.execute("INSERT INTO oracle_observations VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET data=excluded.data", (json.dumps(state),))
    db.commit()
    return state


def _summary(state: dict) -> dict:
    return {name: state.get(name) for name in ("phase", "running_revision", "crash_loop", "login_observed_at", "observed_at")}


def _changes(before: dict, after: dict) -> list[str]:
    changes = []
    if before.get("phase") != after.get("phase"):
        changes.append(f"phase {before.get('phase')} -> {after.get('phase')}")
    if after.get("running_revision") and before.get("running_revision") != after.get("running_revision"):
        short = lambda value: (value or "unknown")[:8]
        changes.append(f"running revision {short(before.get('running_revision'))} -> {short(after.get('running_revision'))}")
    if bool(before.get("crash_loop")) != bool(after.get("crash_loop")):
        changes.append("crash loop started" if after.get("crash_loop") else "crash loop ended")
    return changes


def detail(db: sqlite3.Connection, event: int) -> dict | None:
    """One Oracle event as the transition it recorded; events stored before transitions were kept say so."""
    row = db.execute("SELECT data, handled FROM oracle_events WHERE id=?", (event,)).fetchone()
    if row is None:
        return None
    data = json.loads(row[0])
    result = data if "changes" in data else {"legacy": True, "snapshot": data,
                                            "note": "recorded before transitions were stored; compare with current status, then acknowledge"}
    return {"id": event, "handled": bool(row[1]), **result,
            "acknowledge": f"helio followups oracle --event {event} --done"}


def pending(db: sqlite3.Connection) -> list[int]:
    return [row[0] for row in db.execute("SELECT id FROM oracle_events WHERE handled=0 ORDER BY id")]
