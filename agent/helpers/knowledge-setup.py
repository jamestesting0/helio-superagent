#!/usr/bin/env python3
"""Share EloBot memory and fill missing local docs without replacing user files."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


def copy_docs(source: Path, destination: Path, conflicts: list[str]) -> None:
    if source.is_symlink():
        conflicts.append(f"source symlink requires review: {source}")
        return
    if destination.is_symlink():
        conflicts.append(f"destination symlink requires review: {destination}")
        return
    if source.is_dir():
        if destination.exists() and not destination.is_dir():
            conflicts.append(f"expected directory: {destination}")
            return
        destination.mkdir(exist_ok=True)
        for child in sorted(source.iterdir()):
            copy_docs(child, destination / child.name, conflicts)
    elif source.is_file():
        if destination.exists():
            if not destination.is_file() or source.read_bytes() != destination.read_bytes():
                conflicts.append(f"docs differ: {source} <> {destination}")
            return
        # Exclusive creation preserves a file created by another lane during setup.
        with source.open("rb") as incoming, destination.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        print(f"KNOWLEDGE_DOC_ADDED {destination}")
    else:
        conflicts.append(f"expected regular file or directory: {source}")


def main() -> None:
    home = Path.home()
    project = Path(os.environ.get("HELIO_PROJECT", str(home / "PythonProjects/elo-bot")))
    memory_home = home / ".omo/memory"
    override = os.environ.get("OMO_MEMORY_HOME", "").strip()
    if override and Path(override).resolve() != memory_home.resolve():
        sys.exit("KNOWLEDGE_ERROR OMO_MEMORY_HOME must resolve to ~/.omo/memory; refusing another store")

    # This pure-JSON project config is also valid JSONC for omo.
    config_path = project / ".omo/omo.jsonc"
    config = json.loads(config_path.read_text())
    memory = config.get("memory", {})
    if memory.get("agent") != "EloBot" or memory.get("enabled") is not True:
        sys.exit(f"KNOWLEDGE_ERROR expected memory.enabled=true and memory.agent=EloBot in {config_path}")
    if memory.get("sync", {}).get("enabled") is not False:
        sys.exit(f"KNOWLEDGE_ERROR keep memory.sync.enabled=false for this local alias in {config_path}")

    identity = "elobot-" + hashlib.sha256(b"EloBot").hexdigest()[:8]
    target = memory_home / "agents/elobot-ec289b4c"
    alias = memory_home / "agents" / identity
    if not (target / "repo/.git").is_dir() or not (target / "repo/system").is_dir():
        sys.exit(f"KNOWLEDGE_ERROR existing memory repository is missing: {target / 'repo'}")
    if not (target / "runtime/locks").is_dir():
        sys.exit(f"KNOWLEDGE_ERROR existing memory runtime/locks is missing: {target}")
    try:
        alias.symlink_to(target, target_is_directory=True)
    except FileExistsError:
        if not alias.is_symlink() or alias.resolve() != target.resolve():
            sys.exit(f"KNOWLEDGE_ERROR refusing occupied identity path: {alias}; expected link to {target}")
    # Link the whole root, not just repo, so all sessions use the same on-disk locks and queues.
    print(f"KNOWLEDGE_MEMORY {identity} -> {target} (repo and runtime/locks shared)")

    conflicts: list[str] = []
    copy_docs(home / ".dori/elobot/project-docs", project / "docs", conflicts)
    if conflicts:
        for conflict in conflicts:
            print(f"KNOWLEDGE_CONFLICT {conflict}", file=sys.stderr)
        sys.exit(
            "KNOWLEDGE_ERROR docs preserved; compare the listed source and destination, "
            "reconcile intentionally, then rerun. No files were overwritten or deleted."
        )
    print(f"KNOWLEDGE_READY docs match source; unrelated destination files retained: {project / 'docs'}")


if __name__ == "__main__":
    main()
