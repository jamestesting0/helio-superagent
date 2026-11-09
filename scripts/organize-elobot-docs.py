#!/usr/bin/env python3
"""Move installed operator runbooks without replacing local content."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "agent/runbooks/README.md"
RUNBOOKS = (
    "github-writing-workflow.md",
    "discord-qa-workflow.md",
    "beta-maintenance-workflow.md",
    "oracle-restart-workflow.md",
    "autofix-workflow.md",
    "issue-plan-workflow.md",
    "decisions-workflow.md",
    "issue-truth-workflow.md",
    "startup-recovery-workflow.md",
)
NEW_RUNBOOKS = ("github-writing-workflow.md", "beta-maintenance-workflow.md", "autofix-workflow.md", "issue-plan-workflow.md", "decisions-workflow.md", "issue-truth-workflow.md", "startup-recovery-workflow.md")


def validate(base: Path) -> None:
    """Refuse collisions and links outside the explicit compatibility layout."""
    for parent in (base, *base.parents):
        if parent.is_symlink():
            raise SystemExit(f"Unsafe installation directory: {parent}")
    if not base.is_dir():
        raise SystemExit(f"Missing installation: {base}")
    docs = base / "docs"
    if docs.is_symlink() or (docs.exists() and not docs.is_dir()):
        raise SystemExit(f"Unsafe documentation directory: {docs}")
    index = docs / "README.md"
    if index.is_symlink() or (index.exists() and not index.is_file()):
        raise SystemExit(f"Unsafe documentation index: {index}")
    for name in RUNBOOKS:
        old, new = base / name, docs / name
        if new.is_symlink() or (new.exists() and not new.is_file()):
            raise SystemExit(f"Unsafe runbook destination: {new}")
        if old.is_symlink():
            if os.readlink(old) != f"docs/{name}" or not new.is_file():
                raise SystemExit(f"Unexpected runbook link: {old}")
        elif old.exists():
            if not old.is_file() or new.exists():
                raise SystemExit(f"Runbook collision: {old} -> {new}")
        elif not new.is_file():
            if name not in NEW_RUNBOOKS:
                raise SystemExit(f"Missing runbook: {old}")


def organize(base: Path, apply: bool, contents: dict[str, bytes] | None = None) -> None:
    """Preserve installed bytes and modes, keeping legacy paths readable."""
    validate(base)
    docs = base / "docs"
    if apply:
        docs.mkdir(mode=0o700, exist_ok=True)
    for name in RUNBOOKS:
        old, new = base / name, docs / name
        if old.is_symlink():
            continue
        print(f"{'MOVE' if apply else 'PLAN'} {old} -> {new}; retain compatibility link")
        if apply:
            if old.exists():
                old.rename(new)
            elif not new.exists():
                if contents is None or name not in contents:
                    raise SystemExit(f"No content to install for new runbook: {new}")
                with new.open("xb") as output:
                    output.write(contents[name])
                new.chmod(0o600)
            old.symlink_to(f"docs/{name}")
    index = docs / "README.md"
    if not index.exists():
        print(f"{'INSTALL' if apply else 'PLAN'} {index}")
        if apply:
            with index.open("xb") as output:
                output.write(INDEX.read_bytes())
            index.chmod(0o600)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    organize(args.home.expanduser().absolute() / ".dori/elobot", args.apply)


if __name__ == "__main__":
    main()
