#!/usr/bin/env python3
"""Read-only GitHub observations from the isolated runtime and its durable queue."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import sys


def queue_status(state: Path, repo: str) -> dict[str, str]:
    result = {"Last full sync": "Never recorded", "Pending syncs": "0", "Sync": "No recorded synchronization attempt", "Unfinished writes": "0"}
    path = state / "issue-sync.sqlite"
    if path.exists():
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(tracked)")}
            if {"last_outcome", "attempted_at", "completed_at", "last_warning"} <= columns:
                last = db.execute("SELECT issue,completed_at FROM tracked WHERE repo=? AND completed_at>0 ORDER BY completed_at DESC,issue LIMIT 1", (repo,)).fetchone()
                if last:
                    result["Last full sync"] = f"Latest completed issue sync: #{last[0]} <t:{last[1]}:f>"
                result["Pending syncs"] = str(db.execute("SELECT count(*) FROM tracked WHERE repo=? AND coalesce(last_outcome,'queued')!='complete'", (repo,)).fetchone()[0])
                scheduling = {"failure_kind", "failure_stage", "attempt_finished_at", "next_attempt_at", "review_required"} <= columns
                extra = ",failure_kind,failure_stage,attempt_finished_at,next_attempt_at,review_required" if scheduling else ""
                rows = db.execute(f"""SELECT issue,last_outcome,attempted_at,completed_at,last_warning{extra} FROM tracked
                                     WHERE repo=? ORDER BY attempted_at DESC,issue LIMIT 5""", (repo,)).fetchall()
                safe = runpy.run_path(str(Path(__file__).with_name("helio_issue_sync.py")))["safe_detail"]
                descriptions = []
                for row in rows:
                    issue, outcome, at, done, warning = row[:5]
                    detail = f"#{issue}: {outcome or 'not attempted'} | started " + (f"<t:{at}:f>" if at else "unknown")
                    detail += " | last complete " + (f"<t:{done}:f>" if done else "never")
                    if scheduling:
                        category, stage, ended, due, held = row[5:]
                        detail += " | ended " + (f"<t:{ended}:f>" if ended else "not recorded")
                        detail += " | next " + ("review required" if held else f"<t:{due}:R>" if due else "queued")
                        if category:
                            detail += f"\nLast failure: {category} at {stage}"
                    if warning:
                        detail += "\n" + safe(warning)[:240]
                    descriptions.append(detail)
                result["Sync"] = "\n".join(descriptions) or result["Sync"]
            elif columns:
                result["Pending syncs"] = "Unknown; legacy queue has no outcome receipts"
                result["Sync"] = "Legacy queue has no durable outcome receipts; completion is unknown"
    path = state / "issue-updates.sqlite"
    if path.exists():
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            count = db.execute("SELECT count(*) FROM operations WHERE repo=? AND completed=0", (repo,)).fetchone()[0]
            result["Unfinished writes"] = str(count)
    return result


def probe(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=8)
    except subprocess.TimeoutExpired:
        return "Timed out"
    except FileNotFoundError:
        return "Diagnostic executable unavailable"
    if result.returncode == 0:
        return "OK" + (f": {result.stdout.strip()[:250]}" if result.stdout.strip() else "")
    error = (result.stderr or result.stdout).lower()
    for tokens, label in (
        (("rate limit",), "Rate limited"),
        (("401", "bad credentials", "not logged"), "Authentication failed"),
        (("403", "forbidden"), "Permission denied"),
        (("resolve", "name resolution"), "DNS failure"),
        (("tls", "certificate", "ssl"), "TLS failure"),
        (("connecting", "connection", "network"), "Connection failed"),
    ):
        if any(token in error for token in tokens):
            return label
    return f"Failed (exit {result.returncode})"


def observe(state: Path, repo: str) -> dict[str, str]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid configured GitHub repository")
    result = {
        "Observed": datetime.now(timezone.utc).isoformat(),
        "Scope": "Read-only isolated-runtime probe. Access now does not prove a queued sync completed.",
        "DNS": probe([sys.executable, "-c",
                      "import socket; socket.getaddrinfo('api.github.com',443); print('api.github.com resolved')"]),
        "Identity": probe(["gh", "api", "user", "--jq", ".login"]),
        "REST issue #4": probe(["gh", "api", f"repos/{repo}/issues/4", "--jq", ".state"]),
        "GraphQL issue #4": probe(["gh", "issue", "view", "4", "--repo", repo, "--json", "state", "--jq", ".state"]),
        "Rate budget": probe(["gh", "api", "rate_limit", "--jq",
                              '{rest: .resources.core.remaining, graphql: .resources.graphql.remaining}']),
    }
    result.update(queue_status(state, repo))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))).resolve()
    result = observe(state, os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot"))
    print(json.dumps(result) if args.json else "\n".join(f"{key}: {value}" for key, value in result.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
