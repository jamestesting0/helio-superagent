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
SYNC = runpy.run_path(str(HERE / "helio_issue_sync.py"))
FOLLOWUP = runpy.run_path(str(HERE / "helio_issue_followup.py"))
POSTS = runpy.run_path(str(HERE / "helio_github_posts.py"))
CLI = runpy.run_path(str(HERE / "helio_cli.py"))
ExampleParser, positive = CLI["ExampleParser"], CLI["positive"]
REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
STATE = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))


class Projection(TypedDict):
    status: str
    summary: str
    links: list[str]
    warnings: list[str]
    events: list[tuple[str, str, float]]
    discussed: int
    delivery: list[str]


def timestamp(value: str | None) -> float:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else 0.0


def human_comments(info: dict, login: str, since: float = 0) -> list[dict]:
    """Discussion by people; Helio's own log, plan and status comments are never decision input."""
    return [item for item in info.get("comments", [])
            if (item.get("author") or {}).get("login") != login and timestamp(item.get("createdAt")) > since]


def projection(issue: int, gh, transition: str | None = None) -> Projection:
    """Derive plan and linked-PR state; never promote checkout state to live."""
    info = json.loads(gh.command(["gh", "issue", "view", str(issue), "--repo", REPO, "--json",
                                  "state,stateReason,title,url,comments,closedByPullRequestsReferences"]))
    if transition:
        info.update(state="CLOSED", stateReason=transition.upper())
    plan = runpy.run_path(str(HERE / "helio-plan.py"))
    login = gh.command(["gh", "api", "user", "--jq", ".login"]).strip()
    plans = [plan["parse"](item.get("body", "")) for item in info.get("comments", [])
             if (item.get("author") or {}).get("login") == login and item.get("body", "").startswith(plan["MARKER"])
             and plan["intact"](issue, item["body"], plan["parse"](item["body"]))]
    parts = [f"{info.get('state', 'unknown')}: {info.get('stateReason') or 'reason unspecified'}"]
    summary = info.get("title") or "See current scope below."
    links = [f"https://github.com/{REPO}/issues/{issue}"]
    warnings = []
    delivery = []
    events: list[tuple[str, str, float]] = []
    discussed = int(max((timestamp(item.get("createdAt")) for item in human_comments(info, login)), default=0))
    if plans:
        data = plans[-1]
        if data:
            parts.append(f"Plan r{data['revision']}: {plan['status'](data)}")
            delivery.append(f"Plan r{data['revision']}: {plan['status'](data)}")
            if plan["approved"](data):
                summary = data["in_short"]
            links.extend(item["url"] for item in info.get("comments", []) if item.get("body", "").startswith(plan["MARKER"]) and (item.get("author") or {}).get("login") == login)
    pulls = {item["number"] for item in info.get("closedByPullRequestsReferences") or []}
    timeline = json.loads(gh.command(["gh", "api", "--paginate", "--slurp", f"repos/{REPO}/issues/{issue}/timeline"]))
    reopened_at = max((timestamp(event.get("created_at")) for page in timeline for event in page
                       if event.get("event") == "reopened"), default=0)
    for page in timeline:
        for event in page:
            source = (event.get("source") or {}).get("issue") or {}
            if source.get("pull_request") and re.fullmatch(rf"https://github\.com/{re.escape(REPO)}/pull/\d+", source.get("html_url", "")):
                pulls.add(source["number"])
    for number in sorted(pulls)[:20]:
        pr = {"number": number}
        detail = json.loads(gh.command(["gh", "pr", "view", str(pr["number"]), "--repo", REPO, "--json", "state,url,statusCheckRollup,mergeCommit,body,closingIssuesReferences,createdAt,mergedAt,closedAt"]))
        events.append((f"pr{number}:opened", f"PR #{number} opened {detail.get('url', '')}".strip(), timestamp(detail.get("createdAt"))))
        if detail["state"] == "MERGED":
            events.append((f"pr{number}:merged", f"PR #{number} merged", timestamp(detail.get("mergedAt"))))
        elif detail["state"] == "CLOSED":
            events.append((f"pr{number}:closed", f"PR #{number} closed without merging", timestamp(detail.get("closedAt"))))
        checks = [item.get("conclusion") or item.get("state") or item.get("status") for item in detail.get("statusCheckRollup") or []]
        parts.append(f"PR #{pr['number']}: {detail['state']} ({', '.join(checks) or 'checks unavailable'})")
        check_text = "checks passed" if checks and all(value == "SUCCESS" for value in checks) else "checks not fully verified"
        if any(value in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED") for value in checks):
            check_text = "checks need attention"
        delivery.append(f"[PR #{number}](https://github.com/{REPO}/pull/{number}) {detail['state'].lower()}; {check_text}")
        if detail.get("url"):
            links.append(detail["url"])
        implementation = ISSUE_LINK["parse"](detail.get("body", ""))
        closes = {item["number"] for item in detail.get("closingIssuesReferences") or []}
        merged_at = timestamp(detail.get("mergedAt"))
        historical = detail["state"] == "MERGED" and merged_at > 0 and reopened_at > merged_at
        if historical:
            parts.append(f"PR #{number}: historical completion before reopened work")
        elif implementation and implementation.issue == issue and implementation.complete:
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
            observed_at = observation.get("observed_at")
            age_at = timestamp(observed_at)
            age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(observed_at)).total_seconds() if observed_at else None
            if age is not None and 0 <= age <= 300 and observation.get("active") and observation.get("login_evidence") == "observed" and observation.get("running_revision"):
                comparison = gh.api(f"compare/{detail['mergeCommit']['oid']}...{observation['running_revision']}")
                if comparison.get("status") in ("ahead", "identical"):
                    parts.append(f"PR #{pr['number']} live revision observed; gateway health unverified")
                    delivery.append(f"Production revision `{observation['running_revision'][:12]}` observed; gateway health not verified")
                    events.append((f"pr{number}:live", f"PR #{number} observed running in production", age_at))
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
            delivery.append("Owner/author review required")
    return {"status": " · ".join(parts + warnings + ([] if any("live revision observed" in part for part in parts) else ["live state unverified"])),
            "summary": summary, "links": links, "warnings": warnings, "events": events, "discussed": discussed,
            "delivery": delivery + warnings}


def update_source(args) -> dict:
    """Who asked for this change, verified now and stored with the update (the PR controller trusts only the owner)."""
    plan = runpy.run_path(str(HERE / "helio-plan.py"))
    if args.question:
        plan["answered_question"](args.issue, args.question)
        path = STATE / "discord-questions.sqlite"
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            author = db.execute("SELECT answer_author FROM questions WHERE id=?", (args.question,)).fetchone()[0]
        return {"kind": "question", "id": args.question, "author": author}
    if not args.channel:
        raise ISSUES["Refused"]("--message needs --channel")
    source = plan["discord_message"](args.message, args.channel)
    try:
        author = source["verify_source"](source["payload"], source["live"], source["owner"], source["trusted"], source["channel_ok"])
    except source["Refused"] as error:
        raise ISSUES["Refused"](str(error)) from None
    return {"kind": "message", "id": args.message, "channel": args.channel, "author": author}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=ExampleParser)
    draft = sub.add_parser("render")
    draft.add_argument("--draft-file", type=Path, required=True)
    draft.add_argument("--output-file", type=Path, required=True)
    for name in ("update", "sync"):
        command = sub.add_parser(name, example="helio issue update --issue 23 --body-file /tmp/body.md --note-file /tmp/note.md"
                                 if name == "update" else None)
        command.add_argument("--issue", type=positive if name == "update" else int, required=True)
        command.add_argument("--body-file", type=Path)
        command.add_argument("--note-file", type=Path)
        command.add_argument("--adopt", help="SHA256 of the exact reviewed body")
        command.add_argument("--close", choices=("not_planned", "completed"))
        command.add_argument("--labels", nargs="+")
        if name == "update":
            command.add_argument("--question", help="the answered question this change records")
            command.add_argument("--message", help="the Discord message this change records; needs --channel")
            command.add_argument("--channel")
    followup = sub.add_parser("followup")
    followup.add_argument("--previous", type=int, required=True)
    followup.add_argument("--message")
    followup.add_argument("--channel")
    followup.add_argument("--grant", help="an owner decision recorded by helio pr phase decide")
    followup.add_argument("--related", action="store_true", help="link to an open issue instead of a closed one")
    followup.add_argument("--title", required=True)
    followup.add_argument("--body-file", type=Path, required=True)
    followup.add_argument("--labels", nargs="+", required=True)
    show = sub.add_parser("show")
    show.add_argument("issue", type=int)
    reviewed = sub.add_parser("reviewed")
    reviewed.add_argument("--issue", type=int, required=True)
    reviewed.add_argument("--reason-file", type=Path, required=True)
    resume = sub.add_parser("resume")
    resume.add_argument("--operation", required=True)
    cancel = sub.add_parser("cancel")
    cancel.add_argument("--operation", required=True)
    args = parser.parse_args()
    if getattr(args, "issue", 1) <= 0:
        parser.error("--issue must be positive")
    try:
        if args.command == "render":
            args.output_file.write_text(POSTS["issue_draft"](args.draft_file.read_text()))
            print(f"ISSUE_DRAFT_RENDERED {args.output_file}; no GitHub changes")
            return 0
        gh = ISSUES["Issues"](REPO, STATE)
        now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
        if args.command == "followup":
            if args.grant:
                granted = runpy.run_path(str(HERE / "helio-work.py"))["grant"](args.grant)
                if (not granted or "create" not in granted["permissions"] or granted["issue"] != args.previous
                        or granted["repo"] != REPO or granted["author"] != os.environ.get("DORI_DISCORD_OWNER_ID", "")):
                    raise ISSUES["Refused"]("The grant does not authorize creating an issue from this one.")
                channel, message = "grant", args.grant
            elif args.message and args.channel and not args.related:
                channel, message = args.channel, args.message
            else:
                raise ISSUES["Refused"]("followup needs --message and --channel, or --grant (required for --related)")
            number, url = FOLLOWUP["create"](gh, FOLLOWUP["Request"](
                args.previous, channel, message, args.title,
                args.body_file.read_text(), tuple(sorted(set(args.labels))), args.related))
            SYNC["schedule"](REPO, number)
            print(f"ISSUE_FOLLOWUP issue={number} previous={args.previous} url={url}; implementation authority is separate")
            return 0
        if args.command == "reviewed":
            reason = args.reason_file.read_text().strip()
            if not reason:
                raise ISSUES["Refused"]("A review reason is required.")
            SYNC["mark_reviewed"](STATE, REPO, args.issue, now, reason[:500])
            print(f"ISSUE_REVIEWED issue={args.issue}: description unchanged")
            return 0
        if args.command == "show":
            info = json.loads(gh.command(["gh", "issue", "view", str(args.issue), "--repo", REPO, "--json", "title,state,url,body,comments"]))
            login = gh.command(["gh", "api", "user", "--jq", ".login"]).strip()
            since = SYNC["reviewed_at"](STATE, REPO, args.issue)
            people = human_comments(info, login, since)
            print(f"{info.get('url')} [{info.get('state')}] {info.get('title')}\n\n{info.get('body') or ''}\n")
            print(f"== Comments by people since the last description review: {len(people)}")
            for item in people:
                print(f"- {(item.get('author') or {}).get('login')} at {item.get('createdAt')}: {item.get('body', '')[:2000]}")
            print("Helio's own comments are omitted: the description is the current truth.")
            return 0
        if args.command == "cancel":
            gh.cancel(args.operation)
            print("ISSUE_OPERATION_CANCELLED: saved history retained; external changes are not reverted")
            return 0
        if args.command == "resume":
            resource = gh.resource(args.operation)
            issue, operation = gh.resume(args.operation)
            print(f"{'PR_PUBLICATION_UPDATED' if resource == 'pr' else 'ISSUE_UPDATED'} issue={issue} operation={operation}")
            return 0
        if args.command == "sync":
            gh.publications(args.issue)
        facts = projection(args.issue, gh, args.close)
        change = {"projection": facts["status"], "summary": facts["summary"], "links": facts["links"],
                  "body": args.body_file.read_text() if args.body_file else None,
                  "note": args.note_file.read_text().strip() if args.note_file else "", "close": args.close,
                  "adopt": args.adopt, "labels": args.labels, "delivery": facts["delivery"]}
        if args.command == "update" and (args.question or args.message):
            change["source"] = update_source(args)
        if args.labels is None and "Plan " in change["projection"] and ": Approved" in change["projection"]:
            current = gh.get(args.issue)
            change["labels"] = [item["name"] for item in current.get("labels", []) if item["name"] != "needs-owner-review"]
        operation = gh.update(args.issue, change)
        if facts["discussed"]:
            SYNC["mark_discussed"](STATE, REPO, args.issue, facts["discussed"])
        if args.command == "update":
            SYNC["mark_reviewed"](STATE, REPO, args.issue, now)
        try:
            gh.log_milestones(args.issue, facts["events"])
        except ISSUES["Refused"] as error:
            detail = SYNC["safe_detail"](str(error))
            print(f"ISSUE_LOG_PENDING issue={args.issue}: progress comment retries on the next sync: {detail}")
            print("ISSUE_SYNC_PARTIAL " + json.dumps({"category": SYNC["failure_kind"](detail),
                "stage": error.stage, "detail": detail, "uncertain": error.uncertain}))
        for warning in facts["warnings"]:
            print(f"ISSUE_LINK_REVIEW issue={args.issue}: {warning}")
        if args.command == "update":
            sync = runpy.run_path(str(HERE / "helio_issue_sync.py"))
            sync["schedule"](REPO, args.issue)
        print(f"ISSUE_UPDATED issue={args.issue} operation={operation}")
    except (ISSUES["Refused"], FOLLOWUP["Refused"], ISSUE_LINK["Refused"], OSError, ValueError, sqlite3.Error) as error:
        detail = SYNC["safe_detail"](str(error))
        print(f"ISSUE_UPDATE_PENDING {detail}", file=sys.stderr)
        print("ISSUE_SYNC_FAILURE " + json.dumps({"category": SYNC["failure_kind"](detail),
            "stage": getattr(error, "stage", "issue_sync"), "detail": detail,
            "uncertain": getattr(error, "uncertain", False)}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
