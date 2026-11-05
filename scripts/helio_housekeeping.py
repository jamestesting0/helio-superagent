#!/usr/bin/env python3
"""Daily housekeeping: retention, database upkeep, worktrees, session archive, log rotation and backup.

Until the owner approves the first run (--approve-first-run), deletions are only reported.
"""
from __future__ import annotations

import argparse
import datetime
import fcntl
import gzip
import json
import os
import runpy
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
from contextlib import closing
from pathlib import Path

HERE = Path(__file__).resolve().parent
RETENTION = runpy.run_path(str(HERE / "helio_retention.py"))
BACKUP = runpy.run_path(str(HERE / "helio_state_backup.py"))
DAY = 86_400
SESSION_ARCHIVE_DAYS, SESSION_DELETE_DAYS = 30, 180
LEAD_SESSIONS_KEPT = 5
LOG_MAX_BYTES, LOG_KEEP = 5 * 1024 * 1024, 2
DAILY_KEPT, WEEKLY_KEPT = 7, 4
MEMORY_REPO = ".omo/memory/agents/elobot-ec289b4c/repo"


def _paths(state: Path, home: Path) -> dict[str, Path]:
    return {"approved": state / "housekeeping-approved", "last": state / "housekeeping-last.json",
            "sessions": home / ".omo/agent/sessions", "archive": home / ".omo/agent/sessions-archive",
            "backups": home / ".dori/elobot/backups", "logs": home / ".local/share/helio-chrome"}


def retention(state: Path, now: float, apply: bool) -> dict:
    values = RETENTION["params"](now)
    changed: dict[str, int] = {}
    skipped: dict[str, str] = {}
    for rule in RETENTION["RULES"]:
        path = state / rule.db
        if not rule.sql or not path.exists() or rule.table not in RETENTION["tables"](path):
            continue
        key = f"{rule.db}:{rule.table}"
        try:
            if apply:
                with closing(sqlite3.connect(path, timeout=5)) as db:
                    db.execute("BEGIN IMMEDIATE")
                    count = sum(db.execute(statement, values).rowcount for statement in rule.sql)
                    db.commit()
            else:
                # A preview counts on a private copy read through a read-only connection: no write lock, no write.
                with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)) as live, \
                        closing(sqlite3.connect(":memory:")) as copy:
                    live.backup(copy)
                    count = sum(copy.execute(statement, values).rowcount for statement in rule.sql)
        except sqlite3.OperationalError as error:
            # A store its owning code has not migrated yet: nothing of it is changed (the transaction rolls back), and it is reported.
            skipped[key] = str(error)
            continue
        if count:
            changed[key] = count
    return {"rows": changed, "skipped": skipped, "uncovered": RETENTION["uncovered"](state)}


def maintain(state: Path) -> list[str]:
    notes = []
    for path in sorted(state.glob("*.sqlite")):
        with closing(sqlite3.connect(path, timeout=5)) as db:
            db.execute("PRAGMA optimize")
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            pages, free = db.execute("PRAGMA page_count").fetchone()[0], db.execute("PRAGMA freelist_count").fetchone()[0]
            if pages and free * 2 > pages:
                try:
                    db.execute("VACUUM")
                    notes.append(f"vacuumed {path.name}")
                except sqlite3.OperationalError as error:
                    notes.append(f"vacuum skipped {path.name}: {error}")
    return notes


def worktrees(apply: bool, dori: list[str]) -> dict:
    try:
        result = subprocess.run([*dori, "reap-worktrees", "--json", *(["--apply"] if apply else [])], capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as error:
        return {"error": f"{type(error).__name__}: {error}"[:300]}
    if result.returncode:
        return {"error": (result.stderr or result.stdout).strip()[-300:]}
    rows = json.loads(result.stdout or "[]")
    # Reasons (and a removal's PR) stay in the report: they are what the owner reads to unblock a kept worktree.
    brief = lambda row: {"key": row["key"], "reason": row["reason"], **({"evidence": row["evidence"]} if row.get("evidence") else {})}
    return {action: [brief(row) for row in rows if row["action"] == action] for action in ("removed", "would_remove", "kept")}


def _protected_sessions(state: Path, sessions: Path) -> set[str]:
    keep: set[str] = set()
    for lane_file in (state / "lanes").glob("*.json"):
        lane = json.loads(lane_file.read_text())
        if not lane.get("closedAt") and lane.get("session"):
            keep.add(Path(lane["session"]).name.removesuffix(".jsonl").rsplit("_", 1)[-1])
    registry = state / "helio-lead-sessions.json"
    if registry.exists():
        keep.update(record.get("id", "") for record in json.loads(registry.read_text())[-LEAD_SESSIONS_KEPT:])
    for holder in sessions.rglob("session-holders/*/*.json"):
        try:
            os.kill(int(holder.stem), 0)
            keep.add(holder.parent.name)
        except (ValueError, ProcessLookupError):
            continue
        except PermissionError:
            keep.add(holder.parent.name)
    return keep


def _identity() -> str:
    """The lock record Omo's session mover writes, so Omo recognises this lock as held by a live process."""
    uptime = float(Path("/proc/uptime").read_text().split()[0])
    btime = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
    ticks = int(Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19])
    return json.dumps({"pid": os.getpid(), "bootAtMs": round(time.time() - uptime) * 1000,
                       "processStartedAtMs": int(btime + ticks / os.sysconf("SC_CLK_TCK")) * 1000})


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _move_lock(transcript: Path, session_id: str) -> tuple[Path, str] | None:
    """Omo's session move handshake: take move.lock, then prove no live holder. An opener does the reverse."""
    holders = transcript.parent / "session-holders" / urllib.parse.quote(session_id, safe="-_.!~*'()")
    holders.mkdir(parents=True, exist_ok=True)
    lock, mine = holders / "move.lock", _identity()
    temporary = holders / f"move.lock.{os.getpid()}.tmp"
    temporary.write_text(mine)
    try:
        os.link(temporary, lock)
    except FileExistsError:
        return None
    finally:
        temporary.unlink(missing_ok=True)
    if any(_alive(int(record.stem)) for record in holders.glob("*.json") if record.stem.isdigit()):
        _release(lock, mine)
        return None
    return lock, mine


def _release(lock: Path, mine: str) -> None:
    if lock.exists() and lock.read_text() == mine:
        lock.unlink()
    try:
        lock.parent.rmdir()
    except OSError:
        pass


def _lanes_by_session(state: Path) -> dict[str, dict]:
    lanes = {}
    for lane_file in [*(state / "lanes").glob("*.json"), *(state / "lanes/archive").glob("*.json")]:
        lane = json.loads(lane_file.read_text())
        if lane.get("session"):
            lanes[Path(lane["session"]).name.removesuffix(".jsonl").rsplit("_", 1)[-1]] = lane
    return lanes


def sessions(state: Path, paths: dict[str, Path], now: float, apply: bool) -> dict:
    root, archive = paths["sessions"], paths["archive"]
    if not root.exists():
        return {"archived": 0, "deleted": 0}
    keep = _protected_sessions(state, root)
    lanes = _lanes_by_session(state)
    archived = deleted = 0
    for transcript in sorted(root.glob("*/*.jsonl")):
        stem = transcript.name.removesuffix(".jsonl")
        session_id = stem.rsplit("_", 1)[-1]
        if session_id in keep or now - transcript.stat().st_mtime < SESSION_ARCHIVE_DAYS * DAY:
            continue
        if not apply:
            archived += 1
            continue
        held = _move_lock(transcript, session_id)
        if held is None:
            continue
        try:
            # Re-checked under the lock: a lane or lead may have started using the session since the scan.
            if (not transcript.exists() or now - transcript.stat().st_mtime < SESSION_ARCHIVE_DAYS * DAY
                    or session_id in _protected_sessions(state, root)):
                continue
            # Archive age counts from the session's last activity, so a long-idle session is not kept another 180 days.
            active = transcript.stat().st_mtime
            target = archive / transcript.parent.name
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            packed = target / f"{transcript.name}.gz"
            partial = packed.with_name(packed.name + ".partial")
            with transcript.open("rb") as source, gzip.open(partial, "wb") as sink:
                shutil.copyfileobj(source, sink)
            partial.replace(packed)
            os.utime(packed, (active, active))
            lane = lanes.get(session_id, {})
            # The index entry exists before the original goes, so an interrupted archive is always recoverable.
            with (archive / "index.jsonl").open("a") as index:
                index.write(json.dumps({"session": session_id, "project": transcript.parent.name, "lane": lane.get("key"),
                                        "job": lane.get("job"), "archived_at": int(now), "last_active": int(active), "path": str(packed),
                                        "original": str(transcript)}) + "\n")
            for sibling in [*transcript.parent.glob(f"{stem}.jsonl.*"), transcript.parent / f"{stem}-artifacts"]:
                if sibling.exists():
                    shutil.move(str(sibling), target / sibling.name)
                    os.utime(target / sibling.name, (active, active))
            transcript.unlink()
            archived += 1
        finally:
            _release(*held)
    if apply and archived:
        _prune_lead_registry(state, root)
    if archive.exists():
        for entry in archive.glob("*/*"):
            if now - entry.stat().st_mtime >= SESSION_DELETE_DAYS * DAY:
                deleted += 1
                if apply:
                    shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
        if apply and deleted:
            _prune_archive_index(archive / "index.jsonl")
    return {"archived": archived, "deleted": deleted}


def _prune_archive_index(index: Path) -> None:
    """Drops entries whose archive is gone, so the index stays as small as the archive itself."""
    if not index.exists():
        return
    lines = index.read_text().splitlines(keepends=True)
    kept = [line for line in lines if line.strip() and Path(json.loads(line).get("path", "")).exists()]
    if len(kept) != len(lines):
        partial = index.with_name(index.name + ".partial")
        partial.write_text("".join(kept))
        partial.replace(index)


def _prune_lead_registry(state: Path, sessions_root: Path) -> None:
    registry = state / "helio-lead-sessions.json"
    if not registry.exists():
        return
    with (state / "helio-lead-sessions.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        records = json.loads(registry.read_text())
        present = {path.name.removesuffix(".jsonl").rsplit("_", 1)[-1] for path in sessions_root.glob("*/*.jsonl")}
        kept = [record for index, record in enumerate(records)
                if index >= len(records) - LEAD_SESSIONS_KEPT or record.get("id") in present]
        if len(kept) != len(records):
            partial = registry.with_suffix(".partial")
            partial.write_text(json.dumps(kept, indent=2) + "\n")
            partial.chmod(0o600)
            partial.replace(registry)


def rotate_logs(paths: dict[str, Path], apply: bool) -> list[str]:
    rotated = []
    for log in paths["logs"].glob("*.log"):
        if log.stat().st_size <= LOG_MAX_BYTES:
            continue
        if not apply:
            rotated.append(log.name)
            continue
        for n in range(LOG_KEEP, 0, -1):
            older = log.with_name(f"{log.name}.{n}")
            if n == LOG_KEEP:
                older.unlink(missing_ok=True)
            else:
                older.exists() and older.rename(log.with_name(f"{log.name}.{n + 1}"))
        # Chrome holds the log open in append mode, so a rename would leave it writing to the rotated copy.
        # Copy, then truncate in place: its next append lands at the start of the same file.
        shutil.copy2(log, log.with_name(f"{log.name}.1"))
        os.truncate(log, 0)
        rotated.append(log.name)
    return rotated


def backup(state: Path, home: Path, paths: dict[str, Path], now: float) -> str:
    day = datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
    root = paths["backups"]
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = root / f"daily-{day:%Y%m%d}.tar.gz"
    with tempfile.TemporaryDirectory(dir=root) as temporary:
        staging = Path(temporary)
        BACKUP["snapshot"](state, staging / "state")
        memory = home / MEMORY_REPO
        if (memory / ".git").exists():
            bundle = subprocess.run(["git", "-C", str(memory), "bundle", "create", str(staging / "memory.bundle"), "--all"],
                                    capture_output=True, text=True, timeout=300)
            if bundle.returncode:
                raise RuntimeError(f"memory bundle failed: {bundle.stderr.strip()[-200:]}")
        partial = target.with_suffix(".partial")
        with tarfile.open(partial, "w:gz") as tar:
            for item in sorted(staging.iterdir()):
                tar.add(item, arcname=item.name)
        partial.chmod(0o600)
        partial.rename(target)
    archives = sorted(root.glob("daily-*.tar.gz"))
    weekly = {path for path in archives if datetime.datetime.strptime(path.name[6:14], "%Y%m%d").weekday() == 6}
    keep = set(archives[-DAILY_KEPT:]) | set(sorted(weekly)[-WEEKLY_KEPT:])
    for old in archives:
        if old not in keep:
            old.unlink()
    return target.name


def run(state: Path, home: Path, now: float, dori: list[str], approve: bool = False, preview: bool = False) -> dict:
    paths = _paths(state, home)
    if approve:
        paths["approved"].write_text(datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat())
    # A preview changes nothing on disk but its own report: no deletion, rotation, pruning or new backup.
    apply = paths["approved"].exists() and not preview
    result: dict = {"at": int(now), "mode": "applied" if apply else "dry-run", **retention(state, now, apply)}
    result["maintenance"] = maintain(state) if apply else []
    result["worktrees"] = worktrees(apply, dori)
    result["sessions"] = sessions(state, paths, now, apply)
    result["logs_rotated" if apply else "logs_to_rotate"] = rotate_logs(paths, apply)
    if not apply:
        result["backup"] = "not taken in a preview"
    else:
        try:
            result["backup"] = backup(state, home, paths, now)
        except (OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
            result["backup_error"] = f"{type(error).__name__}: {error}"[:300]
    paths["last"].write_text(json.dumps(result))
    return result


def summary(result: dict) -> str:
    trees = result["worktrees"]
    removed = len(trees.get("removed", [])) if "error" not in trees else "error"
    pending = "" if result["mode"] == "applied" else ' approve="helio housekeeping --approve-first-run"'
    backup = result.get("backup") or "failed"
    return (f'FOLLOWUP_HOUSEKEEPING mode={result["mode"]} rows={sum(result["rows"].values())} worktrees_removed={removed} worktrees_kept={len(trees.get("kept", []))} '
            f'worktrees_removable={len(trees.get("would_remove", []))} sessions_archived={result["sessions"]["archived"]} '
            f'uncovered={len(result["uncovered"])}{f" rules_skipped={len(skipped)}" if (skipped := result.get("skipped")) else ""} '
            f'backup={backup} read="helio housekeeping --last"{pending}')


def notable(result: dict) -> bool:
    """Report approval requests, problems and retained worktrees; quiet cleanup needs no notice."""
    trees = result["worktrees"]
    pending = result["mode"] == "dry-run" and (result["rows"] or trees.get("would_remove") or result["sessions"]["archived"]
                                              or result.get("logs_to_rotate"))
    return bool(pending or trees.get("kept") or result["uncovered"] or result.get("skipped") or "error" in trees or "backup_error" in result)


def due(state: Path, now: float) -> bool:
    last = state / "housekeeping-last.json"
    return not last.exists() or now - json.loads(last.read_text()).get("at", 0) >= DAY


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approve-first-run", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="report what would change without changing anything")
    parser.add_argument("--last", action="store_true", help="print the last result")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    if args.last:
        last = state / "housekeeping-last.json"
        print(last.read_text() if last.exists() else "HOUSEKEEPING never run")
        return 0
    result = run(state, Path.home(), time.time(), ["dori"], approve=args.approve_first_run, preview=args.dry_run)
    print(json.dumps(result) if args.json else summary(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
