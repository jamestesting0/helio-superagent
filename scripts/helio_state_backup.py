#!/usr/bin/env python3
"""Snapshot state as its owning user, using SQLite backup for live WAL databases."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3


def snapshot(source: Path, destination: Path) -> dict[str, str]:
    destination.mkdir(parents=True, mode=0o700, exist_ok=False)
    hashes = {}
    for path in sorted(source.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.name.endswith(("-wal", "-shm", "-journal")):
            continue
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        with path.open("rb") as stream:
            sqlite = stream.read(16) == b"SQLite format 3\x00"
        if sqlite:
            with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as live, closing(sqlite3.connect(target)) as saved:
                live.backup(saved)
                saved.execute("PRAGMA journal_mode=DELETE")
                if saved.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError(f"SQLite integrity check failed: {relative}")
        else:
            shutil.copyfile(path, target)
        target.chmod(0o600)
        hashes[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
    (destination / "manifest.json").write_text(json.dumps(hashes, indent=2))
    (destination / "manifest.json").chmod(0o600)
    return hashes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    snapshot(args.state, args.destination)
    print(f"STATE_SNAPSHOT {args.destination}")


if __name__ == "__main__":
    main()
