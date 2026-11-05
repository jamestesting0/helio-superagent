#!/usr/bin/env python3
"""One snapshot of Helio's long-run health: backlog, gaps, lanes, storage and upkeep. Prints problems only unless --json."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

EPOCH_MS = 1420070400000
PENDING_WARN_S = 2 * 3600
WORKTREES_WARN, WORKTREES_WARN_BYTES = 10, 2 * 1024 ** 3
WAL_WARN_BYTES = 64 * 1024 ** 2
HOUSEKEEPING_STALE_S = 2 * 86_400


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                continue
    return total


def _query(path: Path, sql: str) -> list[tuple]:
    if not path.exists():
        return []
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)) as db:
        try:
            return db.execute(sql).fetchall()
        except sqlite3.OperationalError:
            return []


def snapshot(state: Path, home: Path, now: float) -> dict:
    delivery = state / "discord-delivery.sqlite"
    oldest = _query(delivery, "SELECT min((CAST(d.id AS INTEGER) >> 22) + 1420070400000) FROM delivery d LEFT JOIN acceptance a "
                              "ON a.stream=d.stream AND a.id=d.id WHERE d.stream='inbound' AND d.payload IS NOT NULL AND a.id IS NULL")
    oldest_ms = oldest[0][0] if oldest and oldest[0][0] else None
    lanes: dict[str, int] = {}
    for lane_file in (state / "lanes").glob("*.json"):
        lane = json.loads(lane_file.read_text())
        status = "closed" if lane.get("closedAt") else "launch-failed" if lane.get("launchState") == "failed" else lane.get("status", "working")
        lanes[status] = lanes.get(status, 0) + 1
    queue = state / "launch-queue.json"
    worktrees = [path for path in (state / "worktrees").glob("*") if path.is_dir()]
    last_file = state / "housekeeping-last.json"
    last = json.loads(last_file.read_text()) if last_file.exists() else None
    return {
        "at": int(now),
        "oldest_pending_s": int(now - oldest_ms / 1000) if oldest_ms else None,
        "gaps": (_query(delivery, "SELECT count(*) FROM inbound_gaps WHERE acknowledged_at IS NULL") or [(0,)])[0][0],
        "lanes": lanes,
        "queued": len(json.loads(queue.read_text())) if queue.exists() else 0,
        "worktrees": {"count": len(worktrees), "bytes": sum(_size(path) for path in worktrees)},
        "blacklist": {"users": (_query(delivery, "SELECT count(*) FROM blocked_users") or [(0,)])[0][0],
                      "awaiting_review": (_query(delivery, "SELECT count(*) FROM blocked_users WHERE source='auto' AND review_question IS NULL") or [(0,)])[0][0]},
        "storage": {name: _size(path) for name, path in {
            "databases": state, "sessions": home / ".omo/agent/sessions", "session_archive": home / ".omo/agent/sessions-archive",
            "backups": home / ".dori/elobot/backups", "attachments": state / "attachments"}.items() if path.exists()},
        "wal": {path.name: path.stat().st_size for path in sorted(state.glob("*.sqlite-wal"))},
        "housekeeping": {key: last.get(key) for key in ("at", "mode", "backup", "backup_error")} if last else None,
    }


def problems(health: dict, now: float) -> list[str]:
    found = []
    if health["oldest_pending_s"] is not None and health["oldest_pending_s"] > PENDING_WARN_S:
        found.append(f"oldest unaccepted message waiting {health['oldest_pending_s'] // 3600}h")
    if health["gaps"]:
        found.append(f"{health['gaps']} intake gap(s) not reviewed")
    for status in ("cleanup-pending", "launch-failed", "not-done"):
        if health["lanes"].get(status):
            found.append(f"{health['lanes'][status]} lane(s) {status}")
    trees = health["worktrees"]
    if trees["count"] > WORKTREES_WARN or trees["bytes"] > WORKTREES_WARN_BYTES:
        found.append(f"{trees['count']} worktrees retaining {trees['bytes'] / 1024 ** 3:.1f} GiB")
    found += [f"{name} is {size / 1024 ** 2:.0f} MiB" for name, size in health["wal"].items() if size > WAL_WARN_BYTES]
    if health["blacklist"]["awaiting_review"]:
        found.append(f"{health['blacklist']['awaiting_review']} automatic blacklist entr(ies) awaiting owner review")
    last = health["housekeeping"]
    if not last or now - (last.get("at") or 0) > HOUSEKEEPING_STALE_S:
        found.append("housekeeping has not run in 2 days")
    elif last.get("mode") == "dry-run":
        found.append("housekeeping awaits first-run approval")
    if last and last.get("backup_error"):
        found.append(f"backup failed: {last['backup_error'][:120]}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    now = time.time()
    health = snapshot(state, Path.home(), now)
    found = problems(health, now)
    if args.json:
        print(json.dumps({**health, "problems": found}))
    else:
        print("HEALTH ok" if not found else "HEALTH problems: " + "; ".join(found))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
