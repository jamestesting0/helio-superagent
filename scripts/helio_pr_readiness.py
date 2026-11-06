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
                 "isCrossRepository,isDraft,mergeable,mergeStateStatus,statusCheckRollup")
Runner = Callable[[list[str]], str]


class Check(TypedDict, total=False):
    name: str
    context: str
    conclusion: str | None
    status: str
    state: str


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


def watch(repo: str, run: Runner) -> list[str]:
    """Repeat unresolved observations; current GitHub state is the durable source."""
    try:
        pulls: list[Pull] = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open",
                                          "--base", "main", "--limit", "10000", "--json", FIELDS]))
        managed = [pull for pull in pulls if pull["headRefName"].startswith("helio/") and not pull["isCrossRepository"]]
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
