"""Read-only PR readiness, shared by explicit inspection and the follow-up watch."""
from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
import re
import runpy
import subprocess
from typing import Final, TypedDict

FIELDS: Final = ("number,url,state,headRefName,headRefOid,baseRefName,baseRefOid,"
                 "isCrossRepository,isDraft,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences")
Runner = Callable[[list[str]], str]


class Check(TypedDict, total=False):
    name: str
    context: str
    conclusion: str | None
    status: str
    state: str
    detailsUrl: str
    targetUrl: str


class Reference(TypedDict):
    number: int


class Pull(TypedDict):
    number: int
    url: str
    state: str
    headRefName: str
    headRefOid: str
    baseRefName: str
    baseRefOid: str
    isCrossRepository: bool
    isDraft: bool
    mergeable: str
    mergeStateStatus: str
    statusCheckRollup: list[Check] | None
    closingIssuesReferences: list[Reference]


class DetailedPull(Pull, total=False):
    body: str


class Observation(TypedDict):
    number: int
    url: str
    branch: str
    head: str
    base: str
    repair: list[str]
    waiting: list[str]
    read: str


def current_main(repo: str, run: Runner) -> str:
    base = run(["gh", "api", f"repos/{repo}/branches/main", "--jq", ".commit.sha"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise RuntimeError("current main revision is unavailable")
    return base


def inspect(repo: str, pull: Pull, run: Runner) -> tuple[str, Observation]:
    """Bind readiness to the immutable head/base pair observed on GitHub."""
    checker = runpy.run_path(str(Path(__file__).with_name("release-check.py")))
    repair: list[str] = []
    waiting: list[str] = []
    base, head = pull["baseRefOid"], pull["headRefOid"]
    comparison = json.loads(run(["gh", "api", f"repos/{repo}/compare/{base}...{head}?per_page=1"]))
    if comparison["merge_base_commit"]["sha"] != base:
        repair.append("main advanced; merge it into the task branch and verify the new head")
    if pull["isDraft"]:
        waiting.append("draft PR")
    try:
        checker["require_mergeable"](pull["mergeable"], pull["mergeStateStatus"])
    except checker["Refused"] as error:
        target = waiting if pull["mergeable"] == "UNKNOWN" else repair
        target.append(str(error))
    try:
        checker["require_passing"](pull["statusCheckRollup"])
    except checker["Refused"] as error:
        reason = str(error)
        target = waiting if reason.startswith("PR checks still running:") else repair
        target.append(reason)
    observation: Observation = {
        "number": pull["number"], "url": pull["url"], "branch": pull["headRefName"],
        "head": head, "base": base, "repair": repair, "waiting": waiting,
        "read": f"helio pr check --number {pull['number']}",
    }
    if repair:
        return "FOLLOWUP_PR_REPAIR", observation
    if waiting:
        return "FOLLOWUP_PR_WAIT", observation
    return "FOLLOWUP_PR_READY", observation


def check(repo: str, number: int, run: Runner) -> str:
    pull: Pull = json.loads(run(["gh", "pr", "view", str(number), "--repo", repo, "--json", FIELDS]))
    if pull["state"] != "OPEN" or pull["baseRefName"] != "main" or pull["isCrossRepository"]:
        raise RuntimeError("PR is not open against canonical main; inspect its current target")
    prefix, observation = inspect(repo, {**pull, "baseRefOid": current_main(repo, run)}, run)
    return f"{prefix} {json.dumps(observation)}"


def canonical_branches(issue: int) -> tuple[str, str]:
    return f"helio/issue-{issue}", f"helio/autofix-{issue}"


def open_for_issue(pulls: list[dict], issue: int) -> list[dict]:
    """Open canonical Helio PRs implementing this issue, by task branch or closing reference."""
    return [pull for pull in pulls if pull["headRefName"].startswith("helio/") and not pull.get("isCrossRepository")
            and (pull["headRefName"] in canonical_branches(issue)
                 or any(ref.get("number") == issue for ref in pull.get("closingIssuesReferences") or []))]


def for_issue(repo: str, issue: int, run: Runner) -> str:
    """Readiness of the issue's PR; a merged canonical PR still counts as delivered work."""
    pulls = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--base", "main",
                            "--limit", "10000", "--json", FIELDS]))
    found = open_for_issue(pulls, issue)
    if found:
        prefix, observation = inspect(repo, {**found[0], "baseRefOid": current_main(repo, run)}, run)
        return f"{prefix} {json.dumps(observation)}"
    for branch in canonical_branches(issue):
        merged = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "merged", "--head", branch,
                                 "--json", "number,url"]))
        if merged:
            return f"PR_MERGED {json.dumps({'issue': issue, 'number': merged[0]['number'], 'url': merged[0]['url']})}"
    return f"PR_NONE {json.dumps({'issue': issue})}"


def watch(repo: str, run: Runner, excluded: set[int] | None = None) -> list[str]:
    """Repeat unresolved observations; current GitHub state is the durable source."""
    try:
        pulls: list[Pull] = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open",
                                          "--base", "main", "--limit", "10000", "--json", FIELDS]))
        managed = [pull for pull in pulls if pull["headRefName"].startswith("helio/") and not pull["isCrossRepository"]]
        if excluded:
            managed = [pull for pull in managed if not any(open_for_issue([pull], issue) for issue in excluded)]
        if not managed:
            return []
        base = current_main(repo, run)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        return [f"FOLLOWUP_WARN PR inspection unavailable: {error}".replace("\n", " ")[:1000]]
    lines = []
    for pull in managed:
        try:
            prefix, observation = inspect(repo, {**pull, "baseRefOid": base}, run)
            summary = {key: observation[key] for key in ("number", "head", "base", "read")}
            summary["preview"] = "; ".join(observation["repair"] + observation["waiting"])[:300]
            lines.append(f"{prefix} {json.dumps(summary)}")
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            lines.append(f"FOLLOWUP_WARN pr={pull['number']} readiness unavailable: {error}".replace("\n", " ")[:1000])
    return lines
