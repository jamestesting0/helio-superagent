#!/usr/bin/env python3
"""Start fixing a confirmed bug without asking: helio bugfix start --issue N [--message M --channel C] [--skip TEXT].

Run it right after creating or finding a confirmed bug issue, before acknowledging the report. A report from the owner
or a current trusted user (verified like a work request) is the fix request: route `work`, uncapped, through
`helio pr submit`. Anyone else, Elo Bot, or a source that can no longer be verified uses standing autofix: route
`autofix`, through `helio autofix submit` and its gates. The lane gets a rendered brief and a PR-based Done signal.

  BUGFIX_STARTED issue=N route=work|autofix key=K launch=...   lane launched or resumed
  BUGFIX_EXISTS issue=N pr=URL                                 an open PR already implements it
  BUGFIX_QUEUED issue=N reason=autofix-cap                     the follow-up watcher reports when capacity returns
  BUGFIX_SKIPPED issue=N reason=...                            disabled, overlap or the requester's own "just log it"
  BUGFIX_BLOCKED issue=N reason=...                            a recorded blocker; a new request supersedes it
  BUGFIX_REFUSED ...                                           not an open issue labelled bug and confirmed
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PLAN = runpy.run_path(str(HERE / "helio-plan.py"))
WORK = PLAN["WORK"]
LANE = PLAN["LANE"]
READINESS = runpy.run_path(str(HERE / "helio_pr_readiness.py"))
REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
AUTOFIX_AUTHORITY = ("Standing automatic-fix authority for this confirmed bug: `helio autofix submit` is the only push and "
                     "PR path, and its proof, size, path and rate gates are binding.")


class Refused(RuntimeError):
    pass


def skip(github, issue: int, reason: str, now: datetime.datetime, *, label: bool) -> str:
    WORK["save_bugfix"](REPO, issue, now, status="skipped", reason=reason)
    if label:
        github.run(["gh", "issue", "edit", str(issue), "--repo", REPO, "--add-label", "needs-owner-review"])
    return f"BUGFIX_SKIPPED issue={issue} reason={json.dumps(reason)}"


def overlap(pulls: list[dict], issue: int) -> str | None:
    reference = re.compile(rf"(?:{re.escape(REPO)})?#0*{issue}\b|https://github\.com/{re.escape(REPO)}/issues/0*{issue}\b")
    canonical = READINESS["canonical_branches"](issue)
    for pull in pulls:
        if pull["headRefName"] not in canonical and (
                any(ref.get("number") == issue for ref in pull.get("closingIssuesReferences") or [])
                or reference.search(f"{pull.get('body') or ''}\n{pull.get('title') or ''}")):
            return pull["url"]
    return None


def start(args: argparse.Namespace, github, discord, now: datetime.datetime) -> str:
    issue = json.loads(github.run(["gh", "issue", "view", str(args.issue), "--repo", REPO, "--json", "state,title,labels"]))
    labels = {label["name"] for label in issue.get("labels") or []}
    if issue.get("state") != "OPEN" or not {"bug", "confirmed"} <= labels:
        raise Refused(f"issue #{args.issue} must be open and labelled bug and confirmed")
    pulls = json.loads(github.run(["gh", "pr", "list", "--repo", REPO, "--state", "open", "--limit", "10000", "--json",
                                   "url,headRefName,isCrossRepository,closingIssuesReferences,body,title,labels"]))
    mine = READINESS["open_for_issue"](pulls, args.issue)
    if mine:
        return f"BUGFIX_EXISTS issue={args.issue} pr={mine[0]['url']}"
    row = WORK["bugfix"](REPO, args.issue)
    if args.skip:
        return skip(github, args.issue, f"requester: {' '.join(args.skip.split())[:280]}", now, label=False)
    if row and row["status"] in ("skipped", "blocked"):
        return f"BUGFIX_{row['status'].upper()} issue={args.issue} reason={json.dumps(row['reason'] or '')}"
    if os.environ.get("HELIO_AUTOFIX", "on") != "on":
        return skip(github, args.issue, "disabled: HELIO_AUTOFIX is off", now, label=True)
    other = overlap(pulls, args.issue)
    if other:
        return skip(github, args.issue, f"overlap: {other}", now, label=True)

    route = row["route"] if row else "autofix"
    message, channel = (row["message"], row["channel"]) if row else (args.message, args.channel)
    note = ""
    if not row and args.message and args.channel:
        try:
            source = discord(args.message, args.channel)
            if (source.get("live") or {}).get("_helio_accepted_work"):
                # Only a pending, fresh report becomes uncapped work; an acknowledged one keeps standing autofix.
                note = ' source_unverified="report already acknowledged"'
            else:
                request = argparse.Namespace(issue=args.issue, message=args.message, channel=args.channel, now=now, hold=None)
                PLAN["authorize_work"](request, github, source, "bug-report")
                route = "work"
        except PLAN["Refused"] as error:
            note = f" source_unverified={json.dumps(str(error)[:200])}"
    if route == "autofix" and (not row or row["status"] == "queued"):
        count = sum(any(label["name"] == "helio-autofix" for label in pull.get("labels") or []) for pull in pulls)
        if count >= int(os.environ.get("HELIO_AUTOFIX_MAX_OPEN", "3")):
            WORK["save_bugfix"](REPO, args.issue, now, route=route, status="queued", reason="autofix-cap",
                                message=message, channel=channel)
            return f"BUGFIX_QUEUED issue={args.issue} reason=autofix-cap"
    holds: tuple[str, ...] = ()
    if route == "work":
        grant = WORK["available"](REPO, args.issue, now, include_used=True)
        if grant.blocked:
            return f"BUGFIX_BLOCKED issue={args.issue} reason={json.dumps(grant.blocked)}"
        holds = grant.holds
    WORK["save_bugfix"](REPO, args.issue, now, route=route, status="starting", reason=None, message=message, channel=channel)

    if route == "work":
        authority, author = PLAN["work_authority"](grant), grant.author
        source = f"discord:{grant.channel}:{grant.message}"
    else:
        authority, author = AUTOFIX_AUTHORITY, ""
        source = f"discord:{channel}:{message}" if message and channel else f"github:{REPO}#{args.issue}"
    owner = os.environ.get("DORI_DISCORD_OWNER_ID", "")
    task = LANE["Task"](REPO, args.issue, issue["title"], route, authority, source,
                        "owner" if author and author == owner else "normal", holds)
    try:
        key, launch = LANE["start"](task, Path(os.environ["HELIO_PROJECT"]).expanduser().resolve())
    except RuntimeError as error:
        raise RuntimeError(f"lane launch failed: {error}") from None
    WORK["save_bugfix"](REPO, args.issue, now, status="started", lane=key)
    return f"BUGFIX_STARTED issue={args.issue} route={route} key={key} launch={launch}{note}"


def main(argv: list[str] | None = None, github=None, discord=None, now: datetime.datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    starter = commands.add_parser("start")
    starter.add_argument("--issue", type=int, required=True)
    starter.add_argument("--message", help="the report's Discord message ID (before acknowledging it)")
    starter.add_argument("--channel", help="the report's channel ID")
    starter.add_argument("--skip", help="only the requester's own words asking to log it without a fix")
    args = parser.parse_args(argv)
    if args.issue < 1:
        parser.error("--issue must be positive")
    if bool(args.message) != bool(args.channel):
        parser.error("--message and --channel go together")
    try:
        print(start(args, github or PLAN["GitHub"](REPO), discord or PLAN["discord_message"],
                    now or datetime.datetime.now(datetime.timezone.utc)))
        return 0
    except (Refused, WORK["Refused"]) as error:
        print(f"BUGFIX_REFUSED {error}".replace("\n", " "))
        return 1
    except (RuntimeError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        resume = " ".join(["helio", "bugfix", *(argv if argv is not None else sys.argv[1:])])
        print(f"BUGFIX_PENDING issue={args.issue} detail={json.dumps(str(error)[:300])} resume={json.dumps(resume)}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
