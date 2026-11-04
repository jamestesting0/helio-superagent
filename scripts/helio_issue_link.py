"""One completion/link contract shared by PR creation, release checks and issue projection."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import re

MARKER = re.compile(r"<!-- helio-implementation:(.*?) -->")


class Refused(Exception):
    """The declared implementation and GitHub relationship disagree."""


@dataclass(frozen=True, slots=True)
class Implementation:
    issue: int
    plan_revision: int | None
    complete: bool


def marker(issue: int, revision: int | None, complete: bool) -> str:
    return "<!-- helio-implementation:" + json.dumps(asdict(Implementation(issue, revision, complete)), sort_keys=True) + " -->"


def parse(body: str) -> Implementation | None:
    match = MARKER.search(body)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
    except ValueError as error:
        raise Refused("Implementation metadata is malformed; review the PR body.") from error
    if (not isinstance(data, dict) or set(data) != {"issue", "plan_revision", "complete"}
            or type(data["issue"]) is not int or data["issue"] < 1 or type(data["complete"]) is not bool
            or (data["plan_revision"] is not None and (type(data["plan_revision"]) is not int or data["plan_revision"] < 1))):
        raise Refused("Implementation metadata has an invalid shape; review the PR body.")
    return Implementation(**data)


def require_link(body: str, closing_issues: set[int], base: str) -> None:
    implementation = parse(body)
    if implementation is None:
        return
    expected = {implementation.issue} if implementation.complete else set()
    if closing_issues != expected:
        raise Refused("PR completion and GitHub closing-issue links disagree; fix the relationship before merging, not the approval.")
    if implementation.complete and base != "main":
        raise Refused("A complete Helio implementation must target main for its closing relationship.")
