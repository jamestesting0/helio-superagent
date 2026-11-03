#!/usr/bin/env python3
"""Read-only bug triage context: what main contains and what work already exists.

    helio triage "reveal opponent mention" --path cogs/final_commands.py

Prints the current origin/main commit, the commit Elo Bot is actually running
on Oracle (read-only `helio release inspect`) and what main has on top of it,
matching open and recently closed
issues, open pull requests that match or touch the given paths, Helio's active
lanes, and local branches with commits not yet on main. Changes nothing except
refreshing the origin/main remote-tracking ref.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
from pathlib import Path

RECENT_DAYS = 30


def run(argv: list[str], cwd: str | None = None) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout


def section(title: str, lines: list[str]) -> None:
    print(f"== {title}")
    print("\n".join(lines) if lines else "(none)")


def main_commit(project: str) -> list[str]:
    run(["git", "fetch", "--quiet", "origin", "main"], cwd=project)
    return [run(["git", "log", "-1", "--format=%H %cI %s", "origin/main"], cwd=project).strip()]


def deployed(project: str, paths: list[str]) -> list[str]:
    state = json.loads(run(["helio", "release", "inspect"]))
    head, tip = state.get("head") or "", state.get("tip") or ""
    if not head:
        raise RuntimeError("Oracle inspection did not report the running commit")
    running = f"running {head} ({'service active' if state.get('active') else 'SERVICE NOT ACTIVE'})"
    if head == tip:
        return [running, "same as origin/main"]
    newer = run(["git", "log", "--oneline", f"{head}..origin/main", "--", *paths], cwd=project).splitlines()
    touching = " touching those paths" if paths else ""
    return [running, f"origin/main has {len(newer)} newer commit(s){touching}; they go live at the next restart",
            *(f"  {commit}" for commit in newer[:15])]


def issues(repo: str, terms: str, now: datetime.datetime) -> list[str]:
    found = json.loads(run(["gh", "issue", "list", "--repo", repo, "--state", "all", "--search", terms,
                            "--limit", "30", "--json", "number,title,state,closedAt,url"]))
    cutoff = now - datetime.timedelta(days=RECENT_DAYS)
    keep = [i for i in found if i["state"] == "OPEN" or
            (i.get("closedAt") and datetime.datetime.fromisoformat(i["closedAt"].replace("Z", "+00:00")) >= cutoff)]
    return [f"#{i['number']} [{i['state'].lower()}] {i['title']} {i['url']}" for i in keep]


def pulls(repo: str, terms: str, paths: list[str]) -> list[str]:
    matched = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--search", terms,
                              "--json", "number,title,headRefName,url"]))
    lines = {p["number"]: f"#{p['number']} {p['title']} ({p['headRefName']}) {p['url']} [matches search]" for p in matched}
    if paths:
        for p in json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "50",
                                 "--json", "number,title,headRefName,url,files"])):
            touched = sorted({f["path"] for f in p.get("files", [])} & set(paths))
            if touched:
                lines[p["number"]] = f"#{p['number']} {p['title']} ({p['headRefName']}) {p['url']} [touches {', '.join(touched)}]"
    return [lines[n] for n in sorted(lines)]


def lanes(state_dir: str) -> list[str]:
    out = []
    for path in sorted(Path(state_dir, "lanes").glob("*.json")):
        lane = json.loads(path.read_text())
        if lane.get("status") != "closed":
            out.append(f"{path.stem} [{lane.get('status')}] {lane.get('title', '')} thread={lane.get('thread', 'none')}")
    return out


def branches(project: str, paths: list[str]) -> list[str]:
    out = []
    for branch in run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd=project).split():
        commits = run(["git", "log", "--oneline", f"origin/main..{branch}", "--", *paths], cwd=project).splitlines()
        if commits:
            out.append(f"{branch}: {len(commits)} commit(s) not on main, latest: {commits[0]}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("terms", nargs="+", help="search words describing the bug")
    parser.add_argument("--path", action="append", default=[], help="source file the bug likely lives in (repeatable)")
    args = parser.parse_args()
    repo = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
    project = os.environ.get("HELIO_PROJECT", str(Path.home() / "PythonProjects/elo-bot"))
    state_dir = os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))
    terms = " ".join(args.terms)
    now = datetime.datetime.now(datetime.timezone.utc)
    checks = [
        ("origin/main", lambda: main_commit(project)),
        ("Elo Bot on Oracle (what users are running)", lambda: deployed(project, args.path)),
        (f"issues: open or closed in the last {RECENT_DAYS} days", lambda: issues(repo, terms, now)),
        ("open pull requests", lambda: pulls(repo, terms, args.path)),
        ("active Helio lanes", lambda: lanes(state_dir)),
        ("local branches with work not on main" + (" touching those paths" if args.path else ""), lambda: branches(project, args.path)),
    ]
    failed = 0
    for title, check in checks:
        try:
            section(title, check())
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failed += 1
            section(title, [f"UNAVAILABLE: {error}"])
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
