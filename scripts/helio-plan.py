#!/usr/bin/env python3
"""Opt-in issue plans: helio plan post|approve|check|show|drop|list and helio pr submit.

A plan is one comment on the issue, rendered from structured fields. The comment carries
its own fields (base64 JSON), so GitHub is the only store. An approval binds a hash of
the content fields; the status line, revision history, technical notes and approval line
are outside the hash. The whole body is a pure function of the fields, so any hand edit
on GitHub is detected and never silently approved.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import closing
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import sys
import tempfile
from typing import Callable, Protocol


class DiscordReader(Protocol):
    def __call__(self, message_id: str, channel: str | None = None, fingerprint: str | None = None) -> dict: ...

HERE = Path(__file__).resolve().parent
ISSUE_LINK = runpy.run_path(str(HERE / "helio_issue_link.py"))
WORK = runpy.run_path(str(HERE / "helio-work.py"))
REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
MARKER = "<!-- helio-plan v1 -->"
DATA = re.compile(r"<!-- helio-plan-data:([A-Za-z0-9+/=]+) -->\s*\Z")
LABEL = "helio-plan"
HASHED = ("title", "size", "live_beta", "in_short", "why", "scope", "decisions", "open_questions", "done_when", "risks")
FIELDS = set(HASHED) | {"technical_notes", "change_note"}
SIZES = ("Small", "Medium", "Large")
LEVELS = ("Low", "Medium", "High")
VISIBLE_LIMIT = 2500
ANNOUNCE_LIMIT = 500
CODE = re.compile(r"```|\b[\w.-]+/[\w./-]*\w\.[A-Za-z]{1,5}\b|\b\w+\.(?:py|ts|js|json|md|sql|toml|ya?ml)\b|\b\w+\(\)")
FILLER = re.compile(r"\b(?:TBD|TODO|etc)\b", re.I)
PLAN_PATTERN = re.compile(r"^\W*Plan for #(\d+) \(r(\d+)\)")
PLAN_REQUEST = re.compile(r"\b(?:plan|planning|finali[sz]e|finali[sz]ing)\b", re.I)
REQUEST_MAX_AGE = datetime.timedelta(hours=72)


class Refused(Exception):
    pass


def helio_decided(decision: dict) -> bool:
    return decision["decided_by"].strip().lower() in ("helio", "helio's recommendation")


def content_hash(data: dict) -> str:
    fields = {key: data.get(key) for key in HASHED}
    if "github_edit" in data:
        fields["github_edit"] = data["github_edit"]
    canonical = json.dumps(fields, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def validate(data: object, revision: int) -> list[tuple[str, str]]:
    if not isinstance(data, dict):
        return [("plan", "must be a JSON object")]
    errors: list[tuple[str, str]] = [(key, "unknown field") for key in sorted(set(data) - FIELDS)]

    def text(field: str, value: object, limit: int, words: bool = False) -> None:
        if not isinstance(value, str) or not value.strip():
            errors.append((field, "required text"))
            return
        size = len(value.split()) if words else len(value)
        if size > limit:
            errors.append((field, f"over {limit} {'words' if words else 'characters'}"))
        if field != "technical_notes" and CODE.search(value):
            errors.append((field, "no code, file paths or function names outside technical_notes"))
        if FILLER.search(value):
            errors.append((field, "no TBD, TODO or etc.; decide or ask an open question"))

    def items(field: str, value: object, low: int, high: int) -> list:
        if not isinstance(value, list) or not low <= len(value) <= high:
            errors.append((field, f"needs {low}-{high} items"))
            return []
        return value

    text("title", data.get("title"), 70)
    if data.get("size") not in SIZES:
        errors.append(("size", "must be Small, Medium or Large"))
    beta = data.get("live_beta")
    if not isinstance(beta, str) or not (beta == "Not planned" or beta.startswith("Requested by ")):
        errors.append(("live_beta", 'must be "Not planned" or "Requested by <name>: <what>"'))
    else:
        text("live_beta", beta, 120)
    text("in_short", data.get("in_short"), 40, words=True)
    for index, reason in enumerate(items("why", data.get("why"), 1, 3)):
        text(f"why[{index}]", reason, 25, words=True)
    scope = data.get("scope")
    if not isinstance(scope, dict) or set(scope) - {"changes", "not_included"}:
        errors.append(("scope", "must contain changes and optional not_included only"))
        scope = {}
    changes = items("scope.changes", scope.get("changes"), 1, 6)
    for index, change in enumerate(changes):
        if not isinstance(change, dict) or set(change) != {"where", "today", "after"}:
            errors.append((f"scope.changes[{index}]", "needs where, today and after"))
            continue
        for key in ("where", "today", "after"):
            text(f"scope.changes[{index}].{key}", change[key], 80)
    for index, item in enumerate(items("scope.not_included", scope.get("not_included", []), 0, 3)):
        text(f"scope.not_included[{index}]", item, 80)
    for index, decision in enumerate(items("decisions", data.get("decisions", []), 0, 6)):
        if not isinstance(decision, dict) or set(decision) != {"question", "decision", "decided_by"}:
            errors.append((f"decisions[{index}]", "needs question, decision and decided_by"))
            continue
        text(f"decisions[{index}].question", decision["question"], 100)
        text(f"decisions[{index}].decision", decision["decision"], 100)
        text(f"decisions[{index}].decided_by", decision["decided_by"], 60)
    for index, question in enumerate(items("open_questions", data.get("open_questions", []), 0, 4)):
        text(f"open_questions[{index}]", question, 200)
    afters = [c["after"].strip().lower() for c in changes if isinstance(c, dict) and isinstance(c.get("after"), str)]
    for index, check in enumerate(items("done_when", data.get("done_when", []), 0, 4)):
        text(f"done_when[{index}]", check, 120)
        if isinstance(check, str) and any(len(after) >= 4 and after in check.lower() for after in afters):
            errors.append((f"done_when[{index}]", "repeats a Scope row; Scope rows are already checked in the PR"))
    for index, risk in enumerate(items("risks", data.get("risks", []), 0, 3)):
        if not isinstance(risk, dict) or set(risk) != {"level", "what", "mitigation"} or risk.get("level") not in LEVELS:
            errors.append((f"risks[{index}]", "needs level (Low/Medium/High), what and mitigation"))
            continue
        text(f"risks[{index}].what", risk["what"], 120)
        text(f"risks[{index}].mitigation", risk["mitigation"], 120)
    notes = data.get("technical_notes", "")
    if notes:
        text("technical_notes", notes, 600)
        if isinstance(notes, str) and "```" in notes:
            errors.append(("technical_notes", "no code blocks"))
    if revision > 1:
        text("change_note", data.get("change_note"), 120)
    elif "change_note" in data:
        text("change_note", data.get("change_note"), 120)
    return errors


def cell(value: str) -> str:
    return " ".join(value.split()).replace("|", "\\|")


def approved(data: dict) -> bool:
    approval = data.get("approval") or {}
    return approval.get("revision") == data["revision"] and approval.get("hash") == content_hash(data)


def status(data: dict) -> str:
    if data["open_questions"]:
        return "Draft: needs answers"
    if approved(data):
        return "Approved" + (f" · {data['status_note']}" if data.get("status_note") else "")
    return "Awaiting approval"


def visible(issue: int, data: dict) -> str:
    beta = data["live_beta"]
    if data.get("github_edit"):
        return re.sub(r"^\*\*Status:\*\* .*", f"**Status:** {status(data)} · **Revision** {data['revision']} · "
                      f"**Size** {data['size']} · **Live beta test:** {beta}", data["github_edit"], count=1, flags=re.M)
    lines = [MARKER, f"## 📋 Plan for #{issue}: {data['title']}",
             f"**Status:** {status(data)} · **Revision** {data['revision']} · **Size** {data['size']} · **Live beta test:** {beta}",
             "", f"> **In short:** {cell(data['in_short'])}", "", "### Why", *(f"- {cell(why)}" for why in data["why"]),
             "", "### Scope", "| Where | Today | After |", "|---|---|---|",
             *(f"| {cell(c['where'])} | {cell(c['today'])} | {cell(c['after'])} |" for c in data["scope"]["changes"])]
    if data["scope"].get("not_included"):
        lines += ["", "**Not included:** " + "; ".join(cell(item) for item in data["scope"]["not_included"]) + "."]
    if data["decisions"]:
        lines += ["", "### Decisions", "| Question | Decision | Decided by |", "|---|---|---|",
                  *(f"| {cell(d['question'])} | {cell(d['decision'])} | "
                    f"{'Helio' + chr(39) + 's recommendation ⚑' if helio_decided(d) else cell(d['decided_by'])} |" for d in data["decisions"])]
    if data["open_questions"]:
        lines += ["", "### ❓ Needs your answer", *(f"- {cell(q)}" for q in data["open_questions"])]
    if data["done_when"]:
        lines += ["", "### Done when (beyond the Scope table)", *(f"- [ ] {cell(check)}" for check in data["done_when"])]
    if data["risks"]:
        lines += ["", "### Risks", *(f"- {r['level']}: {cell(r['what'])} {cell(r['mitigation'])}" for r in data["risks"])]
    return "\n".join(lines)


def render(issue: int, data: dict) -> str:
    lines = [visible(issue, data)]
    if data.get("technical_notes") and not data.get("github_edit"):
        lines += ["", "<details><summary>Technical notes (optional reading)</summary>", "", data["technical_notes"].strip(), "</details>"]
    history = "; ".join(f"r{h['revision']}: {cell(h['note'])}" for h in data["history"])
    if data["open_questions"]:
        approval = "Approval: answer the open questions first."
    elif approved(data):
        a = data["approval"]
        approval = f"Approved: revision {a['revision']} by {cell(a['by'])} (Discord message {a['message']}), content hash {a['hash']}."
    else:
        approval = "Approval: waiting. Reply **approve** to Helio in Discord, or say what to change."
    encoded = base64.b64encode(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).decode()
    lines += ["", "---", f"Revision history: {history}.", approval, f"<!-- helio-plan-data:{encoded} -->"]
    return "\n".join(lines)


def parse(body: str) -> dict | None:
    match = DATA.search(body.replace("\r\n", "\n"))
    if not body.startswith(MARKER) or not match:
        return None
    try:
        return json.loads(base64.b64decode(match.group(1), validate=True))
    except ValueError:
        return None


def intact(issue: int, body: str, data: dict | None) -> bool:
    return data is not None and render(issue, data) == body.replace("\r\n", "\n").rstrip()


def announcement(issue: int, data: dict, url: str) -> str:
    head = f"📋 Plan for #{issue} (r{data['revision']})"
    if data["open_questions"]:
        return f"{head} needs answers before it can be approved: " + "; ".join(data["open_questions"]) + f" · <{url}>"
    changes, decisions = len(data["scope"]["changes"]), len(data["decisions"])
    helio = sum(helio_decided(d) for d in data["decisions"])
    beta = "not planned" if data["live_beta"] == "Not planned" else data["live_beta"]
    facts = [f"{changes} change{'s' * (changes != 1)}",
             f"{decisions} decision{'s' * (decisions != 1)}" + (f" ({helio} ⚑ Helio's call)" if helio else ""),
             f"Live beta: {beta}", f"<{url}>"]
    tail = " · " + " · ".join(facts) + "\nReply **approve** to start, or tell me what to change."
    lead = data["in_short"] if data["revision"] == 1 else f"changed: {data['history'][0]['note']}. {data['in_short']}"
    room = ANNOUNCE_LIMIT - len(head) - 2 - len(tail)
    if len(lead) > room:
        lead = lead[:max(room - 1, 0)].rstrip() + "…"
    return f"{head}: {lead}{tail}"


def pr_body(issue: int, data: dict, plan_url: str, result: dict, summary: str, tests_passed: int) -> str:
    mark = {"met": "✅", "deviation": "⚠️"}
    rows = [f"| {mark[r['status']]} | {cell(c['where'])}: {cell(c['today'])} → {cell(c['after'])} | {cell(r['evidence'])} |"
            for c, r in zip(data["scope"]["changes"], result["scope"])]
    rows += [f"| {mark[r['status']]} | {cell(check)} | {cell(r['evidence'])} |" for check, r in zip(data["done_when"], result["done_when"])]
    met = sum(r["status"] == "met" for r in [*result["scope"], *result["done_when"]])
    complete = met == len(rows)
    metadata = ISSUE_LINK["marker"](issue, data["revision"], complete)
    return "\n".join([f"{'Fixes' if complete else 'Refs'} #{issue} following the approved plan (revision {data['revision']}): {plan_url}", "",
                      f"### Against the approved plan (r{data['revision']}): {met} of {len(rows)} met", "",
                      "| | Planned | Evidence |", "|---|---|---|", *rows, "", summary.strip(), "",
                      f"Full unit suite: {tests_passed} tests passed.", "", metadata, ""])


def check_result(data: dict | None, result: object) -> dict:
    if not isinstance(result, dict):
        raise Refused("result file must be a JSON object with scope and done_when lists")
    counts = (("scope", None), ("done_when", 0)) if data is None else (
        ("scope", len(data["scope"]["changes"])), ("done_when", len(data["done_when"])))
    for key, count in counts:
        entries = result.get(key)
        if not isinstance(entries, list):
            raise Refused(f"result {key} must be a list")
        if count is None:
            if not entries:
                raise Refused("result scope needs at least 1 entry, one per confirmed issue requirement")
        elif len(entries) != count:
            raise Refused(f"result {key} needs exactly {count} entries, one per planned item")
        for index, entry in enumerate(entries):
            if (not isinstance(entry, dict) or entry.get("status") not in ("met", "deviation")
                    or not isinstance(entry.get("evidence"), str) or not entry["evidence"].strip()):
                raise Refused(f"result {key}[{index}] needs status met or deviation and evidence")
    return result


def command(argv: list[str], stdin: str | None = None, cwd: Path | None = None) -> str:
    result = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=600, cwd=cwd)
    if result.returncode:
        raise Refused((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout.strip()


class GitHub:
    def __init__(self, repo: str, run: Callable[..., str] = command):
        self.repo, self.run = repo, run

    def issue(self, number: int) -> dict:
        return json.loads(self.run(["gh", "issue", "view", str(number), "--repo", self.repo, "--json", "state,title,body,comments"]))

    def plan_comment(self, number: int) -> tuple[dict, int | None, str, str]:
        issue = self.issue(number)
        login = self.run(["gh", "api", "user", "--jq", ".login"])
        for comment in issue.get("comments") or []:
            match = re.search(r"#issuecomment-(\d+)$", comment.get("url", ""))
            if match and (comment.get("author") or {}).get("login") == login and comment.get("body", "").startswith(MARKER):
                return issue, int(match.group(1)), comment["url"], comment["body"]
        return issue, None, "", ""

    def save(self, number: int, comment_id: int | None, body: str) -> str:
        path = f"repos/{self.repo}/issues/comments/{comment_id}" if comment_id else f"repos/{self.repo}/issues/{number}/comments"
        reply = self.run(["gh", "api", path, "--method", "PATCH" if comment_id else "POST", "--input", "-"], json.dumps({"body": body}))
        return json.loads(reply)["html_url"]

    def label(self, number: int, add: bool) -> None:
        if add:
            self.run(["gh", "label", "create", LABEL, "--repo", self.repo, "--force",
                      "--description", "Helio plan mode: build only after the plan comment is approved"])
        self.run(["gh", "issue", "edit", str(number), "--repo", self.repo, "--add-label" if add else "--remove-label", LABEL])

    def open_pr(self, branch: str) -> str | None:
        pulls = json.loads(self.run(["gh", "pr", "list", "--repo", self.repo, "--head", branch, "--state", "open", "--json", "url"]))
        return pulls[0]["url"] if pulls else None

    def labelled(self) -> list[int]:
        found = json.loads(self.run(["gh", "issue", "list", "--repo", self.repo, "--label", LABEL, "--state", "open",
                                     "--limit", "200", "--json", "number"]))
        return sorted(item["number"] for item in found)


def discord_message(message_id: str, channel: str | None = None, fingerprint: str | None = None) -> dict:
    checker = runpy.run_path(str(HERE / "release-check.py"))
    try:
        return {**checker["load"](message_id, channel, fingerprint), "verify": checker["verify"],
                "verify_source": checker["verify_source"], "Refused": checker["Refused"]}
    except checker["Refused"] as error:
        raise Refused(str(error)) from None


def full_suite(project: Path, head: str) -> int:
    autofix = runpy.run_path(str(HERE / "helio-autofix.py"))
    with tempfile.TemporaryDirectory(prefix="helio-pr-") as temporary:
        tree, output = Path(temporary) / "tree", Path(temporary) / "result.json"
        command(["git", "worktree", "add", "--detach", str(tree), head], cwd=project)
        try:
            command([str(project / ".venv/bin/python"), "-I", "-c", autofix["RUNNER"], str(tree), str(output)], cwd=tree)
            counts = autofix["Counts"](**json.loads(output.read_text()))
        finally:
            command(["git", "worktree", "remove", "--force", str(tree)], cwd=project)
    if not counts.passed():
        raise Refused(f"full unit suite must pass: {counts}")
    return counts.run


def state(issue: int, body: str) -> tuple[str, dict | None]:
    if not body:
        return "PLAN_NONE", None
    data = parse(body)
    if not intact(issue, body, data):
        return "PLAN_EDITED_OUTSIDE_HELIO", data
    if data["open_questions"]:
        return "PLAN_DRAFT", data
    return ("PLAN_APPROVED" if approved(data) else "PLAN_AWAITING"), data


def adopt(issue: int, gh: GitHub, now: datetime.datetime) -> str | None:
    _, comment_id, url, body = gh.plan_comment(issue)
    old = parse(body)
    if not comment_id or intact(issue, body, old):
        return None
    if old is None:
        raise Refused("cannot adopt a plan without its Helio data; restore the plan data marker")
    data = json.loads(json.dumps(old))
    # Preserve the entire human edit in the approval hash, including prose outside known sections.
    edited = DATA.sub("", body).split("\n---\nRevision history:", 1)[0].strip()
    data["github_edit"] = edited
    sections = dict(re.findall(r"### ([^\n]+)\n(.*?)(?=\n### |\n---|\n<details>|\Z)", edited, re.S))
    title = re.search(r"## .+?Plan for #\d+: (.+)", edited)
    short = re.search(r"> \*\*In short:\*\* (.+)", edited)
    if title:
        data["title"] = title.group(1)
    if short:
        data["in_short"] = short.group(1)
    if "Why" in sections:
        data["why"] = re.findall(r"^- (.+)$", sections["Why"], re.M)
    scope = sections.get("Scope", "")
    rows = [re.split(r"(?<!\\)\|", line)[1:-1] for line in scope.splitlines() if line.startswith("|")]
    if len(rows) >= 2 and all(len(row) == 3 for row in rows):
        data["scope"]["changes"] = [dict(zip(("where", "today", "after"), (v.strip().replace("\\|", "|") for v in row))) for row in rows[2:]]
    data["done_when"] = re.findall(r"^- \[[ xX]\] (.+)$", sections.get("Done when (beyond the Scope table)", ""), re.M)
    data["open_questions"] = re.findall(r"^- (.+)$", sections.get("❓ Needs your answer", ""), re.M)
    data["revision"] = old["revision"] + 1
    data["posted_at"] = now.isoformat()
    data["approval"] = None
    data.pop("revision_source", None)
    data.pop("status_note", None)
    data["history"] = [{"revision": data["revision"], "note": "adopted GitHub edit"}, *old["history"]]
    gh.save(issue, comment_id, render(issue, data))
    gh.label(issue, True)
    return f"PLAN_ADOPTED issue={issue} revision={data['revision']} url={url}: approval reset; review the adopted GitHub text"


def requested(message: dict, issue: int, now: datetime.datetime) -> str:
    payload, live = message["payload"], message["live"]
    author = str(payload.get("author_id", ""))
    if payload.get("for_owner"):
        raise Refused("a message addressed to the owner never starts plan mode")
    if (live.get("author") or {}).get("id") != author or (live.get("author") or {}).get("bot") or live.get("webhook_id"):
        raise Refused("plan request is not from a matching human sender")
    if not (author == message["owner"] or author in message["trusted"]) or not message["channel_ok"]:
        raise Refused("only the owner or a trusted user can ask for a plan, in a permitted location")
    sent = datetime.datetime.fromisoformat(str(live.get("timestamp", "")).replace("Z", "+00:00"))
    if now - sent > REQUEST_MAX_AGE:
        raise Refused("plan request is older than 72 hours; ask again")
    approval = runpy.run_path(str(HERE / "helio_approval.py"))
    if not PLAN_REQUEST.search(approval["instruction_text"](str(live.get("content", "")))):
        raise Refused(f"that message does not ask for a plan for #{issue}")
    return str(payload.get("author") or author)


def post(args: argparse.Namespace, gh: GitHub, discord: Callable[[str], dict], now: datetime.datetime) -> list[str]:
    issue, comment_id, url, body = gh.plan_comment(args.issue)
    if issue.get("state") != "OPEN":
        raise Refused(f"issue #{args.issue} is not open")
    old = None
    if comment_id:
        old = parse(body)
        if not intact(args.issue, body, old):
            return [f"PLAN_EDITED_OUTSIDE_HELIO issue={args.issue} url={url}: adopt or discard the hand edit before revising"]
        requester = old["requested_by"]
    else:
        if not args.request_message:
            raise Refused("the first plan needs --request-message, the owner's or a trusted user's request")
        autofix = gh.open_pr(f"helio/autofix-{args.issue}")
        if autofix:
            return [f"PLAN_AUTOFIX_ACTIVE issue={args.issue} pr={autofix}: stop or point to the automatic fix first"]
        requester = requested(discord(args.request_message), args.issue, now)
    try:
        fields = json.loads(args.file.read_text())
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read plan file: {error}") from None
    revision = old["revision"] + 1 if old else 1
    errors = validate(fields, revision)
    if errors:
        return [f"PLAN_INVALID field={field} reason={reason}" for field, reason in errors]
    note = fields.pop("change_note", None) or "first version"
    data = {"decisions": [], "open_questions": [], "done_when": [], "risks": [], **fields,
            "scope": {"not_included": [], **fields["scope"]}, "revision": revision, "posted_at": now.isoformat(),
            "requested_by": requester, "history": [{"revision": revision, "note": note}, *(old["history"] if old else [])],
            "approval": old.get("approval") if old else None,
            "source_bindings": dict(old.get("source_bindings", {})) if old else {}}
    if old and old.get("revision_source"):
        prior = old["revision_source"]
        data["source_bindings"].setdefault(prior["message"], {"revision": old["revision"], "hash": content_hash(old)})
    if args.from_message:
        source = discord(args.from_message)
        checker = runpy.run_path(str(HERE / "release-check.py"))
        try:
            checker["verify_source"](source["payload"], source["live"], source["owner"], source["trusted"], source["channel_ok"])
        except checker["Refused"] as error:
            raise Refused(str(error)) from None
        data["revision_source"] = {"message": args.from_message, "author": source["payload"]["author_id"],
                                   "content": source["live"]["content"], "channel": source["live"]["channel_id"]}
        data["source_bindings"].setdefault(args.from_message, {"revision": revision, "hash": content_hash(data)})
    if len(visible(args.issue, data)) > VISIBLE_LIMIT:
        return [f"PLAN_INVALID field=plan reason=visible part is {len(visible(args.issue, data))} characters (limit {VISIBLE_LIMIT})"]
    gh.label(args.issue, True)
    url = gh.save(args.issue, comment_id, render(args.issue, data))
    args.announcement_file.write_text(announcement(args.issue, data, url) + "\n")
    lines = [f"PLAN_POSTED issue={args.issue} revision={revision} status={status(data).replace(' ', '_')} url={url}",
             f"PLAN_ANNOUNCEMENT_FILE {args.announcement_file}"]
    if old and old.get("approval") and not approved(data):
        lines.append(f"PLAN_APPROVAL_RESET issue={args.issue}: the content changed; ask for approval of r{revision}")
    return lines


def approve(args: argparse.Namespace, gh: GitHub, discord: Callable[[str], dict], now: datetime.datetime) -> list[str]:
    _, comment_id, url, body = gh.plan_comment(args.issue)
    found, data = state(args.issue, body)
    if found in ("PLAN_NONE", "PLAN_EDITED_OUTSIDE_HELIO", "PLAN_DRAFT"):
        raise Refused({"PLAN_NONE": f"issue #{args.issue} has no plan", "PLAN_DRAFT": "the plan still has open questions",
                       "PLAN_EDITED_OUTSIDE_HELIO": "the plan was edited outside Helio; adopt or discard the edit first"}[found])
    if args.confirmation:
        click = click_approval(args.confirmation, args.issue, data, now)
        data["approval"] = {"revision": data["revision"], "hash": content_hash(data), "by": click["username"],
                            "message": click["result_id"]}
        gh.save(args.issue, comment_id, render(args.issue, data))
        consume(args.confirmation, now)
        return [f"PLAN_APPROVED issue={args.issue} revision={data['revision']} by={click['username']} url={url}"]
    message = discord(args.message)
    binding = data.get("source_bindings", {}).get(args.message)
    if binding and (binding["revision"] != data["revision"] or binding["hash"] != content_hash(data)):
        raise Refused(f"message {args.message} is bound to r{binding['revision']}; ask for approval of r{data['revision']}")
    source = data.get("revision_source") or {}
    is_source = (source.get("message") == args.message and source.get("author") == message["payload"]["author_id"]
                 and source.get("channel") == message["live"]["channel_id"] and source.get("content") == message["live"]["content"])
    referenced = str((message["live"].get("referenced_message") or {}).get("content", ""))
    answered = PLAN_PATTERN.match(referenced)
    if answered and int(answered.group(2)) != data["revision"] and not is_source:
        raise Refused(f"that approves r{answered.group(2)}; the current plan is r{data['revision']} "
                      f"({data['history'][0]['note']}); ask for approval of r{data['revision']}")
    try:
        message["verify"](message["payload"], message["live"], "plan", f"{REPO}#{args.issue}", None, message["owner"],
                          message["trusted"], message["channel_ok"], message["is_dm"], message["bot_id"], now=now,
                          not_before=None if is_source else datetime.datetime.fromisoformat(data["posted_at"]))
    except message["Refused"] as error:
        raise Refused(str(error)) from None
    by = str(message["payload"].get("author") or message["payload"].get("author_id"))
    data["approval"] = {"revision": data["revision"], "hash": content_hash(data), "by": by, "message": args.message}
    gh.save(args.issue, comment_id, render(args.issue, data))
    return [f"PLAN_APPROVED issue={args.issue} revision={data['revision']} by={by} url={url}"]


def click_approval(prompt_id: str, issue: int, data: dict, now: datetime.datetime) -> dict:
    checker = runpy.run_path(str(HERE / "release-check.py"))
    try:
        return checker["load_click"](prompt_id, "plan", f"{REPO}#{issue}", str(data["revision"]), now=now,
                                     not_before=datetime.datetime.fromisoformat(data["posted_at"]))
    except checker["Refused"] as error:
        raise Refused(str(error)) from None


def consume(prompt_id: str, now: datetime.datetime) -> None:
    path = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))) / "discord-prompts.sqlite"
    with closing(sqlite3.connect(path, timeout=5)) as db, db:
        db.execute("UPDATE prompts SET status='used',used_at=? WHERE id=? AND status='confirmed'", (int(now.timestamp() * 1000), prompt_id))


def authorize_work(args: argparse.Namespace, gh: GitHub, source: dict) -> list[str]:
    if source["payload"].get("channel_id") != args.channel:
        raise Refused("work authorization channel does not match the live message")
    try:
        author = source["verify"](source["payload"], source["live"], "work", f"{REPO}#{args.issue}", None,
                                  source["owner"], source["trusted"], source["channel_ok"], source["is_dm"],
                                  source["bot_id"], now=args.now)
    except source["Refused"] as error:
        raise Refused(str(error)) from None
    if gh.issue(args.issue).get("state") != "OPEN":
        raise Refused(f"issue #{args.issue} is not open")
    recorded = WORK["record"](WORK["Authorization"](REPO, args.issue, args.message, args.channel, author, args.now,
                                                  hashlib.sha256(source["live"]["content"].encode()).hexdigest()))
    if not recorded:
        existing = gh.open_pr(f"helio/issue-{args.issue}")
        if existing:
            return [f"PLAN_PR {existing}"]
        raise Refused("this work request already produced its PR; inspect the issue history before starting new work")
    gh.run(["gh", "issue", "edit", str(args.issue), "--repo", gh.repo, "--remove-label", "needs-owner-review"])
    return [f"WORK_AUTHORIZED issue={args.issue} message={args.message} channel={args.channel} sender={author} valid=until-used"]


def submit(args: argparse.Namespace, gh: GitHub, suite: Callable[[Path, str], int], discord: DiscordReader) -> list[str]:
    issue, comment_id, plan_url, body = gh.plan_comment(args.issue)
    found, data = state(args.issue, body)
    branch = f"helio/issue-{args.issue}"
    existing = gh.open_pr(branch)
    if existing:
        try:
            authorization = WORK["available"](REPO, args.issue, args.now)
        except WORK["Refused"]:
            pass
        else:
            WORK["consume"](REPO, args.issue, authorization.message)
        return [f"PLAN_PR {existing}"]
    authorization = None
    if found != "PLAN_APPROVED":
        if found != "PLAN_NONE":
            raise Refused(f"{found}: approve the current plan or explicitly drop it before submitting")
        try:
            authorization = WORK["available"](REPO, args.issue, args.now)
        except WORK["Refused"] as error:
            raise Refused(f"{found}: {error}") from None
        if issue.get("state") != "OPEN":
            raise Refused(f"issue #{args.issue} is not open")
        source = discord(authorization.message, authorization.channel, authorization.source_hash)
        try:
            author = source["verify_source"](source["payload"], source["live"], source["owner"], source["trusted"], source["channel_ok"])
        except source["Refused"] as error:
            raise Refused(str(error)) from None
        if author != authorization.author:
            raise Refused("work requester identity differs from the recorded request")
        data = {"title": issue["title"]}
    try:
        result = check_result(None if authorization else data, json.loads(args.result_file.read_text()))
        summary = args.summary_file.read_text().strip()
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read result or summary file: {error}") from None
    if not summary:
        raise Refused("summary file must describe what was built")
    project = Path(os.environ["HELIO_PROJECT"]).expanduser().resolve()
    git = lambda *argv: command(["git", *argv], cwd=project)
    git("fetch", "--quiet", "origin", "main")
    if git("branch", "--show-current") != branch:
        raise Refused(f"check out {branch}")
    if git("status", "--porcelain"):
        raise Refused("worktree must be clean")
    base, head = git("rev-parse", "origin/main"), git("rev-parse", "HEAD")
    if git("merge-base", base, head) != base:
        raise Refused("branch must include current origin/main")
    passed = suite(project, head)
    remote = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if remote and remote.split()[0] != head:
        raise Refused("remote branch has a different head")
    if not remote:
        git("push", "origin", f"{head}:refs/heads/{branch}")
    with tempfile.TemporaryDirectory(prefix="helio-pr-body-") as temporary:
        path = Path(temporary) / "body.md"
        if authorization:
            complete = all(entry["status"] == "met" for entry in result["scope"])
            text = "\n".join([f"{'Fixes' if complete else 'Refs'} #{args.issue}", "", "### Issue scope", issue.get("body", ""),
                              "", "### Result", "| Requirement | Status | Evidence |", "|---|---|---|",
                              *(f"| {index} | {entry['status']} | {cell(entry['evidence'])} |"
                                for index, entry in enumerate(result["scope"], 1)), "", summary,
                              "", f"Full unit suite: {passed} tests passed.", "", ISSUE_LINK["marker"](args.issue, None, complete), ""])
        else:
            text = pr_body(args.issue, data, plan_url, result, summary, passed)
        path.write_text(text)
        url = gh.run(["gh", "pr", "create", "--repo", gh.repo, "--base", "main", "--head", branch,
                      "--title", f"{data['title']} (#{args.issue})", "--body-file", str(path)])
        if authorization:
            WORK["consume"](REPO, args.issue, authorization.message)
    if not authorization:
        data["status_note"] = f"implemented in {url}"
        gh.save(args.issue, comment_id, render(args.issue, data))
    return [f"PLAN_PR {url}"]


def main(argv: list[str] | None = None, gh: GitHub | None = None, discord: DiscordReader = discord_message,
         suite: Callable[[Path, str], int] = full_suite, now: datetime.datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("post", "approve", "check", "show", "drop"):
        sub = commands.add_parser(name)
        sub.add_argument("--issue", type=int, required=True)
        if name == "post":
            sub.add_argument("--file", type=Path, required=True)
            sub.add_argument("--request-message")
            sub.add_argument("--from-message")
            sub.add_argument("--announcement-file", type=Path, required=True)
        if name == "approve":
            source = sub.add_mutually_exclusive_group(required=True)
            source.add_argument("--message")
            source.add_argument("--confirmation")
        if name == "show":
            sub.add_argument("--json", action="store_true")
    commands.add_parser("list")
    work = commands.add_parser("work").add_subparsers(dest="work_command", required=True).add_parser("authorize")
    work.add_argument("--issue", type=int, required=True)
    work.add_argument("--message", required=True)
    work.add_argument("--channel", required=True)
    pr = commands.add_parser("pr").add_subparsers(dest="pr_command", required=True).add_parser("submit")
    pr.add_argument("--issue", type=int, required=True)
    pr.add_argument("--result-file", type=Path, required=True)
    pr.add_argument("--summary-file", type=Path, required=True)
    args = parser.parse_args(argv)
    if getattr(args, "issue", 1) < 1:
        parser.error("--issue must be positive")
    gh = gh or GitHub(REPO)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    args.now = now
    try:
        if args.command != "work" and getattr(args, "issue", None) and args.command != "drop":
            adopted = adopt(args.issue, gh, now)
            if adopted:
                print(adopted)
        if args.command == "post":
            lines = post(args, gh, discord, now)
        elif args.command == "approve":
            lines = approve(args, gh, discord, now)
        elif args.command == "pr":
            lines = submit(args, gh, suite, discord)
        elif args.command == "work":
            lines = authorize_work(args, gh, discord(args.message, args.channel))
        elif args.command == "list":
            waiting = [n for n in gh.labelled() if state(n, gh.plan_comment(n)[3])[0] != "PLAN_APPROVED"]
            lines = [f"PLANS_AWAITING count={len(waiting)}" + (" issues=" + ",".join(f"#{n}" for n in waiting) if waiting else "")]
        else:
            _, comment_id, url, body = gh.plan_comment(args.issue)
            found, data = state(args.issue, body)
            if args.command == "show" and args.json and data:
                lines = [json.dumps(data, indent=2, ensure_ascii=False)]
            elif args.command == "drop" and comment_id:
                gh.save(args.issue, comment_id, f"Plan dropped on {now.date().isoformat()} (was revision {data['revision'] if data else '?'}).")
                gh.label(args.issue, False)
                lines = [f"PLAN_DROPPED issue={args.issue}"]
            else:
                lines = [f"{found} issue={args.issue}" + (f" revision={data['revision']} url={url}" if data else "")]
    except (Refused, WORK["Refused"]) as error:
        print(f"PLAN_REFUSED {error}".replace("\n", " "))
        return 1
    print("\n".join(lines))
    if args.command in ("post", "approve", "pr", "drop", "work") and lines and lines[0].startswith(("PLAN_POSTED", "PLAN_APPROVED", "PLAN_PR", "PLAN_DROPPED", "WORK_AUTHORIZED")):
        try:
            sync = runpy.run_path(str(HERE / "helio_issue_sync.py"))
            sync["schedule"](gh.repo, args.issue)
        except (OSError, sqlite3.Error) as error:
            print(f"ISSUE_SYNC_PENDING issue={args.issue}: {type(error).__name__}; run helio issue sync")
    ok = ("PLAN_POSTED", "PLAN_APPROVED", "PLAN_NONE", "PLAN_PR", "PLAN_DROPPED", "PLANS_AWAITING", "WORK_AUTHORIZED", "{")
    return 0 if lines and lines[0].startswith(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
