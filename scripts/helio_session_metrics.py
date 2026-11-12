#!/usr/bin/env python3
"""helio metrics: where each issue lane's time went, from its session transcripts. Read-only.

The window runs from launch to the first successful submit: a PLAN_PR or AUTOFIX_PR line in the result of a
`helio pr submit` or `helio autofix submit` call. Active time excludes only waits that end with a person's answer.
A lane's release event is the first `helio pr phase check` result printing PHASE_HANDED_OFF or PHASE_BLOCKED.
Activity categories are keyword heuristics over tool calls.
"""
from __future__ import annotations

import argparse
import time
import sqlite3
from contextlib import closing
from collections import Counter
import datetime
import json
import os
from pathlib import Path
import re
from typing import Callable
import subprocess
import sys

ESSENTIAL = {"explore", "read-code", "edit", "tests", "commit", "submit", "pr-state", "issue-state"}
CEREMONY_COUNTED = ("bookkeeping", "notes", "report-to-lead", "find-lead-pane")
SUBMITTED = re.compile(r"\b(PLAN_PR|AUTOFIX_PR) https://\S+/pull/\d+")
RELEASED = re.compile(r"\bPHASE_(HANDED_OFF|BLOCKED) issue=")
HELP = re.compile(r"\b(?:helio|dori|herdr|gh|bsk)(?: [a-z][a-z-]+){0,3} --help")
USAGE = re.compile(r"^usage: helio-\S+\.py ", re.M)
INSTRUCTIONS = re.compile(r"(/skills/|/docs/|SKILL\.md|workflow\.md|/references/|/runbooks/|work-policy\.md|setup-prompt\.md|/briefs/)")
TRUNCATED = re.compile(r"Output truncated|\[Full output:")
ARTIFACT = re.compile(r"/\.omo/agent/sessions/.*artifacts")
PHASE_CHECK = re.compile(r"helio pr phase check|'pr','phase','check'")
COMMAND = re.compile(r"\b(?:helio|dori|herdr|gh|git|bun|bunx|python3?|pytest|rg|grep|sed|cat|ls|find)\b[^\n'\"`;|&]{0,50}")
CLOSING_LINK = "closing-issue links disagree"


def when(value: str) -> float:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def text(message: dict) -> str:
    return " ".join(part.get("text", "") for part in message.get("content", []) if isinstance(part, dict))


def classify(name: str, args: dict) -> str:
    """The evidence review's categories, so baselines and new measurements compare."""
    a = args if isinstance(args, dict) else {}
    if name in ("todo", "create_goal", "update_goal", "memory"):
        return "bookkeeping"
    if name == "task" or name.startswith("task_"):
        return "subagent"
    if name in ("apply_patch", "edit", "write"):
        return "notes" if str(a.get("path") or a.get("file_path") or a.get("input") or "").startswith("/tmp") else "edit"
    if name in ("read", "Read"):
        path = str(a.get("path") or a.get("file_path") or "")
        if ARTIFACT.search(path):
            return "reread-truncated-output"
        return "instructions" if INSTRUCTIONS.search(path) or path.startswith("/tmp/ulw") else "read-code"
    if name == "eval":
        low = str(a.get("code") or "").lower()
        for category, found in (
                ("claim-done", "claim-done" in low),
                ("submit", bool(re.search(r"helio (pr|autofix) submit|'(pr|autofix)','submit'", low))),
                ("report-to-lead", ("herdr" in low and ("prompt" in low or "send" in low)) or "[report]" in low
                 or "dori send" in low or "dori report" in low or "'dori','report'" in low),
                ("find-lead-pane", "herdr" in low),
                ("commit", bool(re.search(r"git[^\n]{0,60}commit|'commit'", low))),
                ("tests", "unittest" in low or "pytest" in low),
                ("notes", any(marker in low for marker in ("appendfile(note", "ulw-", "mkdtemp", "mktemp", "fs.rm("))),
                ("pr-state", any(marker in low for marker in ("helio pr check", "gh pr ", "gh run", "helio pr phase", "helio pr wait"))),
                ("question", any(marker in low for marker in ("helio question", "helio work block", "helio work unblock"))),
                ("issue-state", "helio issue" in low or "helio decide" in low),
                ("monitor", "tool.monitor" in low)):
            if found:
                return category
        return "explore"
    return "explore" if name in ("bash_output", "tool_search", "web_search", "webfetch") else "other:" + name


def rows(path: Path) -> list[dict]:
    found = []
    with path.open(encoding="utf-8") as source:
        for line in source:
            try:
                found.append(json.loads(line))
            except ValueError:
                continue
    return found


def mentions(text: str, references: set[str]) -> bool:
    """A whole session id, file path or monitor title: bash_7 is not bash_70, submit.log is not submit.log.old."""
    return any(re.search(r"(?<![\w./-])" + re.escape(reference) + r"(?![\w./-])", text) for reference in references)


def first_output(events: list[dict], results: dict, launched: Callable[[str, str], bool], line: re.Pattern) -> float | None:
    """When `line` first appears in output of a command `launched` selects: its own result, or later output of the
    background session, log file or monitor it started (bash_output, a tail of its log, its notices)."""
    references: set[str] = set()
    for row in events:
        if row.get("type") == "custom_message":
            content = str(row.get("content", ""))
            if line.search(content) and mentions(content, references):
                return when(row["timestamp"])
            continue
        message = row.get("message") if row.get("type") == "message" else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for part in message.get("content", []):
            if not isinstance(part, dict) or "name" not in part:
                continue
            args = part.get("arguments") or part.get("input") or {}
            command = json.dumps(args) if isinstance(args, dict) else str(args)
            result = results.get(part.get("id"))
            raw = str(args.get("code") or args.get("command") or "") if isinstance(args, dict) else ""
            own = launched(part["name"], raw)
            if own:
                references.update(re.findall(r">>?\s*(/tmp/[\w./-]+)", raw))
                references.update(f"Monitor event({name})" for name in re.findall(r"description\s*:\s*['\"`]([^'\"`]+)['\"`]", raw))
                if result:
                    references.update(re.findall(r"\bbash_\d+\b", result[1]))
            if result and line.search(result[1]) and (own or mentions(command, references)):
                return result[0]
    return None


def lane_metrics(paths: list[Path]) -> dict:
    events = [row for path in sorted(paths) for row in rows(path)]
    if not events:
        return {"status": "empty"}
    results = {}
    for row in events:
        message = row.get("message") if row.get("type") == "message" else None
        if isinstance(message, dict) and message.get("role") == "toolResult":
            results[message.get("toolCallId")] = (message.get("timestamp", 0) / 1000 or when(row["timestamp"]), text(message),
                                                  message.get("toolName"))
    start = when(events[0]["timestamp"])
    submitted = first_output(events, results, lambda name, command: classify(name, {"code": command}) == "submit"
                             if name == "eval" else bool(re.search(r"helio (pr|autofix) submit", command)), SUBMITTED)
    released = first_output(events, results, lambda name, command: bool(PHASE_CHECK.search(command)), RELEASED)
    trips = human = 0.0
    categories: Counter = Counter()
    instruction_chars = 0
    totals: Counter = Counter()
    truncated_by: Counter = Counter()
    previous_end, wake = start, "start"
    awaiting_work = False  # a continuation that is followed by no real work before the next one is an idle wake
    for row in events:
        kind = row.get("type")
        at = when(row["timestamp"]) if row.get("timestamp") else previous_end
        if kind == "custom_message":
            custom = row.get("customType")
            content = str(row.get("content", ""))
            if custom == "goal-continuation":
                totals["goal_continuations"] += 1
                totals["idle_wakes"] += awaiting_work
                awaiting_work = True
                if released is not None and at > released:
                    totals["wakes_after_release"] += 1
                wake = "other"
            elif custom == "senpi-monitor:notification":
                wake = "human" if "QUESTION_ANSWERED" in content else "monitor"
            continue
        if kind != "message":
            continue
        message = row["message"]
        if message.get("role") == "user":
            wake = "human" if re.search(r"OWNER|requested|\[LEAD\] .*answer", text(message)) else "other"
            continue
        if message.get("role") != "assistant":
            continue
        timing = message.get("timing") or {}
        requested = (timing.get("requestedAt") or 0) / 1000
        ended = (timing.get("endedAt") or 0) / 1000
        in_window = submitted is None or (requested or at) <= submitted
        calls = [part for part in message.get("content", []) if isinstance(part, dict) and "name" in part]
        names = [classify(part["name"], part.get("arguments") or part.get("input") or {}) for part in calls]
        if any(name not in CEREMONY_COUNTED for name in names):
            awaiting_work = False
        for part, category in zip(calls, names):
            args = part.get("arguments") or part.get("input") or {}
            command = str(args.get("code") or args.get("command") or "") if isinstance(args, dict) else ""
            totals["help_lookups"] += len(HELP.findall(command))
            result = results.get(part.get("id"))
            if result:
                totals["usage_errors"] += len(USAGE.findall(result[1]))
                if TRUNCATED.search(result[1]):
                    found = COMMAND.search(command)
                    truncated_by[found.group(0).strip() if found else part["name"]] += 1
                totals["closing_link_refusals"] += CLOSING_LINK in result[1]
                if in_window and category == "instructions":
                    instruction_chars += len(result[1])
        if in_window:
            trips += 1
            gap = (requested - previous_end) if requested else 0
            if gap > 15 and wake == "human":
                human += gap
            categories[names[0] if names else "final-text"] += 1
        ends = [results[part["id"]][0] for part in calls if part.get("id") in results]
        previous_end = max(ends) if ends else (ended or at)
        wake = "self"
    essential = sum(count for name, count in categories.items() if name in ESSENTIAL)
    window = None if submitted is None else submitted - start
    return {
        "status": "submitted" if submitted is not None else "open",
        "minutes_to_submit": None if window is None else round(window / 60, 1),
        "human_wait_minutes": round(human / 60, 1),
        "active_minutes": None if window is None else round((window - human) / 60, 1),
        "round_trips": int(trips),
        "ceremony_share_pct": round(100 * (trips - essential) / trips) if trips else None,
        "instruction_kchars": round(instruction_chars / 1000),
        "bookkeeping_trips": sum(categories[name] for name in CEREMONY_COUNTED),
        "goal_continuations": totals["goal_continuations"],
        "idle_wakes": totals["idle_wakes"] + awaiting_work,
        "wakes_after_release": totals["wakes_after_release"] if released is not None else None,
        "usage_errors": totals["usage_errors"], "help_lookups": totals["help_lookups"],
        "closing_link_refusals": totals["closing_link_refusals"],
        "truncated_outputs": sum(truncated_by.values()), "truncated_by": dict(truncated_by.most_common(5)),
    }


def changed_lines(tree: Path) -> int | None:
    if not (tree / ".git").exists():
        return None
    try:
        numstat = subprocess.run(["git", "-C", str(tree), "diff", "--numstat", "origin/main...HEAD"],
                                 capture_output=True, text=True, timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return sum(int(added) + int(removed) for added, removed, path in
               (line.split("\t", 2) for line in numstat.splitlines()) if added.isdigit() and not path.startswith("tests/"))


def lead_reads(path: Path) -> dict:
    """One lead session: runbook reads and the characters they returned."""
    events = rows(path)
    results = {message.get("toolCallId"): len(text(message)) for message in
               (row.get("message") for row in events if row.get("type") == "message")
               if isinstance(message, dict) and message.get("role") == "toolResult"}
    reads = characters = 0
    for row in events:
        message = row.get("message") if row.get("type") == "message" else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for part in message.get("content", []):
            if not isinstance(part, dict) or part.get("name") not in ("read", "Read"):
                continue
            args = part.get("arguments") or part.get("input") or {}
            if "/docs/" in str(args.get("path") or args.get("file_path") or ""):
                reads += 1
                characters += results.get(part.get("id"), 0)
    return {"runbook_reads": reads, "characters": characters, "characters_per_read": round(characters / reads) if reads else None}


def custody(state: Path, issue: int, now: float) -> dict:
    """Stopped time and owner questions for the lane's issue, from its custody record (absent for unmanaged lanes)."""
    path = state / "issue-updates.sqlite"
    if not path.is_file():
        return {"stop_minutes": None, "escalations": None}
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute("SELECT data FROM pr_waits WHERE issue=?", (issue,)).fetchone()
    except sqlite3.Error:
        return {"stop_minutes": None, "escalations": None}
    if row is None:
        return {"stop_minutes": None, "escalations": None}
    data = json.loads(row[0])
    stopped = sum(item["until"] - item["since"] for item in data.get("stops") or [])
    if data.get("stop"):
        stopped += now - data["stop"]["since"]
    asked = sum(item["detail"].startswith(("Asked owner", "Asked owner again")) for item in data.get("notices") or [])
    return {"stop_minutes": round(stopped / 60, 1), "escalations": asked}


def collect(home: Path, since: str | None) -> dict:
    state = Path(os.environ.get("DORI_STATE_DIR", str(home / ".dori/elobot/state")))
    sessions = home / ".omo/agent/sessions"
    lanes = {}
    for directory in (state / "lanes", state / "lanes/archive"):
        for path in sorted(directory.glob("*.json")):
            record = json.loads(path.read_text())
            if not re.fullmatch(r"issue-\d+", record.get("job") or "") or (since and record.get("openedAt", "") < since):
                continue
            folder = sessions / ("-" + str(Path(record.get("cwd") or "")).replace("/", "-") + "--")
            transcripts = [p for p in folder.glob("*.jsonl") if p.is_file() and not p.is_symlink()] if folder.is_dir() else []
            lanes[record["key"]] = {"job": record["job"], "opened": record.get("openedAt"), "profile": record.get("profile"),
                                    "non_test_lines": changed_lines(Path(record.get("cwd") or "/nonexistent")),
                                    **custody(state, int(record["job"].split("-")[1]), time.time()),
                                    **lane_metrics(transcripts)}
    project = os.environ.get("HELIO_PROJECT", str(home / "PythonProjects/elo-bot"))
    lead_dir = sessions / ("-" + project.replace("/", "-") + "--")
    lead = sorted(lead_dir.glob("*.jsonl")) if lead_dir.is_dir() else []
    return {"lanes": lanes, "lead": {p.name: lead_reads(p) for p in lead if not since or p.name >= since}}


def main() -> int:
    parser = argparse.ArgumentParser(description="Per-lane time and ceremony from Helio session transcripts (read-only).")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--since", help="ISO date; only lanes opened (and lead sessions started) from then on")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = collect(args.home, args.since)
    if args.json:
        print(json.dumps(report, indent=1))
        return 0
    for key, lane in report["lanes"].items():
        print(f"{key}: " + ", ".join(f"{name}={value}" for name, value in lane.items() if name not in ("job", "truncated_by")))
    for name, session in report["lead"].items():
        print(f"lead {name}: " + json.dumps(session))
    return 0


if __name__ == "__main__":
    sys.exit(main())
