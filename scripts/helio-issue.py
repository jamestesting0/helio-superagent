#!/usr/bin/env python3
"""Keep issue descriptions current: update or sync, preserving manual edits."""
import argparse
from contextlib import closing
import datetime
import json
import os
import re
from pathlib import Path
import runpy
import sqlite3
import sys
from typing import TypedDict

HERE = Path(__file__).resolve().parent
ISSUES = runpy.run_path(str(HERE / "helio_issues.py"))
ISSUE_LINK = runpy.run_path(str(HERE / "helio_issue_link.py"))
REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
STATE = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))


class Projection(TypedDict):
    status: str
    summary: str
    links: list[str]
    warnings: list[str]


def projection(issue: int, gh) -> Projection:
    """Derive plan and linked-PR state; never promote checkout state to live."""
    info = json.loads(gh.command(["gh", "issue", "view", str(issue), "--repo", REPO, "--json",
                                  "state,stateReason,title,url,comments,closedByPullRequestsReferences"]))
    plan = runpy.run_path(str(HERE / "helio-plan.py"))
    login = gh.command(["gh", "api", "user", "--jq", ".login"]).strip()
    plans = [plan["parse"](item.get("body", "")) for item in info.get("comments", [])
             if (item.get("author") or {}).get("login") == login and item.get("body", "").startswith(plan["MARKER"])
             and plan["intact"](issue, item["body"], plan["parse"](item["body"]))]
    parts = [f"{info.get('state', 'unknown')}: {info.get('stateReason') or 'reason unspecified'}"]
    summary = info.get("title") or "See current scope below."
    links = [f"https://github.com/{REPO}/issues/{issue}"]
    warnings = []
    if plans:
        data = plans[-1]
        if data:
            parts.append(f"Plan r{data['revision']}: {plan['status'](data)}")
            if plan["approved"](data):
                summary = data["in_short"]
            links.extend(item["url"] for item in info.get("comments", []) if item.get("body", "").startswith(plan["MARKER"]) and (item.get("author") or {}).get("login") == login)
    pulls = {item["number"] for item in info.get("closedByPullRequestsReferences") or []}
    timeline = json.loads(gh.command(["gh", "api", "--paginate", "--slurp", f"repos/{REPO}/issues/{issue}/timeline"]))
    for page in timeline:
        for event in page:
            source = (event.get("source") or {}).get("issue") or {}
            if source.get("pull_request") and re.fullmatch(rf"https://github\.com/{re.escape(REPO)}/pull/\d+", source.get("html_url", "")):
                pulls.add(source["number"])
    for number in sorted(pulls)[:20]:
        pr = {"number": number}
        detail = json.loads(gh.command(["gh", "pr", "view", str(pr["number"]), "--repo", REPO, "--json", "state,url,statusCheckRollup,mergeCommit,body,closingIssuesReferences"]))
        checks = [item.get("conclusion") or item.get("state") or item.get("status") for item in detail.get("statusCheckRollup") or []]
        parts.append(f"PR #{pr['number']}: {detail['state']} ({', '.join(checks) or 'checks unavailable'})")
        if detail.get("url"):
            links.append(detail["url"])
        implementation = ISSUE_LINK["parse"](detail.get("body", ""))
        closes = {item["number"] for item in detail.get("closingIssuesReferences") or []}
        if implementation and implementation.issue == issue and implementation.complete:
            if issue not in closes:
                warnings.append(f"PR #{number} claims complete scope but has no closing relationship to #{issue}")
            if detail["state"] == "MERGED" and info.get("state") == "OPEN":
                warnings.append(f"Complete PR #{number} merged; issue #{issue} remains open and needs completion reconciliation")
        elif detail["state"] == "MERGED" and info.get("state") == "OPEN" and not implementation:
            warnings.append(f"Legacy PR #{number} merged; issue #{issue} completion is unverified, not a new merge request")
        elif implementation and implementation.issue == issue and not implementation.complete:
            parts.append(f"PR #{number}: partial scope; issue stays open")
        observed_path = STATE / "discord-conversations.sqlite"
        if detail.get("mergeCommit") and observed_path.exists():
            with closing(sqlite3.connect(observed_path)) as db:
                exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='oracle_observations'").fetchone()
                row = db.execute("SELECT data FROM oracle_observations WHERE singleton=1").fetchone() if exists else None
            observation = json.loads(row[0]) if row else {}
            timestamp = observation.get("observed_at")
            age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(timestamp)).total_seconds() if timestamp else None
            if age is not None and 0 <= age <= 300 and observation.get("active") and observation.get("login_evidence") == "observed" and observation.get("running_revision"):
                comparison = gh.api(f"compare/{detail['mergeCommit']['oid']}...{observation['running_revision']}")
                if comparison.get("status") in ("ahead", "identical"):
                    parts.append(f"PR #{pr['number']} live revision observed at {timestamp}; gateway health unverified")
    ledger_path = STATE / "decisions.sqlite"
    if ledger_path.exists():
        ledger = runpy.run_path(str(HERE / "helio_decisions.py"))
        db = ledger["connect"](ledger_path)
        try:
            holds = ledger["holds"](db, REPO, {issue}, "merge") + ledger["holds"](db, REPO, {issue}, "restart")
            if info.get("state") == "CLOSED":
                for item in ledger["active"](db, REPO):
                    if item["scope"] == f"issue#{issue}" and not db.execute("SELECT 1 FROM decision_events WHERE decision_id=? AND event='review_issue_closed'", (item["id"],)).fetchone():
                        db.execute("INSERT INTO decision_events(decision_id,event,message_id,created_at) VALUES (?,'review_issue_closed','',?)",
                                   (item["id"], int(datetime.datetime.now().timestamp())))
                db.commit()
        finally:
            db.close()
        if holds:
            parts.append("On hold: owner/author review required")
    return {"status": " · ".join(parts + warnings + ([] if any("live revision observed" in part for part in parts) else ["live state unverified"])),
            "summary": summary, "links": links, "warnings": warnings}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("update", "sync"):
        command = sub.add_parser(name)
        command.add_argument("--issue", type=int, required=True)
        command.add_argument("--body-file", type=Path)
        command.add_argument("--note-file", type=Path)
        command.add_argument("--adopt", help="SHA256 of the exact reviewed body")
        command.add_argument("--close", choices=("not_planned", "completed"))
        command.add_argument("--reopen", action="store_true")
        command.add_argument("--labels", nargs="+")
    resume = sub.add_parser("resume")
    resume.add_argument("--operation", required=True)
    cancel = sub.add_parser("cancel")
    cancel.add_argument("--operation", required=True)
    args = parser.parse_args()
    if getattr(args, "issue", 1) <= 0:
        parser.error("--issue must be positive")
    try:
        gh = ISSUES["Issues"](REPO, STATE)
        if args.command in ("resume", "cancel"):
            with closing(sqlite3.connect(STATE / "issue-updates.sqlite")) as db, db:
                row = db.execute("SELECT issue,change FROM operations WHERE id=? AND repo=?", (args.operation, REPO)).fetchone()
                if row is not None and args.command == "cancel":
                    db.execute("UPDATE operations SET completed=2 WHERE id=?", (args.operation,))
                    print("ISSUE_OPERATION_CANCELLED: saved history retained; external changes are not reverted")
                    return 0
            if row is None:
                raise ISSUES["Refused"]("Unknown operation.")
            operation = gh.update(row[0], json.loads(row[1]))
            print(f"ISSUE_UPDATED issue={row[0]} operation={operation}")
            return 0
        facts = projection(args.issue, gh)
        change = {"projection": facts["status"], "summary": facts["summary"], "links": facts["links"],
                  "body": args.body_file.read_text() if args.body_file else None,
                  "note": args.note_file.read_text().strip() if args.note_file else "", "close": args.close,
                  "adopt": args.adopt, "labels": args.labels, "reopen": args.reopen}
        if args.close and args.reopen:
            raise ISSUES["Refused"]("Choose close or reopen.")
        if args.labels is None and "Plan " in change["projection"] and ": Approved" in change["projection"]:
            current = gh.get(args.issue)
            change["labels"] = [item["name"] for item in current.get("labels", []) if item["name"] != "needs-owner-review"]
        operation = gh.update(args.issue, change)
        for warning in facts["warnings"]:
            print(f"ISSUE_LINK_REVIEW issue={args.issue}: {warning}")
        if args.command == "update":
            sync = runpy.run_path(str(HERE / "helio_issue_sync.py"))
            sync["schedule"](REPO, args.issue)
        print(f"ISSUE_UPDATED issue={args.issue} operation={operation}")
    except (ISSUES["Refused"], ISSUE_LINK["Refused"], OSError, ValueError, sqlite3.Error) as error:
        print(f"ISSUE_UPDATE_PENDING {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
