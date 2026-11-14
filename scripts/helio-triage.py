#!/usr/bin/env python3
"""Read-only bug triage context: what main contains and what work already exists.

    helio triage "reveal opponent mention" --path elo_bot/extensions/final.py

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
from typing import TypedDict
from urllib.parse import urlencode

RECENT_DAYS = 30


class Issue(TypedDict):
    number: int
    title: str
    state: str
    closed_at: str | None
    html_url: str


class SearchPage(TypedDict):
    items: list[Issue]
    total_count: int
    incomplete_results: bool


class PullHead(TypedDict):
    ref: str


class Pull(TypedDict):
    number: int
    title: str
    head: PullHead
    html_url: str


class PullFile(TypedDict):
    filename: str


def run(argv: list[str], cwd: str | None = None) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout


def section(title: str, lines: list[str]) -> None:
    print(f"== {title}")
    print("\n".join(
        line.replace("\n", " ")[:480] + (" [truncated]" if len(line) > 480 else "")
        for line in lines[:25]) if lines else "(none)")
    print(f"({len(lines)} total; {max(0, len(lines) - 25)} omitted)")


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


def search(repo: str, terms: str, kind: str) -> tuple[list[Issue], bool]:
    """Consume search pages and retain GitHub's explicit incompleteness signal."""
    found: list[Issue] = []
    complete = True
    for page_number in range(1, 11):
        query = urlencode({"q": f"repo:{repo} is:{kind} {terms}", "per_page": 100, "page": page_number})
        page: SearchPage = json.loads(run(["gh", "api", f"/search/issues?{query}"]))
        found.extend(page["items"])
        complete = complete and not page["incomplete_results"]
        if len(found) >= page["total_count"]:
            return found, complete
        if len(page["items"]) < 100:
            return found, False
    # GitHub search exposes at most 1,000 hits, even when total_count is larger.
    return found, False


def issues(repo: str, terms: str, now: datetime.datetime) -> tuple[list[str], bool]:
    found, complete = search(repo, terms, "issue")
    cutoff = now - datetime.timedelta(days=RECENT_DAYS)
    keep = [i for i in found if i["state"].lower() == "open" or
            (i["closed_at"] and datetime.datetime.fromisoformat(i["closed_at"].replace("Z", "+00:00")) >= cutoff)]
    return [f"#{i['number']} [{i['state'].lower()}] {i['title']} {i['html_url']}" for i in keep], complete


def pulls(repo: str, terms: str, paths: list[str]) -> tuple[list[str], bool]:
    matched, complete = search(repo, f"is:open {terms}", "pr")
    lines: dict[int, str] = {}
    for issue in matched:
        pull: Pull = json.loads(run(["gh", "api", f"/repos/{repo}/pulls/{issue['number']}"]))
        lines[pull["number"]] = f"#{pull['number']} {pull['title']} ({pull['head']['ref']}) {pull['html_url']} [matches search]"
    if paths:
        page_number = 1
        while True:
            page: list[Pull] = json.loads(run(["gh", "api", f"/repos/{repo}/pulls?state=open&per_page=100&page={page_number}"]))
            for pull in page:
                route = f"/repos/{repo}/pulls/{pull['number']}"
                detail = json.loads(run(["gh", "api", route]))
                filenames: set[str] = set()
                file_count = 0
                file_page = 1
                while True:
                    files: list[PullFile] = json.loads(run(["gh", "api", f"{route}/files?per_page=100&page={file_page}"]))
                    file_count += len(files)
                    filenames.update(f["filename"] for f in files)
                    if len(files) < 100 or file_count >= 3000:
                        complete = complete and file_count == detail["changed_files"]
                        break
                    file_page += 1
                touched = sorted(filenames & set(paths))
                if touched:
                    lines[pull["number"]] = f"#{pull['number']} {pull['title']} ({pull['head']['ref']}) {pull['html_url']} [touches {', '.join(touched)}]"
            if len(page) < 100:
                break
            page_number += 1
    return [lines[n] for n in sorted(lines)], complete


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
        ("origin/main", lambda: (main_commit(project), True)),
        ("Elo Bot on Oracle (what users are running)", lambda: (deployed(project, args.path), True)),
        (f"issues: open or closed in the last {RECENT_DAYS} days", lambda: issues(repo, terms, now)),
        ("open pull requests", lambda: pulls(repo, terms, args.path)),
        ("active Helio lanes", lambda: (lanes(state_dir), True)),
        ("local branches with work not on main" + (" touching those paths" if args.path else ""), lambda: (branches(project, args.path), True)),
    ]
    failed = 0
    complete = True
    for title, check in checks:
        try:
            lines, checked_all = check()
            complete = complete and checked_all
            section(title, lines)
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failed += 1
            complete = False
            section(title, [f"UNAVAILABLE: {error}"])
    print(f"complete: {str(complete).lower()}")
    if not complete:
        print("Incomplete checks: do not assume no overlap.")
    return 1 if failed or not complete else 0


if __name__ == "__main__":
    raise SystemExit(main())
