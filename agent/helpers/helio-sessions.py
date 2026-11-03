#!/usr/bin/env python3
"""Track Helio lead sessions separately from other OmO project sessions."""
from __future__ import annotations

import fcntl
import json
import os
import re
import sys
import tempfile
import uuid
from pathlib import Path

ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HOME = Path.home()
STATE = Path(os.environ["DORI_STATE_DIR"])
PROJECT = str(Path(os.environ["HELIO_PROJECT"]).resolve())
ROOT = HOME / ".omo/agent/sessions"
REGISTRY = STATE / "helio-lead-sessions.json"


def session_path(session_id: str) -> Path | None:
    if not ID.fullmatch(session_id):
        return None
    for path in ROOT.rglob(f"*_{session_id}.jsonl"):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            with path.open(encoding="utf-8") as f:
                header = json.loads(f.readline())
            if (
                header.get("type") == "session"
                and header.get("id") == session_id
                and str(Path(header.get("cwd", "")).resolve()) == PROJECT
            ):
                return path
        except (OSError, ValueError, TypeError):
            continue
    return None


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("new", "latest"):
        print("usage: helio-sessions.py new|latest", file=sys.stderr)
        return 2
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = STATE / "helio-lead-sessions.lock"
    with lock.open("a") as f:
        os.chmod(lock, 0o600)
        fcntl.flock(f, fcntl.LOCK_EX)
        if REGISTRY.is_symlink():
            raise RuntimeError("refusing symlinked lead session registry")
        records = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else []
        if not isinstance(records, list):
            raise RuntimeError("invalid lead session registry")
        if sys.argv[1] == "latest":
            for rec in reversed(records):
                if not isinstance(rec, dict) or rec.get("project") != PROJECT:
                    continue
                path = session_path(rec.get("id", ""))
                if path:
                    holders = path.parent / "session-holders" / rec["id"]
                    for holder in holders.glob("*.json"):
                        try:
                            pid = int(holder.stem)
                            os.kill(pid, 0)
                        except (ValueError, ProcessLookupError):
                            continue
                        except PermissionError:
                            pass
                        print(
                            "Helio's latest lead session is already running; exit it before resuming.",
                            file=sys.stderr,
                        )
                        return 1
                    print(path)
                    return 0
            print(
                "No previous Helio lead session found for this project; use helio start.",
                file=sys.stderr,
            )
            return 1
        session_id = str(uuid.uuid4())
        records.append({"id": session_id, "project": PROJECT})
        fd, tmp = tempfile.mkstemp(prefix=".helio-sessions-", dir=STATE)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(records, f, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, REGISTRY)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        print(session_id)
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as e:
        print(f"Helio session error: {e}", file=sys.stderr)
        sys.exit(1)
