#!/usr/bin/env python3
"""Tell requesters when their tracked issue is live or declined.

    helio followups check | watch [--interval SECONDS] | deliver --issue N --topic T | list | show N

A topic subscribes when an issue is linked to it (`helio conversation set TOPIC --issue URL`); its participants hear
the outcome together, one message per channel where they last spoke.

`check` prints one line per tracked issue with news:
  FOLLOWUP_LIVE      closed as completed and its merged fix is in the commit Elo Bot runs
  FOLLOWUP_DONE      closed as completed with no linked fix to verify
  FOLLOWUP_DECLINED  closed as not planned or duplicate
Monitor lines point to `helio followups show N`. Unhandled announcements recur as a count.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import runpy
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
PROJECT = os.environ.get("HELIO_PROJECT", str(Path.home() / "PythonProjects/elo-bot"))
STATE = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
KINDS = ("bug", "qol", "feature")
DELIVERY = runpy.run_path(str(Path(__file__).with_name("helio_followup_delivery.py")))


def read_stamp() -> str:
    """Read the deployed monitor version, including an absent initial stamp."""
    try:
        return (Path.home() / ".dori/elobot/monitors-version").read_text()
    except FileNotFoundError:
        return ""


def connect() -> sqlite3.Connection:
    STATE.mkdir(parents=True, exist_ok=True)
    DELIVERY["migrate"](STATE)
    path = STATE / "discord-conversations.sqlite"
    db = sqlite3.connect(path, timeout=10)
    path.chmod(0o600)
    db.execute("PRAGMA journal_mode=WAL")
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
    state = json.loads(run(["helio", "release", "inspect"]))
    head = state.get("running_revision") if state.get("login_evidence") == "observed" and state.get("active") else ""
    if not head:
        raise RuntimeError("Oracle inspection did not report the running commit")
    return head


def is_live(merge_commit: str, head: str) -> bool:
    result = subprocess.run(["git", "merge-base", "--is-ancestor", merge_commit, head], cwd=PROJECT,
                            capture_output=True, text=True, timeout=60)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip()[-300:] or "git merge-base failed")
    return result.returncode == 0


def news(row: tuple, head_cache: dict) -> dict | None:
    issue, topic, kind, created_at = row
    # One check can notify several people about the same issue; reuse only this pass's GitHub snapshot.
    issues = head_cache.setdefault("issues", {})
    if issue not in issues:
        issues[issue] = json.loads(run(["gh", "issue", "view", str(issue), "--repo", REPO, "--json",
                                      "state,stateReason,title,url,closedAt,labels,closedByPullRequestsReferences,comments"]))
    info = issues[issue]
    if info.get("state") != "CLOSED":
        return None
    requests = runpy.run_path(str(Path(__file__).with_name("helio_plan_requests.py")))
    requests["closed"](REPO, issue, datetime.datetime.now(datetime.timezone.utc))
    base = {"issue": issue, "title": info.get("title"), "url": info.get("url"), "kind": kind,
            "topic": topic}
    labels = {label.get("name") for label in info.get("labels") or []}
    base["kind"] = kind or next((name for name in ("bug", "qol", "feature") if name in labels), "bug")
    closed_at = info.get("closedAt")
    if closed_at and datetime.datetime.fromisoformat(closed_at.replace("Z", "+00:00")).timestamp() < created_at:
        return {"event": "FOLLOWUP_ALREADY_CLOSED", **base}
    if info.get("stateReason") in ("NOT_PLANNED", "DUPLICATE"):
        comments = info.get("comments") or []
        reason = (comments[-1].get("body") or "")[:500] if comments else ""
        return {"event": "FOLLOWUP_DECLINED", **base, "reason": reason, "state_reason": info.get("stateReason")}
    fixes = []
    pulls = head_cache.setdefault("pulls", {})
    for pr in info.get("closedByPullRequestsReferences") or []:
        if pr["number"] not in pulls:
            pulls[pr["number"]] = json.loads(run(["gh", "pr", "view", str(pr["number"]), "--repo", REPO, "--json", "number,state,mergeCommit"]))
        merged = pulls[pr["number"]]
        if merged.get("state") == "MERGED" and (merged.get("mergeCommit") or {}).get("oid"):
            fixes.append((merged["number"], merged["mergeCommit"]["oid"]))
    if not fixes:
        return {"event": "FOLLOWUP_DONE", **base}
    if "head" not in head_cache:
        head_cache["head"] = running_commit()
    if not head_cache["head"]:
        raise RuntimeError("Running revision and login evidence unavailable; keep follow-up pending")
    if not head_cache.get("fetched"):
        run(["git", "fetch", "--quiet", "origin", "main"], cwd=PROJECT)
        head_cache["fetched"] = True
    if all(is_live(commit, head_cache["head"]) for _, commit in fixes):
        return {"event": "FOLLOWUP_LIVE", **base, "pull_requests": [number for number, _ in fixes],
                "running_commit": head_cache["head"]}
    return None


def check(db: sqlite3.Connection, include_announced: bool, observation: dict | None = None) -> int:
    pending = db.execute("SELECT count(*) FROM followups WHERE repo = ? AND status = 'announced'", (REPO,)).fetchone()[0]
    if pending:
        print(f'FOLLOWUP_PENDING count={pending} read="helio followups list"', flush=True)
    statuses = ("open", "announced") if include_announced else ("open",)
    rows = db.execute(f"SELECT issue, anchor_message_id, kind, created_at FROM followups WHERE repo = ? AND status IN ({','.join('?' * len(statuses))}) AND (status = 'open' OR announcement IS NULL) ORDER BY created_at",
                      (REPO, *statuses)).fetchall()
    head_cache: dict = {}
    if observation is not None:
        head_cache["head"] = observation.get("running_revision") if observation.get("active") and observation.get("login_evidence") == "observed" else None
    failed = 0
    for row in rows:
        try:
            event = news(row, head_cache)
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failed += 1
            print(f"FOLLOWUP_WARN issue={row[0]} check unavailable: {error}".replace("\n", " ")[:1000], flush=True)
            continue
        if event and event["event"] == "FOLLOWUP_ALREADY_CLOSED":
            # Closed before Helio linked it: the linking reply already stated the outcome, so nobody is told twice.
            db.execute("UPDATE followups SET status='done' WHERE repo=? AND issue=? AND anchor_message_id=?", (REPO, row[0], row[1]))
            db.commit()
        elif event:
            prefix = event.pop("event")
            announcement = json.dumps({"event": prefix, **event})
            fields = {key: event[key] for key in ("issue", "topic", "kind")}
            fields.update(preview=str(event.get("title") or event.get("reason") or "")[:200],
                          read=f"helio followups show {row[0]}")
            encoded = json.dumps(fields)
            while len(prefix) + len(encoded) + 1 > 1000:
                fields["preview"] = fields["preview"][:-20]
                encoded = json.dumps(fields)
            db.execute("""UPDATE followups SET status='announced',announcement=?,observed_at=?
                WHERE repo=? AND issue=? AND anchor_message_id=?""", (announcement, int(time.time()), REPO, row[0], row[1]))
            db.commit()
            sync = runpy.run_path(str(Path(__file__).with_name("helio_issue_sync.py")))
            sync["schedule"](REPO, row[0])
            print(f"{prefix} {encoded}", flush=True)
    return 1 if failed else 0


def check_prs(custody_seen: set[str] | None = None) -> None:
    readiness = runpy.run_path(str(Path(__file__).with_name("helio_pr_readiness.py")))
    recovery = runpy.run_path(str(Path(__file__).with_name("helio_pr_recovery.py")))
    issues = runpy.run_path(str(Path(__file__).with_name("helio_issues.py")))
    store = issues["Issues"](REPO, STATE, command=lambda argv, _stdin=None: run(argv))
    for line in recovery["watch"](store, run, custody_seen if custody_seen is not None else set()):
        print(line, flush=True)
    for line in readiness["watch"](REPO, run, set(recovery["S"]["issues"](store))):
        print(line, flush=True)
    for line in runpy.run_path(str(Path(__file__).with_name("helio_merge_train.py")))["followups"](
            STATE, REPO, lambda number: readiness["check"](REPO, number, run)):
        print(line, flush=True)
    for line in runpy.run_path(str(Path(__file__).with_name("helio_obligations.py")))["surface"](STATE, REPO):
        print(line[:1000], flush=True)


ACTIVE_LANE = frozenset(("working", "paused", "done-claimed", "not-done"))
SETTLE = datetime.timedelta(minutes=20)


def check_work(now: datetime.datetime | None = None) -> None:
    """Report authorized or started issue work that has no PR and no active lane, and unstarted confirmed bugs."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    work = runpy.run_path(str(Path(__file__).with_name("helio-work.py")))
    readiness = runpy.run_path(str(Path(__file__).with_name("helio_pr_readiness.py")))
    lanes = runpy.run_path(str(Path(__file__).with_name("helio_task_lane.py")))
    try:
        grants, fixes = work["pending_work"](REPO)
        known, cutoff = work["known_issues"](REPO), work["cutoff"]()
        pulls = json.loads(run(["gh", "pr", "list", "--repo", REPO, "--state", "open", "--base", "main", "--limit", "10000",
                                "--json", "url,headRefName,isCrossRepository,closingIssuesReferences,labels"]))
        bugs = json.loads(run(["gh", "issue", "list", "--repo", REPO, "--state", "open", "--label", "bug", "--label", "confirmed",
                               "--limit", "200", "--json", "number,createdAt"]))
    except (RuntimeError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(f"FOLLOWUP_WARN work backstop unavailable: {error}".replace("\n", " ")[:1000], flush=True)
        return
    try:
        open_bugs = {int(bug["number"]) for bug in bugs}
        _due_work(now, work, readiness, lanes, grants, fixes, known, cutoff, pulls, bugs, open_bugs)
    except (RuntimeError, OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(f"FOLLOWUP_WARN work backstop unavailable: {type(error).__name__}: {error}".replace("\n", " ")[:1000], flush=True)


def _due_work(now, work, readiness, lanes, grants, fixes, known, cutoff, pulls, bugs, open_bugs) -> None:
    live: set[tuple[int, str]] = set()

    def emit(issue: int, kind: str, state: str, fields: dict) -> None:
        live.add((issue, kind))
        if work["should_emit"](REPO, issue, kind, state, now):
            print(f"{kind} {json.dumps({'issue': issue, **fields})}"[:1000], flush=True)

    def idle_lane(issue: int) -> tuple[str | None, str] | None:
        lane = lanes["lane_for_job"](STATE, f"issue-{issue}")
        if lane and lane["status"] in ACTIVE_LANE:
            return None
        return (lane["key"], lane["status"]) if lane else (None, "none")

    def is_open(issue: int) -> bool:
        if issue in open_bugs:
            return True
        try:
            return json.loads(run(["gh", "issue", "view", str(issue), "--repo", REPO, "--json", "state"]))["state"] == "OPEN"
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            print(f"FOLLOWUP_WARN issue={issue} state unavailable: {error}".replace("\n", " ")[:1000], flush=True)
            return False

    handled: set[int] = set()
    for grant in grants:
        handled.add(grant.issue)
        if grant.holds or grant.blocked or now - grant.recorded_at < SETTLE or readiness["open_for_issue"](pulls, grant.issue):
            continue
        lane = idle_lane(grant.issue)
        if lane and is_open(grant.issue):
            emit(grant.issue, "FOLLOWUP_PR_DUE", f"{lane[0]}:{lane[1]}", {"lane": lane[0], "status": lane[1],
                                                                        "reason": "authorized work has no PR and no active lane",
                                                        "resume": f"helio work start --issue {grant.issue} --from-authorization"})
    autofix_open = sum(any(label["name"] == "helio-autofix" for label in pull.get("labels") or []) for pull in pulls)
    for fix in fixes:
        issue = fix["issue"]
        handled.add(issue)
        if readiness["open_for_issue"](pulls, issue) or issue in {grant.issue for grant in grants}:
            continue
        if fix["status"] == "queued":
            if autofix_open < int(os.environ.get("HELIO_AUTOFIX_MAX_OPEN", "3")) and is_open(issue):
                emit(issue, "FOLLOWUP_BUGFIX_DUE", "capacity", {"reason": "capacity", "resume": f"helio bugfix start --issue {issue}"})
            continue
        lane = idle_lane(issue)
        if lane and now - datetime.datetime.fromisoformat(fix["updated_at"]) >= SETTLE and is_open(issue):
            emit(issue, "FOLLOWUP_PR_DUE", f"{lane[0]}:{lane[1]}", {"lane": lane[0], "status": lane[1],
                                                                  "reason": "started bug fix has no PR and no active lane",
                                                 "resume": f"helio bugfix start --issue {issue}"})
    for bug in bugs:
        issue = bug["number"]
        created = datetime.datetime.fromisoformat(bug["createdAt"].replace("Z", "+00:00"))
        if issue in known or issue in handled or created < cutoff or readiness["open_for_issue"](pulls, issue):
            continue
        emit(issue, "FOLLOWUP_BUGFIX_DUE", "no-record", {"reason": "no-record", "resume": f"helio bugfix start --issue {issue}"})
    work["settle_events"](REPO, live)


def daily_upkeep(housekeeping: dict) -> None:
    try:
        result = housekeeping["run"](STATE, Path.home(), time.time(), ["dori"])
        if housekeeping["notable"](result):
            print(housekeeping["summary"](result)[:1000], flush=True)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(f"FOLLOWUP_WARN housekeeping failed: {type(error).__name__}: {error}"[:1000], flush=True)
    try:
        stale = json.loads(run(["dori", "stale", "--hours", "24", "--json"]) or "[]")
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"FOLLOWUP_WARN lane review unavailable: {type(error).__name__}"[:1000], flush=True)
        return
    for lane in stale:
        print(f'FOLLOWUP_LANE_REVIEW key={lane["key"]} job={lane["job"]} status={lane["status"]} '
              f'age_hours={lane["age_hours"]} unpushed={str(lane["has_unpushed"]).lower()} read="dori show {lane["key"]}" audience=owner'[:1000], flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    deliver = sub.add_parser("deliver")
    deliver.add_argument("--issue", type=int, required=True)
    deliver.add_argument("--topic", type=snowflake, required=True)
    sub.add_parser("check")
    watch = sub.add_parser("watch")
    # A requester should hear about a closed issue within minutes; each poll is one `gh issue view` per open follow-up.
    watch.add_argument("--interval", type=int, default=300)
    listing = sub.add_parser("list")
    listing.add_argument("--offset", type=int, default=0)
    show = sub.add_parser("show")
    show.add_argument("issue", type=int)
    show.add_argument("--offset", type=int, default=0)
    oracle = sub.add_parser("oracle")
    oracle.add_argument("--event", type=int)
    oracle.add_argument("--done", action="store_true")
    args = parser.parse_args()
    if getattr(args, "offset", 0) < 0:
        parser.error("--offset must be nonnegative")
    db = connect()
    if args.action == "deliver":
        publication = runpy.run_path(str(Path(__file__).with_name("helio_plan_publication.py")))
        try:
            with publication["scope"](REPO, args.issue, serialize=False):
                code = DELIVERY["deliver"](db, STATE, REPO, args.issue, args.topic, news)
                if code == 2:
                    print(f'FOLLOWUP_RESUME command="helio followups deliver --issue {args.issue} --topic {args.topic}"')
                return code
        except (OSError, RuntimeError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
            print(f"FOLLOWUP_PENDING issue={args.issue} topic={args.topic}: {error}".replace("\n", " "))
            return 2
    elif args.action == "list":
        rows = db.execute("""SELECT f.issue, f.anchor_message_id, f.kind, f.status,
            (SELECT count(*) FROM topic_participants p WHERE p.anchor_message_id=f.anchor_message_id AND p.notify=1)
            FROM followups f WHERE f.repo = ? AND f.status != 'done' ORDER BY f.created_at,f.issue LIMIT 101 OFFSET ?""",
                          (REPO, args.offset)).fetchall()
        for issue, topic, kind, status, people in rows[:100]:
            print(f"FOLLOWUP issue={issue} topic={topic} kind={kind} status={status} participants={people} read=\"helio followups show {issue}\"")
        if len(rows) > 100:
            print(f"FOLLOWUP_PAGE next=\"helio followups list --offset {args.offset + 100}\"")
    elif args.action == "show":
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute("SELECT * FROM followups WHERE repo = ? AND issue = ? ORDER BY anchor_message_id", (REPO, args.issue))]
        for row in rows:
            row["participants"] = [person[0] for person in db.execute(
                "SELECT user_id FROM topic_participants WHERE anchor_message_id=? AND notify=1 ORDER BY user_id", (row["anchor_message_id"],))]
            row["deliveries"] = [dict(zip(("channel_id", "target", "users", "reply_id", "disposition"), group)) for group in db.execute(
                "SELECT channel_id,target,users,reply_id,disposition FROM followup_groups WHERE repo=? AND issue=? AND anchor_message_id=?",
                (REPO, args.issue, row["anchor_message_id"]))]
        if not rows:
            parser.error("unknown follow-up issue")
        for row in rows:
            if row["announcement"] is not None:
                row["announcement"] = json.loads(row["announcement"])
        text = json.dumps(rows)
        content = text[args.offset:args.offset + 6000]
        next_offset = args.offset + len(content)
        print(json.dumps({"issue": args.issue, "offset": args.offset, "content": content,
                          "truncated": next_offset < len(text),
                          "read_more": f"helio followups show {args.issue} --offset {next_offset}" if next_offset < len(text) else None}))
    elif args.action == "oracle":
        observer = runpy.run_path(str(Path(__file__).with_name("helio_observations.py")))
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='oracle_observations'").fetchone():
            print('{"phase":"unavailable","reason":"no observation yet"}')
            return 0
        if args.event:
            event = observer["detail"](db, args.event)
            if event is None:
                parser.error("unknown Oracle event")
            if args.done:
                db.execute("UPDATE oracle_events SET handled=1 WHERE id=?", (args.event,));db.commit()
                event["handled"] = True
            print(json.dumps(event))
        else:
            row = db.execute("SELECT data FROM oracle_observations WHERE singleton=1").fetchone()
            print(row[0] if row else '{"phase":"unavailable"}')
    elif args.action == "check":
        check_prs()
        return check(db, include_announced=True)
    else:
        stamp = read_stamp()
        check_seconds = min(30.0, float(os.environ.get("HELIO_STAMP_CHECK_SECONDS", "30")))
        if check_seconds <= 0:
            parser.error("HELIO_STAMP_CHECK_SECONDS must be positive")
        first = True
        custody_seen: set[str] = set()
        observer = runpy.run_path(str(Path(__file__).with_name("helio_observations.py")))
        decisions = runpy.run_path(str(Path(__file__).with_name("helio_decision_upkeep.py")))
        issue_sync = runpy.run_path(str(Path(__file__).with_name("helio_issue_sync.py")))
        housekeeping = runpy.run_path(str(Path(__file__).with_name("helio_housekeeping.py")))
        credential = runpy.run_path(str(Path(__file__).with_name("helio_health.py")))
        doctor = runpy.run_path(str(Path(__file__).with_name("helio_doctor.py")))
        while True:
            try:
                digest = decisions["check"](STATE, REPO)
                if digest:
                    print(f'FOLLOWUP_DECISION_DIGEST id={digest["id"]} read="helio decide digest --id {digest["id"]}" audience=owner', flush=True)
            except (OSError, ValueError, sqlite3.Error) as error:
                print(f"FOLLOWUP_WARN decision upkeep unavailable: {type(error).__name__}", flush=True)
            observation = observer["poll"](db, lambda: json.loads(run(["helio", "release", "inspect"])))
            check(db, include_announced=first, observation=observation)
            check_prs(custody_seen)
            check_work()
            plans = runpy.run_path(str(Path(__file__).with_name("helio-plan.py")))
            recovered = plans["PLAN_PUBLICATION"]["watch"](REPO, plans["GitHub"](REPO))
            if recovered:
                print(recovered[:1000], flush=True)
            events = observer["pending"](db)
            if events:
                print(f'FOLLOWUP_ORACLE_PENDING count={len(events)} oldest={events[0]} read="helio followups oracle --event {events[0]}" audience=owner', flush=True)
            for warning in issue_sync["reconcile"](STATE, REPO):
                print(f"FOLLOWUP_WARN issue sync pending: {warning}"[:1000], flush=True)
            for line in issue_sync["reminders"](STATE, REPO, int(time.time())):
                print(line, flush=True)
            try:
                incident = credential["github_incident"](STATE, REPO, lambda repo: doctor["github_access"](repo), time.time())
                if incident:
                    print(incident[:1000], flush=True)
            except OSError as error:
                print(f"FOLLOWUP_WARN GitHub credential check unavailable: {type(error).__name__}", flush=True)
            if housekeeping["due"](STATE, time.time()):
                daily_upkeep(housekeeping)
            first = False
            deadline = time.monotonic() + args.interval
            while True:
                new_stamp = read_stamp()
                if new_stamp and new_stamp != stamp:
                    version = next(iter(new_stamp.split()), "")[:100]
                    print(f"FOLLOWUP_WARN updated to {version}; restarting to load it", flush=True)
                    os.execv(sys.executable, [sys.executable, *sys.argv])
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(check_seconds, remaining))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
