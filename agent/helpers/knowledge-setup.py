#!/usr/bin/env python3
"""Share EloBot memory with Helio sessions in the checkout and keep its monitor settings."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys


MONITOR_SETTINGS = {"monitorWakeBudget": 100, "monitorWakesPerHour": 3600}


def ensure_monitor_settings(path: Path) -> None:
    # omo pauses a monitor after a few monitor-only wakes and spaces wakes to
    # 12 an hour by default; Helio is woken only by monitors, so raise both.
    settings = json.loads(path.read_text()) if path.is_file() else {}
    terminal = settings.setdefault("terminal", {})
    if all(terminal.get(key, 0) >= value for key, value in MONITOR_SETTINGS.items()):
        return
    terminal.update({key: max(terminal.get(key, 0), value) for key, value in MONITOR_SETTINGS.items()})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"KNOWLEDGE_MONITOR_SETTINGS {path}")


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

    ensure_monitor_settings(project / ".omo/settings.json")

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


if __name__ == "__main__":
    main()
