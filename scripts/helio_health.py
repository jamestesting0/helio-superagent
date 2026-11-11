#!/usr/bin/env python3
"""Helio health and recorded work attention, kept separate from intake readiness."""
from __future__ import annotations

import argparse
import datetime
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


def age_seconds(at: str | None, now: float) -> int | None:
    if not isinstance(at, str):
        return None
    try:
        observed = datetime.datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if observed.tzinfo is None:
        return None
    age = now - observed.timestamp()
    return int(age) if age >= 0 else None


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
    work_attention = []
    for lane_file in (state / "lanes").glob("*.json"):
        lane = json.loads(lane_file.read_text())
        status = "closed" if lane.get("closedAt") else "launch-failed" if lane.get("launchState") == "failed" else lane.get("status", "working")
        lanes[status] = lanes.get(status, 0) + 1
        if status in ("cleanup-pending", "launch-failed", "not-done"):
            work_attention.append({"key": lane.get("key"), "status": status, "opened_at": lane.get("openedAt"),
                                   "age_s": age_seconds(lane.get("openedAt"), now),
                                   "error": lane.get("launchError"),
                                   "basis": "recorded work state; intake readiness is separate"})
    queue = state / "launch-queue.json"
    worktrees = [path for path in (state / "worktrees").glob("*") if path.is_dir()]
    last_file = state / "housekeeping-last.json"
    last = json.loads(last_file.read_text()) if last_file.exists() else None
    kept = ((last or {}).get("worktrees") or {}).get("kept") or []
    kept = [{"key": row, "reason": "not recorded; run housekeeping"} if isinstance(row, str) else row for row in kept]
    custody = []
    for repo, issue, job, generation, raw in _query(state / "issue-updates.sqlite",
                                                   "SELECT repo,issue,job,generation,data FROM pr_waits"):
        try:
            data = json.loads(raw)
            retries = [(incident, item) for incident in data["incidents"].values() for item in incident["retries"]]
            probes = []
            for incident in data["incidents"].values():
                attempts = incident["retries"]
                if not incident["resolved"] and len(attempts) < 3 and all(r["status"] == "finished" for r in attempts):
                    probes.append(max(incident["first_at"] + (0, 1800, 7200)[len(attempts)],
                                      (attempts[-1]["finished_at"] or now) + 1800 if attempts else 0))
            status = data["status"]
            custody.append({"repo": repo, "issue": issue, "job": job, "generation": generation,
                            "state": status, "implementation_complete": data["acknowledgment"] == generation,
                            "pr": data["pr"], "head": data["head"], "last_progress": data["last_progress"],
                            "next_owner": "worker" if status in ("starting", "implementing", "repair", "diagnosis") else
                            "requester" if status in ("held", "decision", "unknown") else "controller",
                            "next_probe": min(probes) if probes else None,
                            "attempts": [dict(item) for _, item in retries],
                            "failure_fingerprints": list(data["incidents"]),
                            "unacknowledged_events": sum(not n["acknowledged"] for n in data["notices"])})
        except (ValueError, KeyError, TypeError):
            custody.append({"repo": repo, "issue": issue, "job": job, "generation": generation,
                            "state": "unknown", "next_owner": "requester"})
    return {
        "at": int(now),
        "oldest_pending_s": int(now - oldest_ms / 1000) if oldest_ms else None,
        "gaps": (_query(delivery, "SELECT count(*) FROM inbound_gaps WHERE acknowledged_at IS NULL") or [(0,)])[0][0],
        "lanes": lanes,
        "work_attention": work_attention,
        "pr_custody": custody,
        "queued": len(json.loads(queue.read_text())) if queue.exists() else 0,
        "worktrees": {"count": len(worktrees), "bytes": sum(_size(path) for path in worktrees),
                      "kept": kept},
        "blacklist": {"users": (_query(delivery, "SELECT count(*) FROM blocked_users") or [(0,)])[0][0],
                      "awaiting_review": (_query(delivery, "SELECT count(*) FROM blocked_users WHERE source='auto' AND review_question IS NULL") or [(0,)])[0][0]},
        # One figure per data class; worktrees are counted above, so no bucket overlaps another.
        "storage": {"databases": sum(_size(path) for path in state.glob("*.sqlite*")),
                    **{name: _size(path) for name, path in {
                        "sessions": home / ".omo/agent/sessions", "session_archive": home / ".omo/agent/sessions-archive",
                        "backups": home / ".dori/elobot/backups", "attachments": state / "attachments"}.items() if path.exists()}},
        "wal": {path.name: path.stat().st_size for path in sorted(state.glob("*.sqlite-wal"))},
        "housekeeping": {key: last.get(key) for key in ("at", "mode", "backup", "backup_error")} if last else None,
    }


def problems(health: dict, now: float) -> list[str]:
    found = []
    if health["oldest_pending_s"] is not None and health["oldest_pending_s"] > PENDING_WARN_S:
        found.append(f"oldest unaccepted message waiting {health['oldest_pending_s'] // 3600}h")
    if health["gaps"]:
        found.append(f"{health['gaps']} intake gap(s) not reviewed")
    trees = health["worktrees"]
    if trees["count"] > WORKTREES_WARN or trees["bytes"] > WORKTREES_WARN_BYTES:
        blocking = ", ".join(f"{row['key']} ({row['reason']})" for row in trees["kept"][:5]) + (f", +{len(trees['kept']) - 5} more" if len(trees["kept"]) > 5 else "")
        found.append(f"{trees['count']} worktrees retaining {trees['bytes'] / 1024 ** 3:.1f} GiB" + (f"; blocking cleanup: {blocking}" if blocking else ""))
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
        for row in health["work_attention"]:
            print("WORK_ATTENTION " + json.dumps(row))
        for row in health["pr_custody"]:
            print("PR_CUSTODY " + json.dumps(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
