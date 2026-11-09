#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Gate automatic bug PRs: helio autofix check|submit --issue N [--summary-file PATH]."""
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
import tempfile
from typing import Final

DEFAULT_DENY: Final = ("requirements*.txt,pyproject.toml,.github/**,database_models/**,"
                      "common/tokens/**,**/migrations/**,main.py,beta.py,watchdog.py,"
                      "scripts/**,models/**,assets/**,*.env*")
POSTS = runpy.run_path(str(Path(__file__).with_name("helio_github_posts.py")))
PUBLICATION = runpy.run_path(str(Path(__file__).with_name("helio_pr_publication.py")))
ISSUES = runpy.run_path(str(Path(__file__).with_name("helio_issues.py")))
RUNNER: Final = """
import json, pathlib, sys, unittest
root, output, *paths = sys.argv[1:]
sys.path.insert(0, root)
loader = unittest.TestLoader()
suite = unittest.TestSuite(loader.loadTestsFromName(p[:-3].replace('/', '.')) for p in paths) if paths else loader.discover('tests')
result = unittest.TextTestRunner(verbosity=2, stream=sys.stderr).run(suite)
pathlib.Path(output).write_text(json.dumps(dict(run=result.testsRun, failures=len(result.failures),
    errors=len(result.errors), skips=len(result.skipped), unexpected=len(result.unexpectedSuccesses))))
"""


@dataclass(frozen=True, slots=True)
class Counts:
    run: int
    failures: int
    errors: int
    skips: int
    unexpected: int

    def passed(self) -> bool:
        return self.run > 0 and not (self.failures or self.errors or self.skips or self.unexpected)


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


def proof(project: Path, head: str, tests: list[str]) -> tuple[Counts, Counts, Counts]:
    """Run branch tests on main, then changed tests and the full suite on the branch."""
    python = project / ".venv/bin/python"
    with tempfile.TemporaryDirectory(prefix="helio-autofix-") as temporary:
        root = Path(temporary)
        trees = []
        try:
            for name, revision in (("before", "origin/main"), ("after", head)):
                tree = root / name
                run(["git", "worktree", "add", "--detach", str(tree), revision], project)
                trees.append(tree)
            for path in tests:
                destination = trees[0] / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((trees[1] / path).read_bytes())
            results = []
            for index, (tree, modules) in enumerate(((trees[0], tests), (trees[1], tests), (trees[1], []))):
                output = root / f"result-{index}.json"
                run([str(python), "-I", "-c", RUNNER, str(tree), str(output), *modules], tree)
                results.append(Counts(**json.loads(output.read_text())))
            before, after, full = results
            if not (before.failures >= 1 and before.errors == before.skips == before.unexpected == 0):
                raise Refused("proof", f"main must have assertion failures only: {before}")
            if not after.passed() or not full.passed():
                raise Refused("proof", f"branch tests must pass: changed={after}; full={full}")
            return before, after, full
        finally:
            for tree in reversed(trees):
                run(["git", "worktree", "remove", "--force", str(tree)], project)


def execute(args: argparse.Namespace) -> str:
    branch = f"helio/autofix-{args.issue}"
    gate = "disabled"
    try:
        if os.environ.get("HELIO_AUTOFIX", "on") != "on":
            raise Refused(gate, "HELIO_AUTOFIX is off")
        gate = "issue"
        project = Path(os.environ["HELIO_PROJECT"]).expanduser().resolve()
        repo = os.environ["HELIO_GITHUB_REPO"]
        pulls = json.loads(run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "10000",
                               "--json", "url,headRefName,body,title,closingIssuesReferences,labels"], project))
        existing = next((p["url"] for p in pulls if p["headRefName"] == branch), None)
        if args.command == "submit" and existing and not args.report_file and not args.adopt_body:
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
        run(["git", "fetch", "--quiet", "origin", "main"], project)
        if run(["git", "branch", "--show-current"], project) != branch:
            raise Refused(gate, f"check out {branch}")
        if run(["git", "status", "--porcelain"], project):
            raise Refused(gate, "worktree must be clean")
        base = run(["git", "rev-parse", "origin/main"], project)
        head = run(["git", "rev-parse", "HEAD"], project)
        if run(["git", "merge-base", base, head], project) != base:
            raise Refused(gate, "branch must include current origin/main")
        gate = "size"
        statuses = run(["git", "diff", "--name-status", "-M", "-z", base, head], project).split("\0")
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
        for record in run(["git", "diff", "--numstat", "-z", base, head], project).split("\0"):
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
        before, after, full = proof(project, head, tests)
        gate = "rate"
        count = sum(any(label["name"] == "helio-autofix" for label in p["labels"]) for p in pulls)
        if not existing and count >= int(os.environ.get("HELIO_AUTOFIX_MAX_OPEN", "3")):
            raise Refused(gate, f"open helio-autofix PR cap reached ({count})")
        if args.command == "check":
            return "AUTOFIX_OK"
        gate = "remote"
        summary = (args.report_file or args.summary_file).read_text()
        author = POSTS["report"](summary, args.report_file is not None)
        if not summary:
            raise Refused(gate, "summary file must describe the root cause and fix")
        remote = run(["git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}"], project)
        if remote and remote.split()[0] != head:
            raise Refused(gate, "remote branch has a different head")
        if not remote:
            run(["git", "push", "origin", f"{head}:refs/heads/{branch}"], project)
        labels = json.loads(run(["gh", "label", "list", "--repo", repo, "--limit", "10000", "--json", "name"], project))
        for name in ("helio-autofix", "needs-owner-review"):
            if name not in {label["name"] for label in labels}:
                run(["gh", "label", "create", name, "--repo", repo], project)
        body = POSTS["pr_body"](args.issue, None, author, (), full.run,
                               extra_checks=(("Regression before fix", f"Tests: {before.run}; failures: {before.failures}; errors: {before.errors}"),
                                             ("Regression after fix", f"Tests: {after.run}; all passed")))
        authority = {"kind": "autofix", "paths": paths, "lines": lines, "files": files, "deny": DEFAULT_DENY}
        state = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
        store = ISSUES["Issues"](repo, state, command=lambda argv, _stdin=None: run(argv, project))
        url = PUBLICATION["publish"](store, args.issue, branch, head, body, f"Fix #{args.issue}", authority,
                                     ISSUES["digest"](ISSUES["split"](issue.get("body") or "")[0]),
                                     existing, args.adopt_body, ("helio-autofix",))
        return f"AUTOFIX_PR {url}"
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
