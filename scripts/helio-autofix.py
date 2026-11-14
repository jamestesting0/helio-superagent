#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Gate automatic bug PRs: helio autofix check|submit --issue N [--worktree PATH] [--summary-file PATH]."""
from __future__ import annotations

import argparse
import runpy
import sqlite3
from dataclasses import dataclass
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Final

DEFAULT_DENY: Final = ("requirements*.txt,pyproject.toml,.github/**,elo_bot/db/**,"
                      "elo_bot/features/tokens/**,**/migrations/**,main.py,beta.py,watchdog.py,"
                      "scripts/**,models/**,assets/**,*.env*")
POSTS = runpy.run_path(str(Path(__file__).with_name("helio_github_posts.py")))
PUBLICATION = runpy.run_path(str(Path(__file__).with_name("helio_pr_publication.py")))
ISSUES = runpy.run_path(str(Path(__file__).with_name("helio_issues.py")))
PROOF = runpy.run_path(str(Path(__file__).with_name("helio_regression_proof.py")))
AUTHORITY = runpy.run_path(str(Path(__file__).with_name("helio_pr_authority.py")))
VERIFICATION = runpy.run_path(str(Path(__file__).with_name("helio_pr_verification.py")))
RUNNER: Final = PROOF["RUNNER"]
Counts = PROOF["Counts"]


@dataclass(frozen=True, slots=True)
class Refused(Exception):
    gate: str
    reason: str

    def __str__(self) -> str:
        return f"{self.gate}: {self.reason}".replace("\r", " ").replace("\n", " ")


def run(argv: list[str], cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout.strip()


def proof(project: Path, head: str, tests: list[str]):
    try:
        return PROOF["proof"](project, head, tests)
    except PROOF["Failed"] as error:
        raise Refused("proof", str(error)) from None


def task_tree(project: Path, branch: str, explicit: Path | None) -> Path:
    """The lane's own worktree for this branch; the shared checkout remains the fallback."""
    if explicit:
        return explicit.expanduser().resolve()
    found = [Path(fields["worktree"]) for record in run(["git", "worktree", "list", "--porcelain"], project).split("\n\n")
             if (fields := dict(line.split(" ", 1) for line in record.splitlines() if " " in line)).get("branch") == f"refs/heads/{branch}"]
    return found[0] if len(found) == 1 else project


def execute(args: argparse.Namespace) -> str:
    branch = f"helio/autofix-{args.issue}"
    gate = "disabled"
    try:
        if os.environ.get("HELIO_AUTOFIX", "on") != "on":
            raise Refused(gate, "HELIO_AUTOFIX is off")
        gate = "issue"
        project = Path(os.environ["HELIO_PROJECT"]).expanduser().resolve()
        repo = os.environ["HELIO_GITHUB_REPO"]
        state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
        store = ISSUES["Issues"](repo, state, command=lambda argv, _stdin=None: run(argv, project))
        pulls = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "10000",
                               "--json", "url,headRefName,body,title,closingIssuesReferences,labels"], project))
        existing = next((p["url"] for p in pulls if p["headRefName"] == branch), None)
        if (args.command == "submit" and existing and not args.report_file and not args.adopt_body
                and VERIFICATION["phase"](store, args.issue) is None):
            return f"AUTOFIX_PR {existing}"
        issue = json.loads(run(["gh", "issue", "view", str(args.issue), "--repo", repo,
                               "--json", "state,labels,body,comments"], project))
        if issue["state"] != "OPEN" or "bug" not in {label["name"] for label in issue["labels"]}:
            raise Refused(gate, "issue must be open and labelled bug")
        reference = re.compile(rf"(?:{re.escape(repo)})?#0*{args.issue}\b|"
                               rf"https://github\.com/{re.escape(repo)}/issues/0*{args.issue}\b")
        for pull in pulls:
            if pull["headRefName"] != branch and (
                any(i["number"] == args.issue for i in pull["closingIssuesReferences"])
                or reference.search(pull["body"] + "\n" + pull["title"])
            ):
                raise Refused(gate, f"another open PR references the issue: {pull['url']}")
        gate = "branch"
        tree = task_tree(project, branch, args.worktree)
        run(["git", "fetch", "--quiet", "origin", "main"], tree)
        if run(["git", "branch", "--show-current"], tree) != branch:
            raise Refused(gate, f"check out {branch}")
        if run(["git", "status", "--porcelain"], tree):
            raise Refused(gate, "worktree must be clean")
        base = run(["git", "rev-parse", "origin/main"], tree)
        head = run(["git", "rev-parse", "HEAD"], tree)
        if run(["git", "merge-base", base, head], tree) != base:
            raise Refused(gate, "branch must include current origin/main")
        gate = "size"
        statuses = run(["git", "diff", "--name-status", "-M", "-z", base, head], tree).split("\0")
        paths = []
        for index in range(0, len(statuses) - 1, 2):
            status, path = statuses[index:index + 2]
            if status not in ("A", "M"):
                raise Refused(gate, "only added or modified files are allowed; no deletions or renames")
            paths.append(path)
        tests = [path for path in paths if path.startswith("tests/") and path.endswith(".py")]
        if not tests:
            raise Refused(gate, "change at least one Python test module under tests/")
        lines, files = 0, 0
        for record in run(["git", "diff", "--numstat", "-z", base, head], tree).split("\0"):
            if not record:
                continue
            added, removed, path = record.split("\t", 2)
            if added == "-" or removed == "-":
                raise Refused(gate, "binary changes cannot be counted")
            if not path.startswith("tests/"):
                lines += int(added) + int(removed)
                files += 1
        if lines > int(os.environ.get("HELIO_AUTOFIX_MAX_LINES", "40")) or files > int(os.environ.get("HELIO_AUTOFIX_MAX_FILES", "3")):
            raise Refused(gate, f"non-test diff is {lines} lines in {files} files")
        gate = "paths"
        deny = os.environ.get("HELIO_AUTOFIX_DENY", DEFAULT_DENY).split(",")
        patterns = [pattern.strip() for pattern in deny if pattern.strip()]
        # fnmatch's `*` crosses `/`, but `**/x` must also match `x` at the repository root.
        patterns += [pattern[3:] for pattern in patterns if pattern.startswith("**/")]
        for path in paths:
            if any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns):
                raise Refused(gate, f"denied path: {path}")
        gate = "proof"
        verified = VERIFICATION["autofix_result"](project, head, tests, base=base)
        before, after = verified["regressions"][0]["before"], verified["regressions"][0]["after"]
        gate = "rate"
        count = sum(any(label["name"] == "helio-autofix" for label in p["labels"]) for p in pulls)
        if not existing and count >= int(os.environ.get("HELIO_AUTOFIX_MAX_OPEN", "3")):
            raise Refused(gate, f"open helio-autofix PR cap reached ({count})")
        if args.command == "check":
            return "AUTOFIX_OK"
        gate = "remote"
        AUTHORITY["require_unheld"](repo, args.issue)
        summary = (args.report_file or args.summary_file).read_text()
        author = POSTS["report"](summary, args.report_file is not None)
        if not summary:
            raise Refused(gate, "summary file must describe the root cause and fix")
        authority = {"kind": "autofix", "paths": paths, "lines": lines, "files": files, "deny": DEFAULT_DENY}
        scope = ISSUES["digest"](ISSUES["split"](issue.get("body") or "")[0])
        verification = VERIFICATION["record"](store, {
            "issue": args.issue, "branch": branch, "route": "autofix", "head": head, "base": base,
            "authority": VERIFICATION["digest"](json.dumps(authority, sort_keys=True)), "authority_proof": authority, "scope": scope,
            "job": f"issue-{args.issue}", "generation": VERIFICATION["phase"](store, args.issue),
        }, verified)
        remote = run(["git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}"], tree)
        if remote and remote.split()[0] != head:
            if not existing:
                raise Refused(gate, "remote branch has a different head without this task's existing PR")
            run(["git", "merge-base", "--is-ancestor", remote.split()[0], head], tree)
        if not remote or remote.split()[0] != head:
            AUTHORITY["require_unheld"](repo, args.issue)
            run(["git", "push", "origin", f"{head}:refs/heads/{branch}"], tree)
        labels = json.loads(run(["gh", "label", "list", "--repo", repo, "--limit", "10000", "--json", "name"], project))
        for name in ("helio-autofix", "needs-owner-review"):
            if name not in {label["name"] for label in labels}:
                run(["gh", "label", "create", name, "--repo", repo], project)
        body = POSTS["pr_body"](args.issue, None, author, (), verified["counts"]["run"],
                               extra_checks=(("Regression before fix", f"Tests: {before['run']}; failures: {before['failures']}; errors: {before['errors']}"),
                                             ("Regression after fix", f"Tests: {after['run']}; all passed")))
        url = PUBLICATION["publish"](store, args.issue, branch, head, body, f"Fix #{args.issue}", authority,
                                     scope, existing, args.adopt_body, ("helio-autofix",),
                                     verification=verification)
        return f"AUTOFIX_PR {url}" + (f" verification={verification}" if VERIFICATION["phase"](store, args.issue) is not None else "")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        raise Refused(gate, str(error).replace("\n", " ")) from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "submit"):
        sub = commands.add_parser(command)
        sub.add_argument("--issue", type=int, required=True)
        reports = sub.add_mutually_exclusive_group(required=command == "submit")
        reports.add_argument("--summary-file", type=Path)
        reports.add_argument("--report-file", type=Path)
        sub.add_argument("--adopt-body")
        sub.add_argument("--worktree", type=Path, help="the lane's task worktree; otherwise discovered by branch")
    args = parser.parse_args()
    if args.issue < 1:
        parser.error("--issue must be positive")
    try:
        result = execute(args)
        print(result)
        if result.startswith("AUTOFIX_PR "):
            sync = runpy.run_path(str(Path(__file__).with_name("helio_issue_sync.py")))
            try:
                sync["schedule"](os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot"), args.issue)
            except (OSError, sqlite3.Error) as error:
                print(f"ISSUE_SYNC_PENDING issue={args.issue}: {type(error).__name__}; run helio issue sync")
        return 0
    except Refused as error:
        print(f"AUTOFIX_REFUSED {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
