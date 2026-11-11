# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Submit-owned test evidence; run through helio pr submit or helio autofix submit."""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import time
from typing import Final, Protocol, TypedDict

PROOF: Final = runpy.run_path(str(Path(__file__).with_name("helio_regression_proof.py")))
PROBE: Final = """
import importlib.metadata, json, pathlib, sys
print(json.dumps({"python": str(pathlib.Path(sys.executable).resolve()), "version": sys.version,
 "distributions": sorted((d.metadata.get("Name", ""), d.version) for d in importlib.metadata.distributions())}))
"""


class Refused(RuntimeError):
    """Verification evidence is missing, changed or not bound to this publication."""


class Counts(TypedDict):
    run: int
    failures: int
    errors: int
    skips: int
    unexpected: int


class Inputs(TypedDict):
    python: str
    version: str
    distributions_sha256: str
    manifests: dict[str, str]
    runner_sha256: str


class Regression(TypedDict):
    base: str
    head: str
    tests: list[str]
    before: Counts
    after: Counts


class Suite(TypedDict):
    counts: Counts
    inputs: Inputs
    started_at: float
    finished_at: float
    regressions: list[Regression]


class Context(TypedDict):
    issue: int
    branch: str
    route: str
    head: str
    base: str
    authority: str
    authority_proof: dict[str, Json]
    scope: str
    job: str
    generation: int | None


class Evidence(TypedDict):
    repo: str
    context: Context
    suite: Suite


Json = str | int | float | bool | None | list["Json"] | dict[str, "Json"]


class Publication(TypedDict):
    issue: int
    head: str
    branch: str
    scope: str
    authority: dict[str, Json]
    url: str
    verification: str


class Pull(TypedDict):
    headRefOid: str
    headRefName: str


class Store(Protocol):
    repo: str
    state: Path

    def operations(self) -> AbstractContextManager[sqlite3.Connection]: ...


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def canonical(value: Evidence | Suite | Context | Inputs) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def migrate(db: sqlite3.Connection) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS pr_verifications (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue INTEGER NOT NULL,
        head TEXT NOT NULL, base TEXT NOT NULL, branch TEXT NOT NULL,
        record TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'verified',
        pr TEXT, operation TEXT, created_at REAL NOT NULL, published_at REAL)""")


def command(argv: list[str], cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise Refused((result.stderr or result.stdout).strip()[-1000:] or f"{argv[0]} failed")
    return result.stdout


def snapshot(project: Path, head: str, runner: str) -> Inputs:
    """Read the actual test interpreter and immutable dependency manifests."""
    environment = json.loads(command([str(project / ".venv/bin/python"), "-I", "-c", PROBE], project))
    manifests = {}
    for record in command(["git", "ls-tree", "-r", "-z", head], project).split("\0"):
        if not record:
            continue
        metadata, path = record.split("\t", 1)
        name = Path(path).name
        if name in ("pyproject.toml", "uv.lock", "poetry.lock", "Pipfile.lock", "setup.cfg", "setup.py") or (
                name.startswith("requirements") and name.endswith(".txt")):
            manifests[path] = metadata.split()[2]
    return {"python": environment["python"], "version": environment["version"],
            "distributions_sha256": digest(json.dumps(environment["distributions"], sort_keys=True)),
            "manifests": manifests, "runner_sha256": digest(runner)}


def check_suite(suite: Suite) -> None:
    counts = suite["counts"]
    if counts["run"] <= 0 or any(counts[key] for key in ("failures", "errors", "skips", "unexpected")):
        raise Refused(f"full unit suite must pass: {counts}")
    if suite["finished_at"] < suite["started_at"] or not suite["inputs"]["runner_sha256"]:
        raise Refused("suite evidence has invalid timing or runner identity")
    for regression in suite["regressions"]:
        before, after = regression["before"], regression["after"]
        if not regression["tests"] or before["failures"] < 1 or any(
                before[key] for key in ("errors", "skips", "unexpected")) or after["run"] <= 0 or any(
                after[key] for key in ("failures", "errors", "skips", "unexpected")):
            raise Refused("regression evidence must be assertion-red on main and green on the task head")


def full_suite(project: Path, head: str) -> Suite:
    started = time.time()
    runner = PROOF["RUNNER"]
    inputs = snapshot(project, head, runner)
    with tempfile.TemporaryDirectory(prefix="helio-pr-") as temporary:
        tree, output = Path(temporary) / "tree", Path(temporary) / "result.json"
        command(["git", "worktree", "add", "--detach", str(tree), head], project)
        try:
            command([str(project / ".venv/bin/python"), "-I", "-c", runner, str(tree), str(output)], tree)
            counts = json.loads(output.read_text())
        finally:
            command(["git", "worktree", "remove", "--force", str(tree)], project)
    suite: Suite = {"counts": counts, "inputs": inputs, "started_at": started,
                    "finished_at": time.time(), "regressions": []}
    check_suite(suite)
    if snapshot(project, head, runner) != inputs:
        raise Refused("test interpreter or dependencies changed during verification")
    return suite


def regression(project: Path, head: str, tests: list[str], suite: Suite, *, base: str) -> Suite:
    try:
        before, after, _ = PROOF["proof"](project, head, tests, full=False, base=base)
    except PROOF["Failed"] as error:
        raise Refused(str(error)) from error
    if snapshot(project, head, PROOF["RUNNER"]) != suite["inputs"]:
        raise Refused("verification inputs changed during regression proof")
    result: Suite = {**suite, "finished_at": time.time(), "regressions": [
        {"base": base, "head": head, "tests": tests, "before": asdict(before), "after": asdict(after)}]}
    check_suite(result)
    return result


def autofix_result(project: Path, head: str, tests: list[str], *, base: str | None = None) -> Suite:
    started = time.time()
    inputs = snapshot(project, head, PROOF["RUNNER"])
    base = base or command(["git", "rev-parse", "origin/main"], project).strip()
    try:
        before, after, whole = PROOF["proof"](project, head, tests, base=base)
    except PROOF["Failed"] as error:
        raise Refused(str(error)) from error
    if whole is None:
        raise Refused("automatic-fix verification omitted the full suite")
    if snapshot(project, head, PROOF["RUNNER"]) != inputs:
        raise Refused("verification inputs changed during automatic-fix proof")
    result: Suite = {"counts": asdict(whole), "inputs": inputs, "started_at": started,
                     "finished_at": time.time(), "regressions": [
                         {"base": base, "head": head, "tests": tests, "before": asdict(before), "after": asdict(after)}]}
    check_suite(result)
    return result


def record(store: Store, context: Context, suite: Suite) -> str:
    check_suite(suite)
    if context["authority"] != digest(json.dumps(context["authority_proof"], sort_keys=True)):
        raise Refused("verification source proof does not match its authority fingerprint")
    if context["route"] in ("autofix", "bug-report") and not suite["regressions"]:
        raise Refused("this publication requires submit-owned regression evidence")
    if any((item["base"], item["head"]) != (context["base"], context["head"]) for item in suite["regressions"]):
        raise Refused("regression execution does not match the receipt's immutable base and head")
    evidence: Evidence = {"repo": store.repo, "context": context, "suite": suite}
    serialized = canonical(evidence)
    identity = digest(serialized)
    with store.operations() as db:
        db.execute("""INSERT OR IGNORE INTO pr_verifications
            (id,repo,issue,head,base,branch,record,created_at) VALUES (?,?,?,?,?,?,?,?)""",
                   (identity, store.repo, context["issue"], context["head"], context["base"],
                    context["branch"], serialized, time.time()))
    return identity


def phase(store: Store, issue: int) -> int | None:
    """Legacy tasks have no recovery row; managed tasks retain their generation."""
    with store.operations() as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='pr_waits'").fetchone() is None:
            return None
        row = db.execute("SELECT generation FROM pr_waits WHERE repo=? AND issue=?",
                         (store.repo, issue)).fetchone()
    return row[0] if row else None


def bound(db: sqlite3.Connection, repo: str, change: Publication) -> Evidence:
    """Check the receipt before any publication write, including journal recovery."""
    identity = change["verification"]
    row = db.execute("SELECT record FROM pr_verifications WHERE id=? AND repo=?", (identity, repo)).fetchone()
    if row is None or digest(row[0]) != identity:
        raise Refused("publication has no intact submit-owned verification receipt")
    evidence: Evidence = json.loads(row[0])
    context = evidence["context"]
    expected = (change["issue"], change["head"], change["branch"], change["scope"], digest(json.dumps(change["authority"], sort_keys=True)))
    if (context["issue"], context["head"], context["branch"], context["scope"], context["authority"]) != expected:
        raise Refused("verification receipt does not belong to this publication")
    return evidence


def published(db: sqlite3.Connection, repo: str, operation: str, change: Publication, pull: Pull) -> None:
    evidence = bound(db, repo, change)
    context = evidence["context"]
    if pull.get("headRefOid") != context["head"] or pull.get("headRefName") != context["branch"]:
        raise Refused("PR does not represent the tested publication")
    db.execute("""UPDATE pr_verifications SET status='published',pr=?,operation=?,published_at=?
        WHERE id=?""", (change["url"], operation, time.time(), change["verification"]))


def read(store: Store, identity: str) -> Evidence:
    with store.operations() as db:
        row = db.execute("SELECT record,status FROM pr_verifications WHERE id=? AND repo=?",
                         (identity, store.repo)).fetchone()
    if row is None or row[1] != "published" or digest(row[0]) != identity:
        raise Refused("missing, unpublished or damaged verification receipt")
    evidence: Evidence = json.loads(row[0])
    check_suite(evidence["suite"])
    return evidence
