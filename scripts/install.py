#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# Run: python3 scripts/install.py [--home HOME] [--project DIR] [--profile owner|isolated] [--apply]
"""Plan or install the portable Helio files without replacing existing files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import sys


ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = runpy.run_path(str(ROOT / "scripts/helio_payload.py"))
INBOUND_FILES = PAYLOAD["INBOUND_FILES"]
RUNBOOKS = PAYLOAD["RUNBOOKS"]


def plan(home: Path, project: Path, profile: str) -> list[tuple[Path, bytes, int]]:
    base = home / ".dori/elobot"
    mapping = PAYLOAD["values"](home, str(project), PAYLOAD["installed_values"](home))
    documents = PAYLOAD["documents"](profile, mapping)
    config = PAYLOAD["render_config"](mapping)
    config["defaultCwd"] = str(project)
    config["leadPane"] = ""
    files: list[tuple[Path, bytes, int]] = [
        (base / "setup-prompt.md", documents["setup-prompt.md"], 0o644),
        (base / "work-policy.md", documents["work-policy.md"], 0o644),
        (base / "docs/README.md", (ROOT / "agent/runbooks/README.md").read_bytes(), 0o644),
        *((base / "docs" / name, documents[name], 0o644) for name in RUNBOOKS),
        (base / "config.json", (json.dumps(config, indent=2) + "\n").encode(), 0o644),
        *((base / name, PAYLOAD["plain"](name).read_bytes(), 0o700) for name in PAYLOAD["EXECUTABLES"]),
        *((base / name, PAYLOAD["plain"](name).read_bytes(), 0o644) for name in PAYLOAD["HELPERS"]),
        *((base / "vendor/dori-mode" / name, (ROOT / "vendor/dori-mode" / name).read_bytes(), 0o644)
          for name in PAYLOAD["VENDOR_FILES"]),
        *((home / ".dori/discord-inbound" / name, (ROOT / "discord-inbound" / name).read_bytes(), 0o644)
          for name in INBOUND_FILES),
        *((base / "project-docs" / name, (ROOT / "elobot-checkout/docs" / name).read_bytes(), 0o644)
          for name in PAYLOAD["CHECKOUT_DOCS"]),
        (project / ".omo/omo.jsonc", (ROOT / "omo/omo.jsonc").read_bytes(), 0o644),
    ]
    if not (project / "AGENTS.md").exists():
        files.append((project / "AGENTS.md", (ROOT / "elobot-checkout/AGENTS.md").read_bytes(), 0o644))
    return files


def update_baseline(home: Path, files: list[tuple[Path, bytes, int]], profile: str) -> bytes:
    base = home / ".dori/elobot"
    keys = {base / name: name for name in PAYLOAD["MANAGED"]}
    keys.update({base / "docs" / name: name for name in RUNBOOKS})
    keys.update({home / ".dori/discord-inbound" / name: "@inbound/" + name for name in INBOUND_FILES})
    keys.update({base / "vendor/dori-mode/scripts/src/messenger" / name: "@messenger/" + name
                 for name in PAYLOAD["MESSENGER"]})
    recorded = {keys[path]: hashlib.sha256(data).hexdigest() for path, data, _ in files if path in keys}
    recorded.update(_configLeadPane="", _profile=profile)
    return (json.dumps(recorded, indent=2) + "\n").encode()


def install(home: Path, apply: bool, project: Path | None = None, profile: str = "isolated") -> int:
    print("Prerequisite: install the dori-mode skill and CLI from vendor/dori-mode (see docs/setup.md).")
    print("Existing destination files are not overwritten; the dori-mode installation is not modified.")
    configured = PAYLOAD["configured_project"](home, PAYLOAD["installed_values"](home))
    project = project or (Path(configured) if configured else home / "PythonProjects/elo-bot")
    files = plan(home, project, profile)
    base = home / ".dori/elobot"
    aliases = [(base / name, f"docs/{name}") for name in RUNBOOKS]
    files.append((base / ".sync-manifest.json", update_baseline(home, files, profile), 0o600))

    for destination in [path for path, _, _ in files] + [alias for alias, _ in aliases]:
        for path in (destination, *destination.parents):
            if path.is_symlink() or (path.exists() and (path == destination or not path.is_dir())):
                print(f"Refusing existing or unsafe path: {path}", file=sys.stderr)
                return 1

    print(f"Profile: {profile}; EloBot checkout: {project}")
    if PAYLOAD["CONFIG"]["config_path"](home).is_file():
        PAYLOAD["CONFIG"]["render"](home, apply)
    else:
        print("No ~/.config/helio/helio.env yet: env, beta and permission files are not generated (see docs/setup.md).")
    for destination, content, mode in files:
        if not apply:
            print(f"PLAN {destination}")
            continue
        try:
            missing = [path for path in destination.parents if not path.exists()]
            for directory in reversed(missing):
                directory.mkdir(mode=0o700, exist_ok=True)
            with destination.open("xb") as output:
                output.write(content)
            destination.chmod(mode)
            print(f"INSTALL {destination}")
        except OSError as error:
            print(f"Install failed at {destination}: {error}. The installation may be partial; "
                  "inspect and reconcile created files before retrying.", file=sys.stderr)
            return 1
    for alias, target in aliases:
        if not apply:
            print(f"PLAN {alias} -> {target}")
            continue
        try:
            alias.symlink_to(target)
            print(f"LINK {alias} -> {target}")
        except OSError as error:
            print(f"Install failed at {alias}: {error}. The installation may be partial; "
                  "inspect and reconcile created files before retrying.", file=sys.stderr)
            return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home(), help="destination home directory")
    parser.add_argument("--project", type=Path, help="existing EloBot checkout (default: HELIO_PROJECT)")
    parser.add_argument("--profile", choices=PAYLOAD["PROFILES"], default="isolated",
                        help="owner = your normal WSL account; isolated = the sandboxed helio-agent home")
    parser.add_argument("--apply", action="store_true", help="write files instead of only planning")
    args = parser.parse_args()
    project = args.project.expanduser().resolve() if args.project else None
    return install(args.home.expanduser().resolve(), args.apply, project, args.profile)


if __name__ == "__main__":
    raise SystemExit(main())
