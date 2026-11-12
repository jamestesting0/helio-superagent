# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Journal controller effects before CI rerun, same-job wake and completion reservation."""
from __future__ import annotations

from dataclasses import replace
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_recovery_ci import Observation
    from helio_pr_recovery_store import Incident, Retry, Store, Wait

HERE = Path(__file__).resolve().parent
S = runpy.run_path(str(HERE / "helio_pr_recovery_store.py"))
CI = runpy.run_path(str(HERE / "helio_pr_recovery_ci.py"))
P = runpy.run_path(str(HERE / "helio_pr_phase.py"))
ESCALATION = runpy.run_path(str(HERE / "helio_pr_escalation.py"))
Runner = Callable[[list[str]], str]


def reclaim(store: Store, wait: Wait, run: Runner) -> tuple[bool, str]:
    """Release an idle worker's slot; the refusal says why (a busy session, an open question)."""
    current = P["lane"](store, wait)
    status = "closed" if current.get("closedAt") else current.get("status", "working")
    if status in ("hibernated", "closed"):
        return True, ""
    if status not in ("working", "not-done", "cleanup-pending"):
        return False, f"lane is {status}"
    try:
        run(["dori", "reclaim", wait.data["lane"]])
    except RuntimeError as error:
        if str(error).startswith(f"REFUSED {wait.data['lane']}:"):
            return False, str(error).strip()[:300]
        raise
    return P["lane"](store, wait).get("status") == "hibernated", ""


def release(store: Store, wait: Wait, run: Runner) -> bool:
    return reclaim(store, wait, run)[0]


def transfer(store: Store, qid: str, lane: str) -> None:
    """Move an open worker question to the custody lane so the idle worker's slot can be released while it waits."""
    result = subprocess.run([sys.executable, str(HERE / "helio-questions.py"), "transfer", qid, "--lane", lane],
                            capture_output=True, text=True, timeout=60, env={**os.environ, "DORI_STATE_DIR": str(store.state)})
    try:
        moved = json.loads(result.stdout).get("lane") == lane  # an undelivered question exits 1 yet is still moved
    except (ValueError, AttributeError):
        moved = False
    if not moved:
        raise RuntimeError("question transfer failed: " + (result.stderr or result.stdout).strip()[-300:])


def dispatch(store: Store, wait: Wait, run: Runner, now: float) -> Wait:
    current = P["lane"](store, wait)
    if (wait.data["intent"] and wait.data["intent"]["kind"] == "wake" and
            (current.get("phase") or {}).get("generation") == wait.generation and current.get("status", "working") == "working"):
        if current.get("pane") and current.get("launchState") == "started":
            return wait  # A delivered process still has to acknowledge its exact active goal.
        run(["dori", "recover-start", wait.data["lane"], "--expected-revision", str(current.get("revision", 0))])
        current = P["lane"](store, wait)
        if current.get("status") == "working":
            return wait  # Its recorded launch owner is still alive, not an acknowledged delivery.
    released, refusal = reclaim(store, wait, run)
    if refusal != (wait.data.get("release_refusal") or ""):
        wait = S["save"](store, replace(wait, data={**wait.data, "release_refusal": refusal}))
    if not released:
        return wait
    current = P["lane"](store, wait)
    if current.get("status") == "paused":
        return wait
    if wait.data["intent"] is None:
        observation = wait.data["pending"]
        if observation is None:
            return wait
        intent = {"kind": "wake", "observation": observation, "generation": wait.generation + 1}
        if wait.data.get("expected_head"):
            intent["expected_head"] = wait.data["expected_head"]
        wait = S["save"](store, replace(wait, generation=wait.generation + 1, data={
            **wait.data, "status": "repair", "acknowledgment": None, "started_session": None, "intent": intent,
        }))
    intent = wait.data["intent"]
    if intent is None or intent["kind"] != "wake":
        return wait
    current = P["lane"](store, wait)
    if current.get("status") not in ("closed", "hibernated"):
        return wait
    queue_path = store.state / "launch-queue.json"
    queue = json.loads(queue_path.read_text()) if queue_path.is_file() else []
    descriptor = {"owner": "helio-pr", "version": 1, "generation": wait.generation}
    queued = next((item for item in queue if item["key"] == wait.data["lane"]), None)
    if queued is not None:
        if queued.get("phase") != descriptor:
            raise S["Refused"]("queued phase does not match the pending repair intent")
        return wait
    failures = list(wait.data.get("startup_failures") or [])
    if current.get("launchState") == "failed" and current.get("revision") != wait.data.get("startup_failed_revision"):
        wait = startup_failed(store, wait, str(current.get("launchError") or "no detail"), current.get("revision"), now)
        failures = wait.data["startup_failures"]
    if failures and len(failures) >= 3:
        return ESCALATION["escalate"](store, wait, "startup-failed",
            f"The worker failed to start three times: {str(current.get('launchError') or 'no detail')[:300]}", now)
    if failures and now - failures[-1] < 5 * 60:
        return wait  # Retries are at least five minutes apart.
    lanes = runpy.run_path(str(HERE / "helio_task_lane.py"))
    task = lanes["Task"](store.repo, wait.issue, wait.data["title"], wait.data["route"],
                         "Continue the original recorded task; authorization hooks and submit gates remain binding.",
                         wait.data["source"], notes=f"Repair observation: {intent['observation']}\n" +
                         "\n".join(item["detail"] for item in wait.data["notices"] if item["status"] == "repair") +
                         f"\nInspect current evidence: helio pr check --issue {wait.issue}")
    brief = store.state / "helio-briefs" / f"{wait.data['lane']}-phase-{wait.generation}.md"
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(lanes["render"](task, Path(current["cwd"]), wait.data["branch"], phase=wait,
                                      profile=current.get("profile") or "thorough"))
    P["access"](store, wait, run)
    # An interrupted start may have retained resources, so a raised error is never retried here; only Dori's recorded
    # failed launch counts toward the bounded retries above.
    run(["dori", "resume", wait.data["lane"], "--brief", str(brief), "--phase", json.dumps(descriptor)])
    return wait  # Delivery is acknowledged only by phase start, not by enqueue or process launch.


def startup_failed(store: Store, wait: Wait, detail: str, revision: object, now: float) -> Wait:
    failures = [*(wait.data.get("startup_failures") or []), now]
    return S["save"](store, S["notice"](replace(wait, data={**wait.data, "startup_failures": failures,
                                                           "startup_failed_revision": revision}), "diagnosis",
        f"Worker startup failed ({len(failures)} of 3): {detail[:300]}", now))


def complete(store: Store, wait: Wait, run: Runner, now: float) -> Wait:
    current = P["lane"](store, wait)
    status = "closed" if current.get("closedAt") else current.get("status", "working")
    if status == "closed":
        return S["save"](store, S["notice"](wait, "settled", "Canonical PR readiness verified; lane closed", now))
    if status in ("done-claimed", "verified-done", "cleanup-pending"):
        if status == "done-claimed":
            run(["dori", "claim-ack", wait.data["lane"]])
        return wait
    if not release(store, wait, run):
        return wait
    current = P["lane"](store, wait)
    wait = S["save"](store, replace(wait, data={
        **wait.data, "intent": {"kind": "complete", "observation": wait.data["head"] or "merged",
                              "generation": wait.generation},
    }))
    run(["dori", "claim-done", wait.data["lane"], "--expected-revision", str(current.get("revision", 0)),
         "--phase", json.dumps({"owner": "helio-pr", "version": 1, "generation": wait.generation}),
         "--evidence", f"Controller read back canonical readiness for {wait.data['pr']} head {wait.data['head']}"])
    run(["dori", "claim-ack", wait.data["lane"]])
    return wait


def retry(store: Store, wait: Wait, observation: Observation, run: Runner, now: float, *, pending: bool) -> tuple[Wait, str]:
    identity = observation.incident
    if identity is None or observation.run is None or observation.job is None or observation.attempt is None:
        return wait, "CI target identity unavailable; automatic recovery is held"
    if observation.finished_at is None:
        return wait, "CI job completion time is unavailable; no automatic rerun scheduled"
    incident: Incident = wait.data["incidents"].get(identity) or {
        "first_at": observation.finished_at, "retries": [], "resolved": False, "resolved_at": None}
    if incident["resolved"]:
        if incident["resolved_at"] is None or observation.finished_at <= incident["resolved_at"]:
            return wait, "Old infrastructure observation predates the established recovery"
        incident = {"first_at": observation.finished_at, "retries": [], "resolved": False, "resolved_at": None}
    retries = [dict(item) for item in incident["retries"]]
    if retries and retries[-1]["status"] in ("reserved", "accepted"):
        previous = retries[-1]
        metadata = json.loads(run(["gh", "api", f"repos/{store.repo}/actions/runs/{previous['run']}"]))
        if metadata["run_attempt"] > previous["attempt"]:
            previous["status"] = "accepted"
            if (metadata["status"] == "completed" and observation.attempt == metadata["run_attempt"]
                    and observation.finished_at is not None):
                previous["status"] = "finished"
                previous["finished_at"] = observation.finished_at
    incident = {**incident, "retries": retries}
    wait = S["save"](store, replace(wait, data={
        **wait.data, "incidents": {**wait.data["incidents"], identity: incident},
    }))
    other_inflight = any(item["status"] in ("reserved", "accepted") for key, entry in wait.data["incidents"].items()
                         if key != identity and not entry["resolved"] for item in entry["retries"])
    slot = CI["due"](incident, now, pending=pending or other_inflight)
    if slot is None:
        if len(retries) >= 3 and all(item["status"] == "finished" for item in retries):
            return wait, "CI infrastructure retry budget exhausted; operational recovery or an authorized causal fix is needed"
        if retries and retries[-1]["status"] == "reserved":
            return wait, "CI rerun acceptance uncertain; reconciling its reserved attempt"
        if retries and retries[-1]["status"] == "rejected":
            return wait, "CI rerun rejected; inspect permissions/target"
        return wait, "CI infrastructure unavailable; controller owns the next scheduled probe"
    P["access"](store, wait, run)
    attempt: Retry = {"slot": slot, "run": observation.run, "job": observation.job,
                      "attempt": observation.attempt, "status": "reserved", "requested_at": now, "finished_at": None}
    incident = {**incident, "retries": [*retries, attempt]}
    wait = S["save"](store, replace(wait, data={
        **wait.data, "incidents": {**wait.data["incidents"], identity: incident},
    }))
    try:
        # GitHub also reruns dependent jobs. The controller has already ruled
        # out every actionable/unclassified failure before choosing this path.
        run(["gh", "api", "--method", "POST", f"repos/{store.repo}/actions/jobs/{observation.job}/rerun"])
    except RuntimeError as error:
        # Unknown acceptance stays reserved and is reconciled through the run attempt.
        rejected = any(f"HTTP {code}" in str(error) for code in (400, 401, 403, 404, 410, 422))
        if rejected:
            attempt = {**attempt, "status": "rejected"}
            incident = {**incident, "retries": [*retries, attempt]}
        wait = replace(wait, data={**wait.data, "incidents": {**wait.data["incidents"], identity: incident}})
        wait = S["save"](store, wait)
        return wait, ("CI rerun rejected; inspect permissions/target" if rejected
                      else "CI rerun acceptance uncertain; reconciling its reserved attempt")
    incident = {**incident, "retries": [*retries, {**attempt, "status": "accepted"}]}
    wait = S["save"](store, replace(wait, data={
        **wait.data, "incidents": {**wait.data["incidents"], identity: incident},
    }))
    return wait, f"CI infrastructure recovery attempt {len(retries) + 1} submitted"
