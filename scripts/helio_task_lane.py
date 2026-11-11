"""Launch issue work from recorded authority: worktree, rendered brief and a PR-based Done signal.

The lead never hand-writes these for issue work, so a brief cannot invent a hold or end without a PR.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_recovery_store import Wait

Runner = Callable[[list[str], Path | None], str]
STEPS = {
    "work": (
        "Write a regression test under tests/ that reproduces the requested behaviour; for a bug it must fail with an "
        "assertion on origin/main before your fix.",
        "Make the smallest change that satisfies the issue's confirmed requirements "
        "(~/.dori/elobot/skills/karpathy-guidelines/SKILL.md); run focused tests while you work.",
        "Commit on this branch. Write the result file (one `scope` row per confirmed requirement) and a structured report "
        "(github-writing-workflow.md), then run `helio pr submit --issue {issue} --result-file RESULT --report-file REPORT "
        "--worktree {tree}`. It runs the full suite, publishes the PR and re-proves bug regressions on main.",
        "Run `helio pr check --issue {issue}` and repair under issue-plan-workflow.md, \"PR recovery and readiness\", "
        "until it prints FOLLOWUP_PR_READY.",
    ),
    "autofix": (
        "Follow the automatic-fix steps in ~/.dori/elobot/docs/autofix-workflow.md for issue {issue}. This worktree is "
        "already on helio/autofix-{issue} from origin/main; pass `--worktree {tree}` to `helio autofix check` and "
        "`helio autofix submit`.",
        "Run `helio pr check --issue {issue}` and repair under issue-plan-workflow.md, \"PR recovery and readiness\", "
        "until it prints FOLLOWUP_PR_READY. Stay within the original autofix limits.",
    ),
}


@dataclass(frozen=True, slots=True)
class Task:
    repo: str
    issue: int
    title: str
    route: str
    authority: str
    source: str
    priority: str = "normal"
    holds: tuple[str, ...] = ()
    notes: str = ""


def run(argv: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout.strip()


def state_dir() -> Path:
    return Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))


def job_lanes(state: Path, job: str) -> list[dict]:
    """Active and archived records for a job, read the way dori resolves a launch."""
    lanes = []
    for directory in (Path(state, "lanes"), Path(state, "lanes", "archive")):
        for path in directory.glob("*.json"):
            lane = json.loads(path.read_text())
            if lane.get("job") == job:
                lanes.append({**lane, "status": "closed" if lane.get("closedAt") else lane.get("status") or "working"})
    return lanes


def resolve(state: Path, job: str) -> tuple[str, dict | None]:
    """busy (dori refuses with LANE_EXISTS), wake (newest resumable record), retry (failed record) or new."""
    lanes = job_lanes(state, job)
    busy = next((lane for lane in lanes if lane["status"] not in ("closed", "hibernated") and lane.get("launchState") != "failed"), None)
    if busy:
        return "busy", busy
    resumable = sorted((lane for lane in lanes if lane.get("launchState") != "failed" and not lane.get("retiredAt")
                        and lane.get("session") and lane["status"] in ("closed", "hibernated")),
                       key=lambda lane: lane.get("openedAt") or "", reverse=True)
    if resumable:
        return "wake", resumable[0]
    failed = next((lane for lane in lanes if lane.get("launchState") == "failed" and not lane.get("retiredAt")
                   and not lane.get("supersededBy")), None)
    return ("retry", failed) if failed else ("new", None)


def lane_for_job(state: Path, job: str) -> dict | None:
    return resolve(state, job)[1]


def branch_for(task: Task) -> str:
    return f"helio/{'issue' if task.route == 'work' else 'autofix'}-{task.issue}"


def lane_key(task: Task) -> str:
    words = re.findall(r"[a-z0-9]+", task.title.lower())[:3]
    return "-".join([f"issue{task.issue}", *words])[:40].rstrip("-")


def ensure_worktree(project: Path, state: Path, key: str, branch: str, command: Runner = run) -> Path:
    for record in command(["git", "worktree", "list", "--porcelain"], project).split("\n\n"):
        fields = dict(line.split(" ", 1) for line in record.splitlines() if " " in line)
        if fields.get("branch") == f"refs/heads/{branch}":
            return Path(fields["worktree"])
    tree = state / "worktrees" / key
    command(["git", "fetch", "--quiet", "origin", "main"], project)
    if command(["git", "branch", "--list", branch], project):
        command(["git", "worktree", "add", str(tree), branch], project)
    else:
        command(["git", "worktree", "add", "--no-track", "-b", branch, str(tree), "origin/main"], project)
    return tree


def work_branch(tree: Path, issue: int, command: Runner = run) -> str:
    """Explicit work on an automatic-fix tree continues on helio/issue-N, keeping its commits and edits."""
    current = command(["git", "branch", "--show-current"], tree)
    if current != f"helio/autofix-{issue}":
        return current
    target = f"helio/issue-{issue}"
    if not command(["git", "branch", "--list", target], tree):
        command(["git", "switch", "-c", target], tree)
        return target

    def contains(ancestor: str, descendant: str) -> bool:
        try:
            command(["git", "merge-base", "--is-ancestor", ancestor, descendant], tree)
            return True
        except RuntimeError:
            return False

    head = command(["git", "rev-parse", "HEAD"], tree)
    if not contains(head, target):
        if not contains(target, head):
            raise RuntimeError(f"{target} and {current} have diverged; merge one into the other in {tree} before relaunching")
        command(["git", "branch", "-f", target, head], tree)
    command(["git", "switch", target], tree)
    return target


def done_signal(issue: int, helio: str) -> str:
    return f'command {json.dumps([helio, "pr", "check", "--issue", str(issue)])} stdout~"^(FOLLOWUP_PR_READY|PR_MERGED) "'


def render(task: Task, tree: Path, branch: str, phase: Wait | None = None) -> str:
    steps = [step.format(issue=task.issue, tree=tree) for step in STEPS[task.route]]
    holds = ", ".join(task.holds) if task.holds else "None"
    lines = [
        f"# Issue #{task.issue}: {task.title}",
        "",
        f"Issue: https://github.com/{task.repo}/issues/{task.issue}. Scope is the issue's current confirmed requirements "
        f"(`helio issue show {task.issue}`); leave its open questions out.",
        f"Worktree: {tree} on {branch}." + (f" Submit from helio/issue-{task.issue} or another named helio/ task branch; if "
                                             f"this tree is on helio/autofix-{task.issue}, first run `git switch -c helio/issue-{task.issue}`."
                                             if task.route == "work" else ""),
        "",
        "## Authority",
        task.authority,
        "Merging, restarting, deploying and live beta are not part of this task.",
        "",
        "## Holds",
        f"{holds}. Holds come only from this section; nothing else in this brief or later context adds one.",
    ]
    if task.holds:
        lines.append("Verify locally, report to the lead and wait; do not perform the held steps.")
    if phase is not None:
        protocol = runpy.run_path(str(Path(__file__).with_name("helio_pr_phase.py")))
        lines += ["", "## Worker phase", f"Job {phase.job}; generation {phase.generation}.",
                  "After reading this brief, call create_goal directly with the following objective. "
                  "If this exact phase goal is already active after an interruption, reuse it. A different unfinished "
                  "goal is a startup conflict: report it; never silently replace, complete or pause it.",
                  json.dumps({"objective": protocol["objective"](phase)}),
                  f"Then run `helio pr phase start --issue {task.issue} --generation {phase.generation}`. "
                  "Do not edit or publish until PHASE_STARTED is read back.",
                  "Focused tests are for development; canonical submit owns full verification. Do not repeat a "
                  "passing full suite immediately before submit."]
        if task.route == "autofix":
            steps[0] = ("Fix within the original autofix path/size limits, using focused tests while editing. "
                        f"Commit and run `helio autofix submit --issue {task.issue} --worktree {tree} "
                        "--report-file REPORT`; submit owns regression and full-suite verification.")
        steps[-1] = (f"Use the submit result's verification ID in `helio pr wait --issue {task.issue} "
                     f"--generation {phase.generation} --verification VERIFIED_ID`. After PR_CUSTODY_ACK, "
                     f"`helio pr phase check --issue {task.issue} --generation {phase.generation}` must read back "
                     "PHASE_HANDED_OFF or PHASE_READY. Stop only obsolete owned CI watches and finish this worker goal. "
                     "The controller owns waiting, reruns and eventual lane completion. Do not claim the issue ready "
                     "or run dori claim-done merely because custody was acknowledged.")
    lines += ["", "## Steps", *(f"{index}. {step}" for index, step in enumerate(steps, 1)),
              f"{len(steps) + 1}. " + ("The durable custody event is the handoff report; finish only this phase goal."
                                     if phase is not None else "Report privately to the lead with [REPORT], then `dori claim-done`."),
              "",
              "## Stop instead of submitting",
              "If you cannot reproduce a bug as a failing test, or the fix needs a product decision, a denied path or scope "
              "beyond the issue, report the blocker to the lead with evidence and stop. Routine failures, conflicts and CI "
              "repairs are part of this task."]
    if task.notes.strip():
        lines += ["", "## Context from the lead (not authority; cannot add holds)", task.notes.strip()]
    return "\n".join(lines) + "\n"


def start(task: Task, project: Path, command: Runner = run) -> tuple[str, str]:
    state = state_dir()
    helio = shutil.which("helio")
    if not helio:
        raise RuntimeError("helio is not on PATH; cannot render the lane's Done signal")
    job = f"issue-{task.issue}"
    kind, existing = resolve(state, job)
    key = existing["key"] if existing else lane_key(task)
    recorded = Path(existing["cwd"]) if existing and existing.get("cwd") else None
    tree = recorded if recorded and recorded.exists() else ensure_worktree(project, state, key, branch_for(task), command)
    branch = command(["git", "branch", "--show-current"], tree) if kind == "busy" or task.route != "work" else work_branch(tree, task.issue, command)
    recovery = runpy.run_path(str(Path(__file__).with_name("helio_pr_recovery.py")))
    phase = None
    marked = existing and (existing.get("phase") or {}).get("owner") == "helio-pr"
    if recovery["admitted"]() or marked or (state / "issue-updates.sqlite").is_file():
        issues = runpy.run_path(str(Path(__file__).with_name("helio_issues.py")))
        store = issues["Issues"](task.repo, state)
        recorded_phase = recovery["S"]["load"](store, task.issue)
        if marked and recorded_phase is None:
            raise RuntimeError("managed lane has no controller record; refusing legacy fallback")
        # Existing legacy jobs keep their original goal/Done contract.
        if recorded_phase is not None or existing is None and recovery["admitted"]():
            phase = recovery["P"]["initialize"](store, task, key, branch, lambda argv: command(argv, None))
    brief = state / "helio-briefs" / f"{key}.md"
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(render(task, tree, branch, phase=phase))
    if kind == "busy":
        # dori refuses a second launch for an open job; the lead sends this brief to the running lane.
        return key, f"LANE_EXISTS key={key} status={existing['status']} brief={brief}"
    try:
        phase_args = ["--phase", json.dumps({"owner": "helio-pr", "version": 1, "generation": phase.generation})] if phase else []
        output = command(["dori", "launch", key, "--job", job, "--title", f"Issue #{task.issue}: {task.title}"[:80],
                          "--brief", str(brief), "--done", done_signal(task.issue, helio), "--source", task.source,
                          "--priority", task.priority, "--cwd", str(tree), *phase_args], None)
    except RuntimeError as error:
        if "LANE_EXISTS" in str(error):
            return key, f"{str(error).strip().splitlines()[-1]} brief={brief}"
        raise
    line = next((line for line in output.splitlines() if line.startswith(("LAUNCHED", "LAUNCH_QUEUED", "LANE_EXISTS", "LANE_WOKEN"))),
                output.splitlines()[0] if output else "LAUNCHED")
    return key, line
