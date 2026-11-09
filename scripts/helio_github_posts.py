"""Compose GitHub documents from explicit author fields and verified results."""
from __future__ import annotations

from dataclasses import dataclass
import html
import json
from pathlib import Path
import re
import runpy
from typing import Literal

BODY = runpy.run_path(str(Path(__file__).with_name("helio_github_body.py")))
LINK = runpy.run_path(str(Path(__file__).with_name("helio_issue_link.py")))
ISSUE_FORMAT = "<!-- helio-issue-format:2 -->"


class Refused(ValueError):
    """Author input is malformed or can corrupt the generated document."""


@dataclass(frozen=True, slots=True)
class Report:
    summary: str
    changes: tuple[tuple[str, tuple[str, ...]], ...] = ()
    verification: tuple[tuple[str, str], ...] = ()
    review_notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Coverage:
    requirement: str
    status: Literal["met", "deviation"]
    evidence: str


def text(value: str, name: str, legacy: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Refused(f"{name} requires non-empty text")
    if re.search(r"<!--\s*helio-", value, re.I):
        raise Refused(f"{name} contains reserved Helio metadata")
    fence = ""
    for line in value.splitlines():
        if not fence and not legacy and (re.match(r"^ {0,3}#{1,6}(?:\s|$)", line)
                                        or re.search(r"</?(?:details|summary|h[1-6])\b", line, re.I)):
            raise Refused(f"{name}: use named fields for headings and expandable sections")
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if match:
            if not fence:
                fence = match[1]
            elif match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = ""
    if fence:
        raise Refused(f"{name} has an unclosed code fence")
    return value


def strings(values: list[str], name: str) -> tuple[str, ...]:
    if not isinstance(values, list):
        raise Refused(f"{name} requires a list of text")
    return tuple(text(value, name) for value in values)


def cell(value: str) -> str:
    link = r"<https?://[^\s<>]+>"
    pieces = re.split(f"({link})", " ".join(value.split()))
    return "".join(piece if re.fullmatch(link, piece) else html.escape(piece, quote=False) for piece in pieces).replace("|", "\\|")


def groups(values: dict[str, list[str]], name: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    if not isinstance(values, dict):
        raise Refused(f"{name} requires named lists")
    return tuple((cell(text(key, name)), strings(entries, name)) for key, entries in values.items())


def bullets(entries: tuple[str, ...]) -> list[str]:
    lines = []
    for entry in entries:
        first, *rest = entry.splitlines()
        lines += [f"- {first}", *("  " + line for line in rest)]
    return lines


def report(raw: str, structured: bool = False) -> Report:
    if not structured:
        return Report(text(raw, "summary", legacy=True))
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) - {"summary", "changes", "verification", "review_notes"}:
        raise Refused("Report requires summary, optional changes, verification and review_notes")
    checks = data.get("verification", {})
    if not isinstance(checks, dict):
        raise Refused("verification requires named results")
    if any(" ".join(name.lower().split()) in ("unit", "unit suite", "unit tests", "full unit suite", "full unit tests") for name in checks):
        raise Refused("The submission gate owns the unit-suite result; omit it from verification")
    return Report(text(data.get("summary"), "summary"), groups(data.get("changes", {}), "changes"),
                  tuple((cell(text(key, "check")), text(value, "result")) for key, value in checks.items()),
                  strings(data.get("review_notes", []), "review_notes"))


def issue_draft(raw: str) -> str:
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) - {"summary", "requirements", "context", "evidence"}:
        raise Refused("Issue draft requires summary and requirements, with optional context and evidence")
    requirements = groups(data.get("requirements"), "requirements")
    if not requirements or not any(entries for _, entries in requirements):
        raise Refused("Issue draft requires at least one requirement")
    lines = [ISSUE_FORMAT, "## Summary", text(data.get("summary"), "summary"), "", "## Requirements"]
    for name, entries in requirements:
        if entries:
            lines += ["", f"### {name}", *bullets(entries)]
    context = data.get("context", {})
    if not isinstance(context, dict):
        raise Refused("context requires named text sections")
    if context:
        lines += ["", "## Context"]
        for name, value in context.items():
            lines += ["", f"### {cell(text(name, 'context heading'))}", text(value, name)]
    if data.get("evidence"):
        lines += ["", "<details>", "<summary>Sources and technical investigation</summary>", "",
                  text(data["evidence"], "evidence"), "", "</details>"]
    return bounded("\n".join(lines) + "\n")


def bounded(body: str) -> str:
    if len(body) > 65536:
        raise Refused("Rendered GitHub body exceeds 65536 characters; preserve the draft and split its supporting evidence")
    return body


def pr_body(issue: int, revision: int | None, author: Report, coverage: tuple[Coverage, ...],
            tests: int, plan_url: str = "", history: str = "", extra_checks: tuple[tuple[str, str], ...] = ()) -> str:
    complete = all(item.status == "met" for item in coverage)
    lines = [f"{'Fixes' if complete else 'Refs'} #{issue}", "", BODY["START"], "## Summary"]
    lines += [author.summary]
    if author.changes:
        lines += ["", "## Changes"]
        for name, entries in author.changes:
            if entries:
                lines += ["", f"### {name}", *bullets(entries)]
    lines += ["", "## Verification", "| Check | Result |", "|---|---|",
              f"| Unit suite | {tests} {'test' if tests == 1 else 'tests'} passed |",
              *(f"| {name} | {cell(value)} |" for name, value in (*author.verification, *extra_checks))]
    if coverage:
        lines += ["", "<details>", "<summary>Requirement coverage and detailed evidence</summary>", ""]
        if plan_url:
            lines += [f"[Approved plan (revision {revision})]({plan_url})", ""]
        lines += ["| Requirement | Result | Evidence |", "|---|---|---|",
                  *(f"| {cell(item.requirement)} | {item.status} | {cell(item.evidence)} |" for item in coverage),
                  "", "</details>"]
    if author.review_notes or not complete:
        lines += ["", "## Review notes", *bullets(author.review_notes)]
        if not complete:
            lines += ["- Remaining scope: " + "; ".join(cell(item.requirement) for item in coverage if item.status != "met") + "."]
    if history:
        lines += ["", f"Related history: {history}"]
    lines += ["", LINK["marker"](issue, revision, complete)]
    return bounded(BODY["seal"]("\n".join(lines)))


def update_note(note: str) -> str:
    cleaned = re.sub(r"^(?:\*\*)?Issue updated(?::\*\*|\*\*:|:| with\b)\s*", "", note.strip(), flags=re.I)
    return f"**Issue updated:** {cleaned}"


def delivery(content: str, facts: list[str], observed: str) -> str:
    rendered = " · ".join(" ".join(fact.split()) for fact in facts)
    return f"<!-- helio-status:start -->\n**Delivery:** {rendered or 'Implementation and deployment not verified.'}\n**As of:** {observed}\n<!-- helio-status:end -->\n\n{content.rstrip()}"
