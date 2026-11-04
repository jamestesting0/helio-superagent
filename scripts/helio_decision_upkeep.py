"""Owner-only weekly review, persisted until explicitly acknowledged."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import time

LEDGER = runpy.run_path(str(Path(__file__).with_name("helio_decisions.py")))


def check(state: Path, repo: str) -> dict | None:
    path = state / "decisions.sqlite"
    db = LEDGER["connect"](path)
    try:
        owner = os.environ.get("DORI_DISCORD_OWNER_ID", "")
        trusted_file = Path.home() / ".dori/elobot/trusted-users"
        trusted = set(trusted_file.read_text().strip().split(",")) if trusted_file.exists() else set()
        closed = set()
        for path in (state / "lanes").glob("*.json"):
            lane = json.loads(path.read_text())
            if lane.get("closedAt"):
                closed.add(lane["key"])
        reviews = LEDGER["upkeep"](db, repo, trusted | {owner}, closed)
        db.execute("CREATE TABLE IF NOT EXISTS decision_digest (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0)")
        latest = db.execute("SELECT created_at FROM decision_digest ORDER BY created_at DESC LIMIT 1").fetchone()
        since = latest[0] if latest else 0
        changes = [dict(row) for row in db.execute("SELECT * FROM decision_events WHERE created_at>? ORDER BY sequence", (since,))]
        memory = Path.home() / ".omo/memory/agents/elobot-ec289b4c/repo/system/agreements.md"
        notes = memory.read_text() if memory.exists() else ""
        # Include the actual note inventory for owner review; it never authorizes removal.
        fingerprint = hashlib.sha256(notes.encode()).hexdigest()
        previous = db.execute("SELECT data FROM decision_digest ORDER BY created_at DESC LIMIT 1").fetchone()
        old_fingerprint = json.loads(previous[0]).get("memory_hash") if previous else None
        if time.time() - since >= 7 * 86400 and (changes or reviews or (notes and fingerprint != old_fingerprint)):
            data = {"changes": changes, "trust_review": reviews, "memory_hash": fingerprint,
                    "runtime_notes": notes, "audience": "owner", "cleanup": "proposal only"}
            identity = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]
            db.execute("INSERT OR IGNORE INTO decision_digest(id,created_at,data) VALUES (?,?,?)", (identity, int(time.time()), json.dumps(data)))
            db.commit()
        pending = db.execute("SELECT id FROM decision_digest WHERE handled=0 ORDER BY created_at LIMIT 1").fetchone()
        return {"id": pending[0]} if pending else None
    finally:
        db.close()
