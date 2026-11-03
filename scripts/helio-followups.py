#!/usr/bin/env python3
"""Tell requesters when their tracked issue is live or declined.

    helio followups add --issue N --channel C --user U --reply-to M [--kind bug|qol|feature]
    helio followups check | watch [--interval SECONDS] | done --issue N --user U | list

`check` prints one line per tracked issue with news:
  FOLLOWUP_LIVE      closed as completed and its merged fix is in the commit Elo Bot runs
  FOLLOWUP_DONE      closed as completed with no linked fix to verify
  FOLLOWUP_DECLINED  closed as not planned or duplicate
Each announcement repeats only after a restart of `watch`, until `done` records the reply.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
PROJECT = os.environ.get("HELIO_PROJECT", str(Path.home() / "PythonProjects/elo-bot"))
STATE = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
KINDS = ("bug", "qol", "feature")


def connect() -> sqlite3.Connection:
    STATE.mkdir(parents=True, exist_ok=True)
    path = STATE / "discord-conversations.sqlite"
    db = sqlite3.connect(path, timeout=10)
    path.chmod(0o600)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS followups (
        repo TEXT NOT NULL, issue INTEGER NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        reply_to TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'announced', 'done')),
        PRIMARY KEY (repo, issue, user_id))""")
    return db


def run(argv: list[str], cwd: str | None = None) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout


def snowflake(value: str) -> str:
    if not value.isdigit():
        raise argparse.ArgumentTypeError("must be a Discord ID")
    return value


def running_commit() -> str:
    head = json.loads(run(["helio", "release", "inspect"])).get("head") or ""
    if not head:
        raise RuntimeError("Oracle inspection did not report the running commit")
    return head


def is_live(merge_commit: str, head: str) -> bool:
    run(["git", "fetch", "--quiet", "origin", "main"], cwd=PROJECT)
    result = subprocess.run(["git", "merge-base", "--is-ancestor", merge_commit, head], cwd=PROJECT,
                            capture_output=True, text=True, timeout=60)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip()[-300:] or "git merge-base failed")
    return result.returncode == 0


def news(row: tuple, head_cache: dict) -> dict | None:
    issue, user_id, channel_id, reply_to, kind = row
    info = json.loads(run(["gh", "issue", "view", str(issue), "--repo", REPO, "--json",
                           "state,stateReason,title,url,closedByPullRequestsReferences,comments"]))
    if info.get("state") != "CLOSED":
        return None
    base = {"issue": issue, "title": info.get("title"), "url": info.get("url"), "kind": kind,
            "user_id": user_id, "channel_id": channel_id, "reply_to": reply_to}
    if info.get("stateReason") in ("NOT_PLANNED", "DUPLICATE"):
        comments = info.get("comments") or []
        reason = (comments[-1].get("body") or "")[:500] if comments else ""
        return {"event": "FOLLOWUP_DECLINED", **base, "reason": reason, "state_reason": info.get("stateReason")}
    fixes = []
    for pr in info.get("closedByPullRequestsReferences") or []:
        merged = json.loads(run(["gh", "pr", "view", str(pr["number"]), "--repo", REPO, "--json", "number,state,mergeCommit"]))
        if merged.get("state") == "MERGED" and (merged.get("mergeCommit") or {}).get("oid"):
            fixes.append((merged["number"], merged["mergeCommit"]["oid"]))
    if not fixes:
        return {"event": "FOLLOWUP_DONE", **base}
    if "head" not in head_cache:
        head_cache["head"] = running_commit()
    if all(is_live(commit, head_cache["head"]) for _, commit in fixes):
        return {"event": "FOLLOWUP_LIVE", **base, "pull_requests": [number for number, _ in fixes],
                "running_commit": head_cache["head"]}
    return None


def check(db: sqlite3.Connection, include_announced: bool) -> int:
    statuses = ("open", "announced") if include_announced else ("open",)
    rows = db.execute(f"SELECT issue, user_id, channel_id, reply_to, kind FROM followups WHERE repo = ? AND status IN ({','.join('?' * len(statuses))}) ORDER BY created_at",
                      (REPO, *statuses)).fetchall()
    head_cache: dict = {}
    failed = 0
    for row in rows:
        try:
            event = news(row, head_cache)
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failed += 1
            print(f"FOLLOWUP_WARN issue={row[0]} check unavailable: {error}", flush=True)
            continue
        if event:
            print(f"{event.pop('event')} {json.dumps(event)}", flush=True)
            db.execute("UPDATE followups SET status = 'announced' WHERE repo = ? AND issue = ? AND user_id = ?", (REPO, row[0], row[1]))
            db.commit()
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    add = sub.add_parser("add")
    add.add_argument("--issue", type=int, required=True)
    add.add_argument("--channel", type=snowflake, required=True)
    add.add_argument("--user", type=snowflake, required=True)
    add.add_argument("--reply-to", type=snowflake, required=True)
    add.add_argument("--kind", choices=KINDS, default="bug")
    done = sub.add_parser("done")
    done.add_argument("--issue", type=int, required=True)
    done.add_argument("--user", type=snowflake, required=True)
    sub.add_parser("check")
    watch = sub.add_parser("watch")
    watch.add_argument("--interval", type=int, default=1800)
    sub.add_parser("list")
    args = parser.parse_args()
    db = connect()
    if args.action == "add":
        db.execute("INSERT INTO followups (repo, issue, user_id, channel_id, reply_to, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                   "ON CONFLICT (repo, issue, user_id) DO UPDATE SET channel_id = excluded.channel_id, reply_to = excluded.reply_to, status = 'open'",
                   (REPO, args.issue, args.user, args.channel, args.reply_to, args.kind, int(time.time())))
        db.commit()
        print(f"FOLLOWUP_TRACKED issue={args.issue} user={args.user}")
    elif args.action == "done":
        changed = db.execute("UPDATE followups SET status = 'done' WHERE repo = ? AND issue = ? AND user_id = ?", (REPO, args.issue, args.user)).rowcount
        db.commit()
        if not changed:
            print(f"FOLLOWUP_UNKNOWN issue={args.issue} user={args.user}", file=sys.stderr)
            return 2
        print(f"FOLLOWUP_CLOSED issue={args.issue} user={args.user}")
    elif args.action == "list":
        for issue, user_id, kind, status in db.execute("SELECT issue, user_id, kind, status FROM followups WHERE repo = ? AND status != 'done' ORDER BY created_at", (REPO,)):
            print(f"FOLLOWUP issue={issue} user={user_id} kind={kind} status={status}")
    elif args.action == "check":
        return check(db, include_announced=True)
    else:
        first = True
        while True:
            check(db, include_announced=first)
            first = False
            time.sleep(args.interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
