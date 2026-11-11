# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Classify exact required CI jobs and select bounded recovery slots; no reruns here."""
from __future__ import annotations

from dataclasses import dataclass
import datetime
import hashlib
import json
import re
from typing import Callable, Literal, TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from helio_pr_recovery_store import Incident, Retry

Runner = Callable[[list[str]], str]
Kind = Literal["pass", "pending", "infra", "repair", "unknown"]
FONT = "Install CJK font for bracket rendering"


class Check(TypedDict, total=False):
    name: str
    context: str
    status: str
    conclusion: str | None
    state: str
    detailsUrl: str
    targetUrl: str


@dataclass(frozen=True, slots=True)
class Observation:
    kind: Kind
    name: str
    fingerprint: str
    incident: str | None = None
    run: int | None = None
    job: int | None = None
    attempt: int | None = None
    finished_at: float | None = None
    setup_passed: bool = False


def stamp(value: str | None) -> float | None:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None


def observe(repo: str, issue: int, head: str, checks: list[Check], run: Runner) -> list[Observation]:
    observations = []
    for check in checks:
        name = check.get("name") or check.get("context") or "unknown check"
        conclusion = (check.get("conclusion") or check.get("state") or "").upper()
        pending = check.get("status") not in (None, "COMPLETED") or conclusion in ("", "PENDING", "EXPECTED")
        kind: Kind = "pending" if pending else "pass" if conclusion in ("SUCCESS", "SKIPPED", "NEUTRAL") else "unknown"
        target = check.get("detailsUrl") or check.get("targetUrl") or ""
        match = re.fullmatch(rf"https://github\.com/{re.escape(repo)}/actions/runs/(\d+)/job/(\d+)", target)
        if not match or pending:
            observations.append(Observation(kind, name, f"{kind}:{name}:{conclusion}"))
            continue
        run_id, job_id = map(int, match.groups())
        metadata = json.loads(run(["gh", "api", f"repos/{repo}/actions/runs/{run_id}"]))
        job = json.loads(run(["gh", "api", f"repos/{repo}/actions/jobs/{job_id}"]))
        if metadata.get("head_sha") != head or job.get("head_sha") != head:
            observations.append(Observation("unknown", name, f"unbound:{name}"))
            continue
        attempt = metadata["run_attempt"]
        if metadata["status"] != "completed":
            observations.append(Observation("pending", name, f"pending:{name}", run=run_id, attempt=attempt))
            continue
        if attempt != job.get("run_attempt"):
            latest = json.loads(run(["gh", "api", f"repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100"]))
            matches = [item for item in latest["jobs"] if item["name"] == job["name"] and item["head_sha"] == head]
            if len(matches) != 1:
                observations.append(Observation("unknown", name, f"ambiguous:{name}"))
                continue
            job = matches[0]
            job_id = job["id"]
        actual = (job.get("conclusion") or "").upper()
        kind = "pending" if job["status"] != "completed" else (
            "pass" if actual in ("SUCCESS", "SKIPPED", "NEUTRAL") else "unknown")
        if kind == "pending":
            observations.append(Observation("pending", name, f"pending:{name}", run=run_id, attempt=attempt))
            continue
        font = next((step for step in job["steps"] if step["name"] == FONT), None)
        incident = hashlib.sha256(json.dumps([repo, issue, metadata["workflow_id"], job["name"], FONT, "apt-dns-fetch"]).encode()).hexdigest()
        setup_passed = bool(font and font.get("conclusion") == "success")
        if kind != "pass":
            log = run(["gh", "run", "view", str(run_id), "--job", str(job_id), "--log-failed", "--repo", repo])
            tests = [step for step in job["steps"] if step["name"] in (
                "Run tests", "Run unit tests", "Run integration tests", "Unit tests", "Integration tests")]
            not_run = bool(tests) and all(step.get("conclusion") == "skipped" for step in tests)
            if font and font.get("conclusion") == "failure" and not_run and "Temporary failure resolving" in log:
                kind = "infra"
            elif any(step.get("conclusion") == "failure" for step in tests) and re.search(
                    r"AssertionError|FAILED \(failures=[1-9]|=+ FAILURES =+", log):
                kind = "repair"
        # Attempt and runner IDs never turn an equivalent failure into a new incident.
        fingerprint = f"{kind}:{metadata['workflow_id']}:{job['name']}"
        observations.append(Observation(kind, name, fingerprint, incident, run_id, job_id, attempt,
                                        stamp(job.get("completed_at")), setup_passed))
    return observations


def due(incident: Incident, now: float, *, pending: bool) -> int | None:
    if pending or incident["resolved"]:
        return None
    retries = incident["retries"]
    if any(item["status"] != "finished" for item in retries) or len(retries) >= 3:
        return None
    slot = len(retries)
    deadline = incident["first_at"] + (0, 1800, 7200)[slot]
    if slot:
        finished = retries[-1]["finished_at"]
        if finished is None:
            return None
        deadline = max(deadline, finished + 1800)
    return slot if now >= deadline else None
