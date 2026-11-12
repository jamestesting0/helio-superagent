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
from contextlib import closing, ExitStack
from dataclasses import dataclass, replace
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import shlex
import subprocess
import sys
import tempfile
from typing import Callable, Protocol, TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_verification import Suite


class DiscordReader(Protocol):
    def __call__(self, message_id: str, channel: str | None = None, fingerprint: str | None = None) -> dict: ...

HERE = Path(__file__).resolve().parent
ISSUE_LINK = runpy.run_path(str(HERE / "helio_issue_link.py"))
POSTS = runpy.run_path(str(HERE / "helio_github_posts.py"))
PUBLICATION = runpy.run_path(str(HERE / "helio_pr_publication.py"))
ISSUES = runpy.run_path(str(HERE / "helio_issues.py"))
AUTHORITY = runpy.run_path(str(HERE / "helio_pr_authority.py"))
WORK = runpy.run_path(str(HERE / "helio-work.py"))
POLICY = runpy.run_path(str(HERE / "helio_runtime_policy.py"))
REQUEST_CLI = runpy.run_path(str(HERE / "helio_plan_request_cli.py"))
PLAN_SOURCE = runpy.run_path(str(HERE / "helio_plan_source.py"))
PLAN_PUBLICATION = runpy.run_path(str(HERE / "helio_plan_publication.py"))
FOLLOWUP = runpy.run_path(str(HERE / "helio_issue_followup.py"))
DISCORD_TEXT = runpy.run_path(str(HERE / "helio_discord_text.py"))
LANE = runpy.run_path(str(HERE / "helio_task_lane.py"))
PROOF = runpy.run_path(str(HERE / "helio_regression_proof.py"))
VERIFICATION = runpy.run_path(str(HERE / "helio_pr_verification.py"))
PR_RECOVERY_CLI = runpy.run_path(str(HERE / "helio_pr_recovery_cli.py"))
CLI = runpy.run_path(str(HERE / "helio_cli.py"))
ExampleParser, positive = CLI["ExampleParser"], CLI["positive"]
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


class Refused(RuntimeError):
    pass


def helio_decided(decision: dict) -> bool:
    return decision["decided_by"].strip().lower() in ("helio", "helio's recommendation")


def content_hash(data: dict) -> str:
    fields = {key: data.get(key) for key in HASHED}
    if "github_edit" in data:
        fields["github_edit"] = data["github_edit"]
    canonical = json.dumps(fields, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def validate(data: object, revision: int, *, editorial: bool = True) -> list[tuple[str, str]]:
    if not isinstance(data, dict):
        return [("plan", "must be a JSON object")]
    errors: list[tuple[str, str]] = [(key, "unknown field") for key in sorted(set(data) - FIELDS)]

    def text(field: str, value: object, limit: int, words: bool = False) -> None:
        if not isinstance(value, str) or not value.strip():
            errors.append((field, "required text"))
            return
        size = len(value.split()) if words else len(value)
        if editorial and size > limit:
            errors.append((field, f"over {limit} {'words' if words else 'characters'}"))
        if editorial and field != "technical_notes" and CODE.search(value):
            errors.append((field, "no code, file paths or function names outside technical_notes"))
        if editorial and FILLER.search(value):
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
        if editorial and isinstance(check, str) and any(len(after) >= 4 and after in check.lower() for after in afters):
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
        if editorial and isinstance(notes, str) and "```" in notes:
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
    data = dict(data)
    semantic = {key: value for key, value in data.items() if key not in ("posted_at", "publication_id")}
    if "publication_id" in data:
        data["publication_id"] = hashlib.sha256(
            json.dumps([issue, semantic], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
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
    head = f"📋 Plan for [Issue #{issue}](<https://github.com/{REPO}/issues/{issue}>) (r{data['revision']})"
    if data["open_questions"]:
        prefix = f"{head} "
        lead = "needs answers before it can be approved: " + "; ".join(data["open_questions"])
        tail = f" · [Read plan](<{url}>)"
    else:
        prefix = f"{head}: "
        changes, decisions = len(data["scope"]["changes"]), len(data["decisions"])
        helio = sum(helio_decided(d) for d in data["decisions"])
        beta = "not planned" if data["live_beta"] == "Not planned" else "requested (details in plan)"
        facts = [f"{changes} change{'s' * (changes != 1)}",
                 f"{decisions} decision{'s' * (decisions != 1)}" + (f" ({helio} ⚑ Helio's call)" if helio else ""),
                 f"Live beta: {beta}", f"[Read plan](<{url}>)"]
        tail = " · " + " · ".join(facts) + "\nReply **approve** to start, or tell me what to change."
        lead = data["in_short"] if data["revision"] == 1 else f"changed: {data['history'][0]['note']}. {data['in_short']}"
    room = ANNOUNCE_LIMIT - len(prefix) - len(tail)
    lead = DISCORD_TEXT["clip_links"](DISCORD_TEXT["format_links"](lead), room)
    return f"{prefix}{lead}{tail}"


def pr_body(issue: int, data: dict, plan_url: str, result: dict, summary: str, tests_passed: int, structured: bool = False, history: str = "") -> str:
    coverage = tuple(POSTS["Coverage"](f"{scope['where']}: {scope['today']} \u2192 {scope['after']}", row["status"], row["evidence"])
                     for scope, row in zip(data["scope"]["changes"], result["scope"], strict=True))
    coverage += tuple(POSTS["Coverage"](condition, row["status"], row["evidence"])
                      for condition, row in zip(data["done_when"], result["done_when"], strict=True))
    return POSTS["pr_body"](issue, data["revision"], POSTS["report"](summary, structured), coverage, tests_passed, plan_url, history)


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


def github_command(argv: list[str], stdin: str | None = None) -> str:
    return ISSUES["run"](argv, stdin).strip()


class GitHub:
    def __init__(self, repo: str, run: Callable[..., str] = github_command):
        self.repo, self.run = repo, run

    def issue(self, number: int) -> dict:
        result = json.loads(self.run(["gh", "issue", "view", str(number), "--repo", self.repo, "--json", "state,title,body,comments,labels"]))
        if result.get("state") == "CLOSED":
            REQUEST_CLI["REQUESTS"]["closed"](self.repo, number, datetime.datetime.now(datetime.timezone.utc))
        return result

    def plan_comment(self, number: int) -> tuple[dict, int | None, str, str]:
        issue = self.issue(number)
        pages = json.loads(self.run(["gh", "api", f"repos/{self.repo}/issues/{number}/comments?per_page=100",
                                    "--paginate", "--slurp"]))
        issue["comments"] = [{"body": comment["body"], "url": comment["html_url"],
                              "author": {"login": (comment.get("user") or {}).get("login")}}
                             for page in pages for comment in page]
        login = self.run(["gh", "api", "user", "--jq", ".login"])
        matches = []
        for comment in issue.get("comments") or []:
            match = re.fullmatch(rf"https://github\.com/{re.escape(self.repo)}/issues/{number}#issuecomment-(\d+)",
                                 comment.get("url", ""))
            if match and (comment.get("author") or {}).get("login") == login and comment.get("body", "").startswith(MARKER):
                matches.append((issue, int(match.group(1)), comment["url"], comment["body"]))
        if len(matches) > 1:
            raise Refused("multiple bot-owned plan comments; resolve their identity before writing")
        if matches:
            return matches[0]
        return issue, None, "", ""

    def save(self, number: int, comment_id: int | None, body: str,
             authorize: Callable[[], object] | None = None, *, expected_body: str) -> str:
        PLAN_PUBLICATION["reconcile"](self, number)
        return PLAN_PUBLICATION["save"](self, number, comment_id, body, expected_body, authorize)

    def label(self, number: int, add: bool) -> None:
        PLAN_PUBLICATION["reconcile"](self, number)
        PLAN_PUBLICATION["operation"](self, number, "label", "", "present" if add else "absent")

    def cleanup_cancelled(self, number: int) -> None:
        PLAN_PUBLICATION["reconcile"](self, number)
        _, comment_id, _, body = self.plan_comment(number)
        data = parse(body)
        binding = (data or {}).get("planning_request")
        if not binding:
            return
        receipt = REQUEST_CLI["REQUESTS"]["get"](self.repo, number, binding["message"])
        if receipt and receipt.state == "cancelled":
            self.save(number, comment_id, f"Plan dropped after cancellation (was revision {data['revision']}).",
                      expected_body=body)
            self.label(number, False)

    def resume_command(self, operation: sqlite3.Row) -> str:
        data = parse(operation["after_body"])
        if data is None:
            return f"helio plan drop --issue {operation['issue']}"
        before = parse(operation["before_body"])
        if before and data["revision"] == before["revision"] and data.get("approval") != before.get("approval"):
            approval = data.get("approval") or {}
            option = "--confirmation" if approval.get("confirmation") else "--message"
            source = approval.get("confirmation") or approval.get("message")
            command = ["helio", "plan", "approve", "--issue", str(operation["issue"]), option, source]
            if option == "--message":
                command.append("--resolved-approval")
            return shlex.join(command)
        if data["history"][0]["note"] == "adopted GitHub edit":
            return f"helio plan adopt --issue {operation['issue']}"
        fields = {key: data[key] for key in FIELDS if key in data}
        if data["revision"] > 1:
            fields["change_note"] = data["history"][0]["note"]
        directory = PLAN_PUBLICATION["state_dir"]()
        draft = directory / f"plan-{operation['id']}.json"
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as temporary:
            json.dump(fields, temporary)
        os.replace(temporary.name, draft)
        command = ["helio", "plan", "post", "--issue", str(operation["issue"]), "--file", str(draft),
                   "--announcement-file", str(directory / f"plan-{operation['id']}.txt")]
        binding = data.get("planning_request")
        if binding:
            command.extend(["--request-message", binding["message"]])
        if data.get("revision_source"):
            command.extend(["--from-message", data["revision_source"]["message"]])
        return shlex.join(command)

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
        source = PLAN_SOURCE["load"](message_id, channel, fingerprint, checker["api"])
        return {**source, "verify": checker["verify"],
                "verify_source": checker["verify_source"], "Refused": checker["Refused"]}
    except (checker["Refused"], PLAN_SOURCE["Refused"]) as error:
        raise Refused(str(error)) from None


def full_suite(project: Path, head: str) -> Suite:
    return VERIFICATION["full_suite"](project, head)


@dataclass(frozen=True, slots=True)
class TaskIssue:
    number: int
    previous: int | None = None


def task_worktree(project: Path, task: TaskIssue, explicit: Path | None) -> tuple[Path, str]:
    """Use the selected task context; issue-numbered trees are a discovery fallback."""
    issue = task.number
    branch = f"helio/issue-{issue}"
    matches_issue = re.compile(rf"refs/heads/helio/issue-?{issue}(?:$|[-_])")
    trees = command(["git", "worktree", "list", "--porcelain"], cwd=project)
    task_trees: set[Path] = set()
    candidates: dict[Path, str] = {}
    for record in trees.split("\n\n"):
        fields = dict(line.split(" ", 1) for line in record.splitlines() if " " in line)
        if fields.get("branch", "").startswith("refs/heads/helio/"):
            task_trees.add(Path(fields["worktree"]).resolve())
        if matches_issue.match(fields.get("branch", "")):
            candidates[Path(fields["worktree"]).resolve()] = fields["branch"].removeprefix("refs/heads/")
    caller = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    current = Path(caller.stdout.strip()).resolve() if caller.returncode == 0 else None
    selected = None
    if explicit:
        selected = explicit.expanduser().resolve()
    elif current in task_trees:
        selected = current
    if selected is None:
        if len(candidates) != 1:
            raise Refused(f"check out {branch} in a task worktree; found {len(candidates)} matching trees; use --worktree")
        selected = next(iter(candidates))
    common = command(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=project)
    selected_common = command(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=selected)
    if Path(common).resolve() != Path(selected_common).resolve():
        raise Refused("task worktree belongs to a different repository")
    if command(["git", "remote", "get-url", "--push", "origin"], cwd=selected) != command(
            ["git", "remote", "get-url", "--push", "origin"], cwd=project):
        raise Refused("task worktree origin differs from the canonical repository")
    selected_branch = command(["git", "branch", "--show-current"], cwd=selected)
    named_issue = re.match(r"helio/issue-?(\d+)(?:$|[-_])", selected_branch)
    if (not selected_branch.startswith("helio/") or selected_branch.startswith("helio/autofix-")
            or (named_issue and int(named_issue.group(1)) not in (issue, task.previous))):
        raise Refused(f"check out {branch} in the selected task worktree")
    return selected, selected_branch


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
    data["publication_id"] = ""
    data.pop("revision_source", None)
    data.pop("status_note", None)
    data["history"] = [{"revision": data["revision"], "note": "adopted GitHub edit"}, *old["history"]]
    gh.save(issue, comment_id, render(issue, data), expected_body=body)
    gh.label(issue, True)
    return f"PLAN_ADOPTED issue={issue} revision={data['revision']} url={url}: approval reset; review the adopted GitHub text"


def post(args: argparse.Namespace, gh: GitHub, discord: DiscordReader, now: datetime.datetime) -> list[str]:
    sources = REQUEST_CLI["REQUESTS"]
    receipt = None
    if args.request_message:
        request = sources["for_post"](gh.repo, args.issue, args.request_message)
        receipt = sources["record"](request, discord, now)
    PLAN_PUBLICATION["reconcile"](gh, args.issue)
    issue, comment_id, url, body = gh.plan_comment(args.issue)
    if issue.get("state") != "OPEN":
        raise Refused(f"issue #{args.issue} is not open")
    old = None
    if comment_id:
        old = parse(body)
        if not intact(args.issue, body, old):
            return [f"PLAN_EDITED_OUTSIDE_HELIO issue={args.issue} url={url}: adopt or discard the hand edit before revising"]
        requester = old["requested_by"]
        if old.get("planning_request"):
            bound = old["planning_request"]
            request = sources["Request"](gh.repo, args.issue, bound["message"], bound["channel"])
            receipt = sources["record"](request, discord, now)
    else:
        if not args.request_message:
            raise Refused("the first plan needs --request-message, the owner's or a trusted user's request")
        autofix = gh.open_pr(f"helio/autofix-{args.issue}")
        if autofix:
            return [f"PLAN_AUTOFIX_ACTIVE issue={args.issue} pr={autofix}: stop or point to the automatic fix first"]
        requester = receipt.author_name
    try:
        fields = json.loads(args.file.read_text())
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read plan file: {error}") from None
    comparable = {key: old.get(key, "" if key == "technical_notes" else None)
                  for key in FIELDS if key != "change_note"} if old else None
    candidate = {"decisions": [], "open_questions": [], "done_when": [], "risks": [],
                 "technical_notes": "", **fields}
    candidate["scope"] = {"not_included": [], **candidate.get("scope", {})}
    if (old and all(candidate.get(key) == value for key, value in comparable.items())
            and ("change_note" not in fields or fields["change_note"] == old["history"][0]["note"])):
        gh.label(args.issue, True)
        if receipt:
            sources["published"](receipt.request, str(comment_id))
        args.announcement_file.write_text(announcement(args.issue, old, url) + "\n")
        return [f"PLAN_POSTED issue={args.issue} revision={old['revision']} url={url}",
                f"PLAN_ANNOUNCEMENT_FILE {args.announcement_file}"]
    revision = old["revision"] + 1 if old else 1
    errors = validate(fields, revision, editorial=False)
    if errors:
        return [f"PLAN_INVALID field={field} reason={reason}" for field, reason in errors]
    advice = validate(fields, revision)
    note = fields.pop("change_note", None) or "first version"
    data = {"decisions": [], "open_questions": [], "done_when": [], "risks": [], "publication_id": "", **fields,
            "scope": {"not_included": [], **fields["scope"]}, "revision": revision, "posted_at": now.isoformat(),
            "requested_by": requester, "history": [{"revision": revision, "note": note}, *(old["history"] if old else [])],
            "approval": old.get("approval") if old else None,
            "source_bindings": dict(old.get("source_bindings", {})) if old else {}}
    if receipt:
        data["planning_request"] = {"message": receipt.request.message, "channel": receipt.request.channel,
                                    "author": receipt.author, "source_hash": receipt.source_hash}
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
    if len(render(args.issue, data)) > 65536:
        return ["PLAN_INVALID field=plan reason=rendered comment exceeds GitHub's 65536-character limit"]
    url = gh.save(args.issue, comment_id, render(args.issue, data),
                  (lambda: sources["record"](receipt.request, discord, now)) if receipt else None,
                  expected_body=body)
    gh.label(args.issue, True)
    if receipt:
        sources["published"](receipt.request, url.rsplit("#issuecomment-", 1)[1])
    args.announcement_file.write_text(announcement(args.issue, data, url) + "\n")
    lines = [f"PLAN_POSTED issue={args.issue} revision={revision} status={status(data).replace(' ', '_')} url={url}",
             f"PLAN_ANNOUNCEMENT_FILE {args.announcement_file}"]
    lines += [f"PLAN_ADVICE field={field} reason={reason}" for field, reason in advice]
    if len(visible(args.issue, data)) > VISIBLE_LIMIT:
        lines.append(f"PLAN_ADVICE field=plan reason=consider shortening the visible part below {VISIBLE_LIMIT} characters")
    if old and old.get("approval") and not approved(data):
        lines.append(f"PLAN_APPROVAL_RESET issue={args.issue}: the content changed; ask for approval of r{revision}")
    return lines


def approve(args: argparse.Namespace, gh: GitHub, discord: DiscordReader, now: datetime.datetime) -> list[str]:
    PLAN_PUBLICATION["reconcile"](gh, args.issue)
    _, comment_id, url, body = gh.plan_comment(args.issue)
    found, data = state(args.issue, body)
    if found in ("PLAN_NONE", "PLAN_EDITED_OUTSIDE_HELIO", "PLAN_DRAFT"):
        raise Refused({"PLAN_NONE": f"issue #{args.issue} has no plan", "PLAN_DRAFT": "the plan still has open questions",
                       "PLAN_EDITED_OUTSIDE_HELIO": "the plan was edited outside Helio; adopt or discard the edit first"}[found])
    data["publication_id"] = ""
    if args.confirmation:
        click = click_approval(args.confirmation, args.issue, data, now)
        data["approval"] = {"revision": data["revision"], "hash": content_hash(data), "by": click["username"],
                            "message": click["result_id"], "confirmation": args.confirmation}
        gh.save(args.issue, comment_id, render(args.issue, data), expected_body=body)
        consume(args.confirmation, now)
        return [f"PLAN_APPROVED issue={args.issue} revision={data['revision']} by={click['username']} url={url}"]
    existing = data.get("approval") or {}
    location = ((existing["channel"], existing["source_hash"])
                if approved(data) and existing.get("message") == args.message and
                existing.get("channel") and existing.get("source_hash") else None)
    with closing(PLAN_PUBLICATION["connect"]()) as db:
        prepared = db.execute("""SELECT after_body FROM plan_publications WHERE repo=? AND issue=?
            AND state='prepared' AND before_hash=?""",
                              (gh.repo, args.issue, hashlib.sha256(body.encode()).hexdigest())).fetchall()
    for row in prepared:
        saved = parse(row["after_body"])
        proof = (saved or {}).get("approval") or {}
        if (saved and saved["revision"] == data["revision"] and proof.get("hash") == content_hash(data)
                and proof.get("message") == args.message and proof.get("channel") and proof.get("source_hash")):
            location = (proof["channel"], proof["source_hash"])
            break
    message = discord(args.message, *location) if location else discord(args.message)
    binding = data.get("source_bindings", {}).get(args.message)
    if binding and (binding["revision"] != data["revision"] or binding["hash"] != content_hash(data)):
        raise Refused(f"message {args.message} is bound to r{binding['revision']}; ask for approval of r{data['revision']}")
    source = data.get("revision_source") or {}
    is_source = (source.get("message") == args.message and source.get("author") == message["payload"]["author_id"]
                 and source.get("channel") == message["live"]["channel_id"] and source.get("content") == message["live"]["content"])
    referenced = str((message["live"].get("referenced_message") or {}).get("content", ""))
    answered = PLAN_PATTERN.match(DISCORD_TEXT["bot_text"](referenced, REPO, pull=False))
    if answered and int(answered.group(2)) != data["revision"] and not is_source:
        raise Refused(f"that approves r{answered.group(2)}; the current plan is r{data['revision']} "
                      f"({data['history'][0]['note']}); ask for approval of r{data['revision']}")
    def verify_approval(current: dict) -> None:
        try:
            current["verify"](current["payload"], current["live"], "plan", f"{REPO}#{args.issue}", None, current["owner"],
                              current["trusted"], current["channel_ok"], current["is_dm"], current["bot_id"], now=now,
                              not_before=None if is_source else datetime.datetime.fromisoformat(data["posted_at"]),
                              resolved_plan=args.resolved_approval)
        except current["Refused"] as error:
            raise Refused(str(error)) from None

    verify_approval(message)
    by = str(message["payload"].get("author") or message["payload"].get("author_id"))
    data["approval"] = {"revision": data["revision"], "hash": content_hash(data), "by": by, "message": args.message}
    data["approval"].update(author=message["payload"]["author_id"], channel=message["live"]["channel_id"],
                            source_hash=hashlib.sha256(message["live"]["content"].encode()).hexdigest())
    proof = data["approval"]
    gh.save(args.issue, comment_id, render(args.issue, data),
            lambda: verify_approval(discord(args.message, proof["channel"], proof["source_hash"])),
            expected_body=body)
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


def authorize_work(args: argparse.Namespace, gh: GitHub, source: dict, kind: str = "request") -> list[str]:
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
    holds = tuple(dict.fromkeys(getattr(args, "hold", None) or ()))
    recorded = WORK["record"](WORK["Authorization"](REPO, args.issue, args.message, args.channel, author, args.now,
                                                  hashlib.sha256(source["live"]["content"].encode()).hexdigest(), kind, holds))
    held = f" holds={','.join(holds)}" if holds else ""
    if not recorded:
        return [f"WORK_AUTHORIZED issue={args.issue} message={args.message} channel={args.channel} "
                f"sender={author} creation=used update=existing-PR-only mechanics=commit,normal-push,PR{held}; run helio pr submit to verify delivery"]
    gh.run(["gh", "issue", "edit", str(args.issue), "--repo", gh.repo, "--remove-label", "needs-owner-review"])
    return [f"WORK_AUTHORIZED issue={args.issue} message={args.message} channel={args.channel} sender={author} "
            f"creation=available update=authorized-task mechanics=commit,normal-push,PR{held}; no separate approval for those steps"]


def work_authority(grant) -> str:
    who = f"<@{grant.author}> in Discord message {grant.message} (channel {grant.channel})"
    if grant.kind == "bug-report":
        return (f"Bug reported by {who} and confirmed by Helio. The confirmed report is the requester's explicit request "
                "to fix it, commit, push and open the PR. `helio pr submit` requires a regression test that fails on main.")
    return f"Requested by {who}: this is the requester's explicit request to commit, push and open the PR for this issue."


def start_work(args: argparse.Namespace, gh: GitHub, discord: DiscordReader) -> list[str]:
    """Record (or reuse) the work authority, then launch its lane with a rendered brief and PR-based Done."""
    lines: list[str] = []
    if getattr(args, "grant", None):
        lines = [record_grant(args.issue, args.grant, args.now)]
    elif not args.from_authorization:
        if not (args.message and args.channel):
            raise Refused("work start needs --message and --channel, --grant, or --from-authorization")
        lines = authorize_work(args, gh, discord(args.message, args.channel))
    try:
        grant = WORK["available"](REPO, args.issue, args.now, include_used=True)
    except WORK["Refused"] as error:
        raise Refused(str(error)) from None
    if args.from_authorization and grant.blocked:
        raise Refused(f"issue #{args.issue} work is blocked ({grant.blocked}); a new request from the requester supersedes it")
    issue = gh.issue(args.issue)
    if issue.get("state") != "OPEN":
        raise Refused(f"issue #{args.issue} is not open")
    owner = os.environ.get("DORI_DISCORD_OWNER_ID", "")
    task = LANE["Task"](REPO, args.issue, issue["title"], "work", work_authority(grant),
                        f"discord:{grant.channel}:{grant.message}", "owner" if grant.author == owner else "normal",
                        grant.holds, args.note_file.read_text() if args.note_file else "",
                        "thorough" if getattr(args, "thorough", False) else "")
    try:
        key, launch = LANE["start"](task, Path(os.environ["HELIO_PROJECT"]).expanduser().resolve())
    except RuntimeError as error:
        raise Refused(f"lane launch failed: {error}; rerun helio work start --issue {args.issue} --from-authorization") from None
    return lines + [f"WORK_STARTED issue={args.issue} key={key} holds={','.join(grant.holds) or 'none'} launch={launch}"]


def custody_store() -> object:
    return ISSUES["Issues"](REPO, Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))))


def block_work(args: argparse.Namespace) -> list[str]:
    reason = " ".join(args.reason.split())[:300]
    try:
        WORK["available"](REPO, args.issue, args.now)
        stage = "pre-submit"
    except WORK["Refused"]:
        stage = "post-submit"
    question = getattr(args, "question", None)
    marked = WORK["block"](REPO, args.issue, reason, args.now, question)
    store = custody_store()
    wait = PR_RECOVERY_CLI["S"]["load"](store, args.issue)
    if wait is not None and not wait.data["terminal"] and wait.data["acknowledgment"] != wait.generation:
        PR_RECOVERY_CLI["P"]["block"](store, wait, reason, stage, question, args.now.timestamp())
        marked = True
    if not marked:
        raise Refused(f"issue #{args.issue} has no unfinished authorized or bug-fix work to block")
    return [f"WORK_BLOCKED issue={args.issue} stage={stage} reason={json.dumps(reason)}"
            + (f" clear=helio work unblock --issue {args.issue} --question {question}" if question else "")]


def answered_question(issue: int, question: str) -> str:
    """The answer must come from this job's lane and from the owner or a currently trusted user."""
    path = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))) / "discord-questions.sqlite"
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        row = db.execute("SELECT lane,status,answer_author FROM questions WHERE id=?", (question,)).fetchone()
    if row is None:
        raise Refused(f"unknown question {question}")
    lane_key, status, author = row
    state = path.parent
    record = next((json.loads(p.read_text()) for p in (state / "lanes" / f"{lane_key}.json", state / "lanes/archive" / f"{lane_key}.json")
                   if re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,60}", lane_key) and p.is_file()), None)
    custody = lane_key == f"custody-issue{issue}"  # a worker question transferred so its slot could be released
    if not custody and (record is None or record.get("job") != f"issue-{issue}"):
        raise Refused(f"question {question} does not belong to issue #{issue}'s lane")
    if status not in ("answered", "done") or not author:
        raise Refused(f"question {question} has no recorded answer")
    trusted = POLICY["values"](os.environ).get("DORI_DISCORD_TRUSTED_IDS", "").split(",")
    if author != os.environ.get("DORI_DISCORD_OWNER_ID") and author not in trusted:
        raise Refused(f"question {question} was not answered by the owner or a current trusted user")
    return f"answered question {question}"


def record_grant(issue: int, identity: str, now: datetime.datetime) -> str:
    """Work authority from the owner's recorded decision: implement permission, bound to this issue."""
    granted = WORK["grant"](identity)
    owner = os.environ.get("DORI_DISCORD_OWNER_ID", "")
    if not granted or "implement" not in granted["permissions"] or granted["author"] != owner:
        raise Refused("the grant does not authorize implementation by the current owner")
    if issue != (granted["target_issue"] or granted["issue"]):
        raise Refused("the grant belongs to another issue")
    WORK["record"](WORK["Authorization"](REPO, issue, identity, "grant", owner, now, granted["question_sha256"]))
    return f"WORK_AUTHORIZED issue={issue} source=grant:{identity}"


def decide(args: argparse.Namespace, gh: GitHub, discord: DiscordReader) -> list[str]:
    """Apply the owner's answer to a custody question as its defined transition, then close the question."""
    C = PR_RECOVERY_CLI["C"]
    E, S, P = C["E"], C["S"], C["P"]
    state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    store = ISSUES["Issues"](gh.repo, state, command=gh.run)
    wait = S["load"](store, args.issue)
    if wait is None:
        raise Refused(f"issue #{args.issue} has no managed custody record")
    owner = os.environ.get("DORI_DISCORD_OWNER_ID", "")
    escalation, blocked = wait.data.get("escalation") or {}, wait.data.get("blocked") or {}
    now = args.now.timestamp()
    if args.message:
        if not (args.channel and args.option):
            raise Refused("a later answer needs --message, --channel and --option")
        source = discord(args.message, args.channel)
        try:
            author = source["verify_source"](source["payload"], source["live"], source["owner"], source["trusted"], source["channel_ok"])
        except source["Refused"] as error:
            raise Refused(str(error)) from None
        qid, option, evidence = escalation.get("question") or blocked.get("question"), args.option, f"owner message {args.message}"
    else:
        if not args.question:
            raise Refused("decide needs --question, or --message, --channel and --option for a later answer")
        row = E["question"](store, args.question)
        if row is None or row["lane"] != E["lane_key"](args.issue):
            raise Refused(f"{args.question} is not a custody question for issue #{args.issue}")
        if row["status"] != "answered":
            raise Refused(f"question {args.question} has no answer to apply ({row['status']})")
        if row["answer_source"] == "component" and args.option not in (None, row["answer_text"]):
            raise Refused(f"the owner tapped {row['answer_text']!r}; a button answer is applied as given")
        option = row["answer_text"] if row["answer_source"] == "component" else args.option or row["answer_text"]
        qid, author, evidence = args.question, row["answer_author"], f"answered question {args.question}"
    questions = runpy.run_path(str(HERE / "helio-questions.py"))

    def close() -> None:
        if qid and E["question"](store, qid):
            with closing(questions["db_connect"]()) as db:
                questions["close"](db, qid)

    if blocked.get("transferred") and blocked.get("question") == qid and not args.message:
        # The worker's own question: the A2 answer rules (owner or a current trusted user) clear its blocker.
        lines = unblock_work(argparse.Namespace(issue=args.issue, question=qid, message=None, channel=None, named=False,
                                                lead=False, now=args.now), discord)
        current = S["load"](store, args.issue)
        S["save"](store, replace(current, data={**current.data, "escalation": None}))
        close()
        return lines + [f"PHASE_DECIDED issue={args.issue} question={qid} transition=worker-unblock"]
    if escalation.get("question") != qid and not args.message:
        raise Refused(f"{qid} is not this issue's open custody decision")
    if author != owner:
        raise Refused("custody decisions are the owner's")
    if option not in (escalation.get("options") or []):
        raise Refused("choose one of: " + "; ".join(escalation.get("options") or []))
    kind, lane = escalation["kind"], wait.data["lane"]
    answer_sha = hashlib.sha256(json.dumps([qid, escalation.get("detail"), option, args.issue]).encode()).hexdigest()
    reason = f"owner decision {qid or args.message}: {option}"

    def settle(current: Wait, **fields) -> Wait:
        return S["save"](store, S["notice"](replace(current, data={**current.data, "escalation": None, **fields}),
                                            "decision", f"Owner decided: {option}", now))

    def wake(current: Wait) -> Wait:
        if current.data.get("blocked", {}) and current.data["blocked"].get("stage") != "controller":
            WORK["unblock"](REPO, args.issue, args.now)
        current = S["save"](store, replace(current, data={**current.data, "escalation": None}))
        current = P["unblock"](store, current, reason, now)
        intent = current.data.get("intent")
        if intent and intent.get("kind") == "wake" and current.data.get("pending"):
            # A resumed repair stays bound to its observation, so an unchanged return counts against that budget.
            current = S["save"](store, replace(current, data={**current.data, "intent": {**intent, "observation": current.data["pending"]}}))
        return current

    def create(permissions: tuple[str, ...], related: bool) -> tuple[str, int]:
        if not args.title or not args.body_file:
            raise Refused("this option creates an issue: pass --title and --body-file with its requirements")
        identity = WORK["create_grant"](REPO, args.issue, qid or args.message, option, permissions, owner, answer_sha, args.now)
        labels = tuple(args.labels or [item["name"] for item in store.get(args.issue).get("labels", [])] or ["bug"])
        number, _ = FOLLOWUP["create"](store, FOLLOWUP["Request"](args.issue, "grant", identity, args.title,
                                                                   args.body_file.read_text(), labels, related))
        WORK["target_grant"](identity, number)
        return identity, number

    if option in E["PARK"]:
        # Parked, not settled: the decision (kind, options) stays so a later owner message can resume it.
        wait = E["park"](store, wait, reason, now)
        wait = S["save"](store, replace(wait, data={**wait.data, "escalation": {**escalation, "question": None, "parked": True}}))
    elif option == E["STOP"]:
        gh.run(["dori", "abandon", lane, "--reason", reason])
        wait = settle(wait, terminal=True)
    elif option == E["BUSY"]:
        worker_question = blocked.get("question") if blocked.get("stage") != "controller" else None
        moving = kind == "worker-blocked" and worker_question and (E["question"](store, worker_question) or {}).get("status") in (
            "queued", "send_failed", "delivery_unknown", "sending", "awaiting_answer", "answered")
        if moving:
            # Dori will not release a lane whose own question is open, so the question moves to custody first (journaled;
            # a rerun of this decision finds it already moved).
            C["A"]["transfer"](store, worker_question, E["lane_key"](args.issue))
            wait = S["save"](store, replace(wait, data={**wait.data, "blocked": {**blocked, "transferred": E["lane_key"](args.issue)}}))
        gh.run(["dori", "pause", lane, "--note", reason])
        revision = P["lane"](store, wait).get("revision", 0)
        gh.run(["dori", "reclaim", lane, "--stop", "--expected-revision", str(revision)])
        if moving:
            # The worker is stopped with its checkpoint; its own question now waits in custody and its answer wakes it.
            wait = S["save"](store, replace(wait, data={**wait.data,
                "escalation": {"kind": "worker-blocked", "at": now, "question": worker_question,
                               "options": list(E["OPTIONS"]["worker-blocked"]), "detail": blocked.get("reason", "")}}))
            wait = S["save"](store, S["notice"](wait, "decision", f"Owner decided: {option}", now))
        else:
            wait = wake(wait)
    elif option in ("Try once more", "Try again", "Unblock and continue"):
        data = dict(wait.data)
        key = escalation.get("observation") or data.get("pending") or ""
        if kind == "repair-exhausted":
            # Exactly one more round for the observation that ran out; every other budget is unchanged.
            data["reworked"] = [item for item in data.get("reworked") or [] if "scope:" + item != key and item != key]
        elif kind == "startup-failed":
            data.update(startup_failures=[], startup_failed_revision=None)
        if kind == "repair-exhausted":
            # One more round for exactly this observation: the controller's repair dispatch delivers it (it releases the
            # worker safely first, retries while busy, and the stop clock bounds the wait); an unchanged return asks again.
            data.update(attempts={**(data.get("attempts") or {}), key: 1}, pending=key, last_action=key)
            wait = settle(wait, **{field: data.get(field) for field in ("attempts", "pending", "last_action", "reworked")}, blocked=None)
        else:
            wait = wake(S["save"](store, replace(wait, data=data)))
    elif option == "Retry CI now":
        incidents = {key: item if item["resolved"] else {**item, "retries": [], "first_at": now}
                     for key, item in wait.data["incidents"].items()}
        wait = settle(wait, incidents=incidents, blocked=None)
    elif option == "Reopen the PR and continue":
        gh.run(["gh", "pr", "reopen", wait.data["pr"], "--repo", REPO])
        pull = C["exact_pull"](store, wait, gh.run)
        if pull["state"] != "OPEN" or pull["headRefOid"] != wait.data["head"]:
            raise Refused("the reopened PR does not show the handed-off head; inspect it before continuing")
        wait = settle(wait, blocked=None)
    elif option == "Continue under a linked follow-up issue":
        identity, number = create(("create", "implement"), False)
        start_work(argparse.Namespace(issue=number, grant=identity, from_authorization=False, message=None, channel=None,
                                      note_file=None, thorough=False, now=args.now), gh, discord)
        gh.run(["dori", "abandon", lane, "--reason", f"{reason}; continued in #{number}"])
        wait = settle(wait, terminal=True)
    elif option == "Include the new requirements in this PR":
        WORK["create_grant"](REPO, args.issue, qid or args.message, option, ("implement",), owner, answer_sha, args.now)
        digest = P["requirements"](store.get(args.issue))
        wait = settle(wait, scope_grant=digest, blocked=None)
    elif option == "Leave them for a related issue":
        if not args.restored_body_file:
            raise Refused("pass --restored-body-file with this issue's requirements without the moved ones")
        _, number = create(("create",), True)
        current = store.get(args.issue)
        store.update(args.issue, {"body": args.restored_body_file.read_text(), "adopt": ISSUES["digest"](current.get("body") or ""),
                                  "note": f"Moved the newer requirements to #{number} ({reason}).",
                                  "source": {"kind": "question", "id": qid, "author": owner}})
        if P["requirements"](store.get(args.issue)) != wait.data["scope"]:
            raise Refused(f"#{args.issue}'s requirements still differ from the handed-off scope; correct the restored text")
        wait = settle(wait, blocked=None)
    elif option in ("Create the follow-up issue", "No follow-up"):
        if option == "Create the follow-up issue":
            create(("create",), False)
        wait = settle(wait, blocked=None, followup_handled=P["requirements"](store.get(args.issue)))
    else:
        raise Refused(f"no transition is defined for {option!r}")
    close()
    return [f"PHASE_DECIDED issue={args.issue} kind={kind} option={json.dumps(option)} generation={wait.generation}"]


def lead_unblock(args: argparse.Namespace) -> list[str]:
    """The lead clears a watchdog or stall blocker it diagnosed; worker blockers and owner decisions are refused."""
    if not args.reason or not args.reason.strip():
        raise Refused("--lead needs --reason with what was diagnosed")
    store = custody_store()
    S, P = PR_RECOVERY_CLI["S"], PR_RECOVERY_CLI["P"]
    wait = S["load"](store, args.issue)
    blocked = (wait.data.get("blocked") if wait else None) or {}
    if blocked.get("stage") != "controller" or blocked.get("kind") not in ("stalled", "no-progress") or blocked.get("parked"):
        raise Refused("--lead clears only a controller stall or no-progress blocker; this one needs its answer or the owner")
    if (wait.data.get("escalation") or {}).get("question"):
        raise Refused("the owner was already asked; apply the answer with helio pr phase decide")
    wait = S["save"](store, replace(wait, data={**wait.data, "escalation": None}))
    wait = P["unblock"](store, wait, "lead: " + " ".join(args.reason.split())[:200], args.now.timestamp())
    return [f"WORK_UNBLOCKED issue={args.issue} by=lead changed=true generation={wait.generation}"]


def unblock_work(args: argparse.Namespace, discord: DiscordReader) -> list[str]:
    if getattr(args, "lead", False):
        return lead_unblock(args)
    if not args.question and not args.message:
        raise Refused("unblock needs --question, --message with --channel, or --lead with --reason")
    if args.question:
        evidence = answered_question(args.issue, args.question)
    else:
        source = discord(args.message, args.channel)
        if source["payload"].get("channel_id") != args.channel:
            raise Refused("unblock request channel does not match the live message")
        try:
            source["verify"](source["payload"], source["live"], "work", f"{REPO}#{args.issue}", None,
                             source["owner"], source["trusted"], source["channel_ok"], source["is_dm"],
                             source["bot_id"], now=args.now)
        except source["Refused"] as error:
            raise Refused(str(error)) from None
        evidence = f"request {args.message}"
    named = args.question if getattr(args, "named", False) else None
    cleared = WORK["unblock"](REPO, args.issue, args.now, named)
    store = custody_store()
    wait = PR_RECOVERY_CLI["S"]["load"](store, args.issue)
    if wait is not None and wait.data.get("blocked") and (named is None or wait.data["blocked"]["question"] == named):
        wait = PR_RECOVERY_CLI["P"]["unblock"](store, wait, evidence, args.now.timestamp())
        cleared = True
    return [f"WORK_UNBLOCKED issue={args.issue} by={json.dumps(evidence)} changed={str(cleared).lower()}"
            + (f" generation={wait.generation}" if wait is not None else "")]


def submit(args: argparse.Namespace, gh: GitHub, suite: Callable[[Path, str], Suite], discord: DiscordReader) -> list[str]:
    issue, comment_id, plan_url, body = gh.plan_comment(args.issue)
    found, data = state(args.issue, body)
    if found not in ("PLAN_APPROVED", "PLAN_NONE"):
        raise Refused(f"{found}: approve the current plan or explicitly drop it before submitting")
    project = Path(os.environ["HELIO_PROJECT"]).expanduser().resolve()
    previous = FOLLOWUP["predecessor"](issue.get("body") or "")
    if previous and (previous == args.issue or gh.issue(previous).get("state") != "CLOSED"):
        raise Refused("follow-up predecessor is not a distinct closed issue; inspect the current relationship")
    tree, branch = task_worktree(project, TaskIssue(args.issue, previous), args.worktree)
    existing = gh.open_pr(branch)
    numbered = re.match(r"helio/issue-?(\d+)(?:$|[-_])", branch)
    if numbered and int(numbered.group(1)) != args.issue and not existing:
        raise Refused("a new follow-up needs its own task branch; reuse a predecessor branch only for its existing open PR")
    if existing:
        pull = json.loads(gh.run(["gh", "pr", "view", existing, "--repo", gh.repo, "--json",
                                 "state,headRefName,baseRefName,isCrossRepository,body,closingIssuesReferences"]))
        if (pull.get("state"), pull.get("headRefName"), pull.get("baseRefName"), pull.get("isCrossRepository")) != (
                "OPEN", branch, "main", False):
            raise Refused("existing PR does not belong to this task branch against main in the canonical repository")
        if previous:
            implementation = ISSUE_LINK["parse"](pull.get("body") or "")
            linked = {item["number"] for item in pull.get("closingIssuesReferences") or []}
            if not ((implementation and implementation.issue in (previous, args.issue))
                    or linked.intersection({previous, args.issue})):
                raise Refused("existing PR has no verified relationship to this follow-up or its closed predecessor")
    def require_unheld() -> None:
        # The requester's latest words govern every publication path, approved plans included, until publication.
        try:
            newest = WORK["available"](REPO, args.issue, datetime.datetime.now(datetime.timezone.utc) if args.now is None else max(
                args.now, datetime.datetime.now(datetime.timezone.utc)))
        except WORK["Refused"]:
            return
        if newest.holds:
            raise Refused(f"held by requester: {','.join(newest.holds)}; report the verified work and wait for them")
        if newest.blocked:
            raise Refused(f"work is blocked ({newest.blocked}); once resolved run helio work unblock --issue {args.issue} "
                          "--question QID (or --message M --channel C), then submit")

    require_unheld()
    authorization = None
    if found != "PLAN_APPROVED":
        try:
            authorization = WORK["available"](REPO, args.issue, args.now, include_used=bool(existing))
        except WORK["Refused"] as error:
            raise Refused(f"{found}: {error}") from None
        if issue.get("state") != "OPEN":
            raise Refused(f"issue #{args.issue} is not open")
        data = {"title": issue["title"]}

    state_dir = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    proof = {"message": authorization.message, "channel": authorization.channel, "author": authorization.author,
             "source_hash": authorization.source_hash} if authorization else {
                 **data["approval"], "target": f"{REPO}#{args.issue}", "revision": str(data["revision"]),
                 "posted_at": data["posted_at"], "state": str(state_dir)}
    def verify_request() -> None:
        require_unheld()
        AUTHORITY["verify"](proof, discord)
    try:
        result = check_result(None if authorization else data, json.loads(args.result_file.read_text()))
        summary = (args.report_file or args.summary_file).read_text()
        author = POSTS["report"](summary, args.report_file is not None)
        if authorization and args.report_file:
            for entry in result["scope"]:
                POSTS["text"](entry.get("requirement"), "requirement label")
    except (OSError, ValueError) as error:
        raise Refused(f"cannot read result or summary file: {error}") from None
    if not summary:
        raise Refused("summary file must describe what was built")
    git = lambda *argv: command(["git", *argv], cwd=tree)
    git("fetch", "--quiet", "origin", "main")
    if git("status", "--porcelain"):
        raise Refused("worktree must be clean")
    base, head = git("rev-parse", "origin/main"), git("rev-parse", "HEAD")
    if git("merge-base", base, head) != base:
        git("merge", "--no-edit", "origin/main")
        head = git("rev-parse", "HEAD")
    verified = suite(project, head)
    VERIFICATION["check_suite"](verified)
    passed = verified["counts"]["run"]
    if authorization and authorization.kind == "bug-report":
        try:
            verified = VERIFICATION["regression"](project, head, PROOF["changed_tests"](tree, base, head), verified, base=base)
        except RuntimeError as error:
            raise Refused(f"bug-report work needs a regression test that fails on main: {error}") from None
    if git("rev-parse", "HEAD") != head or git("status", "--porcelain"):
        raise Refused("task worktree changed during verification; verify its new head before submission")
    remote = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if remote and remote.split()[0] != head:
        git("fetch", "--quiet", "origin", f"refs/heads/{branch}")
        if git("merge-base", "FETCH_HEAD", head) != remote.split()[0]:
            raise Refused("remote branch diverged or moved; reconcile its work in the task tree before submitting")
    verify_request()
    current_issue, _, _, current_body = gh.plan_comment(args.issue)
    if current_issue.get("state") != "OPEN" or current_body != body or current_issue.get("body") != issue.get("body"):
        raise Refused("issue or plan changed during verification; review current scope before submitting")
    latest = git("ls-remote", "--heads", "origin", "refs/heads/main")
    if not latest or latest.split()[0] != base:
        raise Refused("main advanced during verification; merge current main in the task tree and resubmit under the existing task authority")
    store = ISSUES["Issues"](gh.repo, state_dir, command=gh.run)
    scope = ISSUES["digest"](ISSUES["split"](current_issue.get("body") or "")[0])
    verification = VERIFICATION["record"](store, {
        "issue": args.issue, "branch": branch, "route": authorization.kind if authorization else "plan",
        "head": head, "base": base, "authority": VERIFICATION["digest"](json.dumps(proof, sort_keys=True)),
        "authority_proof": proof,
        "scope": scope, "job": f"issue-{args.issue}", "generation": VERIFICATION["phase"](store, args.issue),
    }, verified)
    if not remote or remote.split()[0] != head:
        git("push", "origin", f"{head}:refs/heads/{branch}")
    delivered = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if not delivered or delivered.split()[0] != head:
        raise Refused("remote does not represent the verified task head; inspect the push before retrying")
    if authorization:
        coverage = tuple(POSTS["Coverage"](entry.get("requirement") or entry["evidence"], entry["status"], entry["evidence"])
                         for entry in result["scope"])
        text = POSTS["pr_body"](args.issue, None, author, coverage, passed,
                               history=f"https://github.com/{gh.repo}/issues/{previous}" if previous else "")
    else:
        text = pr_body(args.issue, data, plan_url, result, summary, passed, args.report_file is not None,
                       f"https://github.com/{gh.repo}/issues/{previous}" if previous else "")
    url = PUBLICATION["publish"](store, args.issue, branch, head, text, data["title"], proof, scope,
        existing, args.adopt_body, plan_body=current_body if not authorization else "", authorize=verify_request,
        verification=verification)
    pull = json.loads(gh.run(["gh", "pr", "view", url, "--repo", gh.repo, "--json",
                             "state,headRefOid,headRefName,baseRefName"]))
    if (pull.get("state"), pull.get("headRefOid"), pull.get("headRefName"), pull.get("baseRefName")) != (
            "OPEN", head, branch, "main"):
        raise Refused("PR does not yet represent the verified task head; inspect it before reporting success")
    latest = git("ls-remote", "--heads", "origin", "refs/heads/main")
    if not latest or latest.split()[0] != base:
        raise Refused("main advanced during PR publication; update this same PR and verify its new head before reporting delivery")
    return [f"PLAN_PR {url}" + (f" verification={verification}" if VERIFICATION["phase"](store, args.issue) is not None else "")]


def main(argv: list[str] | None = None, gh: GitHub | None = None, discord: DiscordReader = discord_message,
         suite: Callable[[Path, str], Suite] = full_suite, now: datetime.datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    REQUEST_CLI["register"](commands)
    for name in ("post", "approve", "check", "show", "drop", "adopt"):
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
            sub.add_argument("--resolved-approval", action="store_true",
                             help="lead has interpreted this human message as approval; retain source and target checks")
        if name == "show":
            sub.add_argument("--json", action="store_true")
    commands.add_parser("list")
    work_commands = commands.add_parser("work").add_subparsers(dest="work_command", required=True, parser_class=ExampleParser)
    work = work_commands.add_parser("authorize", example='helio work authorize --issue 23 --message 1570186341193482241 --channel 1218071208197623880')
    work.add_argument("--issue", type=positive, required=True)
    work.add_argument("--message", required=True)
    work.add_argument("--channel", required=True)
    starter = work_commands.add_parser("start", example='helio work start --issue 23 --message 1570186341193482241 --channel 1218071208197623880')
    starter.add_argument("--issue", type=positive, required=True)
    starter.add_argument("--message")
    starter.add_argument("--channel")
    starter.add_argument("--grant", help="an owner decision recorded by helio pr phase decide (implement permission)")
    starter.add_argument("--from-authorization", action="store_true",
                         help="relaunch from the newest recorded authorization without a new source")
    starter.add_argument("--note-file", type=Path, help="task context for the lane; never authority or holds")
    starter.add_argument("--thorough", action="store_true",
                         help="full ultrawork lane for multi-module features, data or schema changes, or live QA")
    for parser_with_holds in (work, starter):
        parser_with_holds.add_argument("--hold", action="append", choices=WORK["HOLDS"],
                                       help="only when the requester's own words ask for it")
    blocker = work_commands.add_parser("block", example='helio work block --issue 23 --reason "needs the owner\'s rounding choice" --question 6d1eabfab39a478db83b')
    blocker.add_argument("--issue", type=positive, required=True)
    blocker.add_argument("--reason", required=True)
    blocker.add_argument("--question", help="the helio question ID whose answer resolves this blocker")
    unblocker = work_commands.add_parser("unblock", example='helio work unblock --issue 23 --question 6d1eabfab39a478db83b')
    unblocker.add_argument("--issue", type=positive, required=True)
    evidence = unblocker.add_mutually_exclusive_group(required=False)
    evidence.add_argument("--question", help="an answered question from this issue's lane")
    evidence.add_argument("--message", help="a new request from an authorized requester; needs --channel")
    unblocker.add_argument("--channel")
    unblocker.add_argument("--named", action="store_true", help="only blockers recorded with this --question")
    unblocker.add_argument("--lead", action="store_true",
                           help="clear a controller stall/no-progress blocker after diagnosis (never a worker or owner decision)")
    unblocker.add_argument("--reason", help="what the lead diagnosed; required with --lead")
    prs = commands.add_parser("pr").add_subparsers(dest="pr_command", required=True, parser_class=ExampleParser)
    PR_RECOVERY_CLI["register"](prs)
    inspection = prs.add_parser("check").add_mutually_exclusive_group(required=True)
    inspection.add_argument("--number", type=int)
    inspection.add_argument("--issue", type=int, help="the issue's canonical PR; prints PR_MERGED or PR_NONE when none is open")
    pr = prs.add_parser("submit", example='helio pr submit --issue 23 --result-file /tmp/result.json --report-file /tmp/report.json --worktree ~/.dori/elobot/state/worktrees/issue23-example')
    pr.add_argument("--example", action="store_true", help="print a valid result file and report file, then exit")
    pr.add_argument("--issue", type=positive)
    pr.add_argument("--result-file", type=Path)
    reports = pr.add_mutually_exclusive_group()
    reports.add_argument("--summary-file", type=Path)
    reports.add_argument("--report-file", type=Path)
    pr.add_argument("--adopt-body")
    pr.add_argument("--worktree", type=Path, help="task worktree in the canonical repository; otherwise discovered automatically")
    args = parser.parse_args(argv)
    if args.command == "pr" and args.pr_command == "submit":
        if args.example:
            print(json.dumps({"result_file": LANE["RESULT_EXAMPLE"], "report_file": LANE["REPORT_EXAMPLE"]}, indent=2))
            return 0
        if args.issue is None or args.result_file is None or (args.summary_file is None and args.report_file is None):
            pr.error("submit needs --issue, --result-file and --report-file (or --summary-file); see helio pr submit --example")
    if getattr(args, "issue", None) is not None and args.issue < 1:
        parser.error("--issue must be positive")
    gh = gh or GitHub(REPO)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    args.now = now
    stack = ExitStack()
    try:
        if getattr(args, "issue", None) and args.command not in ("pr", "work"):
            stack.enter_context(PLAN_PUBLICATION["scope"](
                gh.repo, args.issue, serialize=args.command != "request" or args.request_action == "cancel"))
        if args.command == "pr" and args.pr_command == "phase" and args.phase_action == "decide":
            print("\n".join(decide(args, gh, discord)))
            return 0
        if args.command == "pr" and args.pr_command in ("wait", "phase"):
            state_dir = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
            return PR_RECOVERY_CLI["execute"](args, ISSUES["Issues"](gh.repo, state_dir, command=gh.run), gh.run)
        if args.command == "pr" and args.pr_command == "check":
            readiness = runpy.run_path(str(HERE / "helio_pr_readiness.py"))
            if args.issue is not None:
                print(readiness["for_issue"](gh.repo, args.issue, gh.run))
                return 0
            if args.number < 1:
                parser.error("--number must be positive")
            print(readiness["check"](gh.repo, args.number, gh.run))
            return 0
        if args.command == "adopt":
            lines = [adopt(args.issue, gh, now) or f"PLAN_ADOPTED issue={args.issue}: no external edit"]
        elif args.command == "request":
            lines = REQUEST_CLI["execute"](args, gh.repo, discord)
            if args.request_action == "cancel":
                PLAN_PUBLICATION["cancel_prepared"](gh.repo, args.issue, args.message)
                gh.cleanup_cancelled(args.issue)
        elif args.command == "post":
            lines = post(args, gh, discord, now)
        elif args.command == "approve":
            lines = approve(args, gh, discord, now)
        elif args.command == "pr":
            lines = submit(args, gh, suite, discord)
        elif args.command == "work" and args.work_command == "start":
            lines = start_work(args, gh, discord)
        elif args.command == "work" and args.work_command == "block":
            lines = block_work(args)
        elif args.command == "work" and args.work_command == "unblock":
            if (args.message and not args.channel) or (args.named and not args.question):
                unblocker.error("--message needs --channel; --named needs --question")
            if not (args.question or args.message or args.lead) or (args.lead and not args.reason):
                unblocker.error("unblock needs --question, --message with --channel, or --lead with --reason")
            lines = unblock_work(args, discord)
        elif args.command == "work":
            lines = authorize_work(args, gh, discord(args.message, args.channel))
        elif args.command == "list":
            waiting = [n for n in gh.labelled() if state(n, gh.plan_comment(n)[3])[0] != "PLAN_APPROVED"]
            lines = [f"PLANS_AWAITING count={len(waiting)}" + (" issues=" + ",".join(f"#{n}" for n in waiting) if waiting else "")]
        else:
            if args.command == "drop":
                REQUEST_CLI["REQUESTS"]["dropped"](gh.repo, args.issue, now)
                PLAN_PUBLICATION["cancel_prepared"](gh.repo, args.issue)
                PLAN_PUBLICATION["reconcile"](gh, args.issue)
            _, comment_id, url, body = gh.plan_comment(args.issue)
            found, data = state(args.issue, body)
            if args.command == "show" and args.json and data:
                lines = [json.dumps(data, indent=2, ensure_ascii=False)]
            elif args.command == "drop" and comment_id:
                gh.save(args.issue, comment_id, f"Plan dropped on {now.date().isoformat()} (was revision {data['revision'] if data else '?'}).",
                        expected_body=body)
                gh.label(args.issue, False)
                lines = [f"PLAN_DROPPED issue={args.issue}"]
            elif args.command == "drop":
                gh.label(args.issue, False)
                lines = [f"PLAN_DROPPED issue={args.issue}"]
            else:
                lines = [f"{found} issue={args.issue}" + (f" revision={data['revision']} url={url}" if data else "")]
    except PLAN_PUBLICATION["Pending"] as error:
        resume = shlex.join(["helio", "plan", *(argv if argv is not None else sys.argv[1:])])
        print(f"PLAN_PENDING cause={error.cause} detail={error} resume={json.dumps(resume)}".replace("\n", " "))
        return 2
    except ISSUES["Refused"] as error:
        pending = error.uncertain or ISSUES["SYNC"]["failure_kind"](str(error)) == "transport"
        print(f"{'PLAN_PENDING' if pending else 'PLAN_REFUSED'} {error}".replace("\n", " "))
        return 2 if pending else 1
    except (Refused, VERIFICATION["Refused"], WORK["Refused"], FOLLOWUP["Refused"], REQUEST_CLI["REQUESTS"]["Refused"], ValueError) as error:
        print(f"PLAN_REFUSED {error}".replace("\n", " "))
        return 1
    except (RuntimeError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(f"PLAN_PENDING cause=read_retry detail={error}".replace("\n", " "))
        return 2
    finally:
        stack.close()
    print("\n".join(lines))
    if args.command in ("post", "approve", "pr", "drop", "work") and lines and lines[0].startswith(("PLAN_POSTED", "PLAN_APPROVED", "PLAN_PR", "PLAN_DROPPED", "WORK_AUTHORIZED")):
        try:
            sync = runpy.run_path(str(HERE / "helio_issue_sync.py"))
            sync["schedule"](gh.repo, args.issue)
        except (OSError, sqlite3.Error) as error:
            print(f"ISSUE_SYNC_PENDING issue={args.issue}: {type(error).__name__}; run helio issue sync")
    ok = ("PLAN_POSTED", "PLAN_APPROVED", "PLAN_ADOPTED", "PLAN_NONE", "PLAN_PR", "PLAN_DROPPED", "PLANS_AWAITING", "PLAN_REQUEST",
          "WORK_AUTHORIZED", "WORK_STARTED", "WORK_BLOCKED", "WORK_UNBLOCKED", "{")
    return 0 if lines and lines[0].startswith(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
