# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""One controller owns managed PR waiting; run by helio followups check/watch."""
from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import runpy
import time
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_recovery_store import Store, Wait
    from helio_pr_readiness import DetailedPull

HERE = Path(__file__).resolve().parent
S = runpy.run_path(str(HERE / "helio_pr_recovery_store.py"))
P = runpy.run_path(str(HERE / "helio_pr_phase.py"))
CI = runpy.run_path(str(HERE / "helio_pr_recovery_ci.py"))
A = runpy.run_path(str(HERE / "helio_pr_recovery_actions.py"))
READINESS = runpy.run_path(str(HERE / "helio_pr_readiness.py"))
LINK = runpy.run_path(str(HERE / "helio_issue_link.py"))
SYNC = runpy.run_path(str(HERE / "helio_issue_sync.py"))
Runner = Callable[[list[str]], str]
FIELDS = READINESS["FIELDS"] + ",body"


def admitted(home: Path | None = None) -> bool:
    path = (home or Path.home()) / ".dori/elobot/policy/lane-settings.json"
    if not path.is_file():
        return False
    return json.loads(path.read_text()).get("prCustody") is True


def exact_pull(store: Store, wait: Wait, run: Runner) -> DetailedPull:
    pull = json.loads(run(["gh", "pr", "view", wait.data["pr"], "--repo", store.repo, "--json", FIELDS]))
    if (pull.get("url"), pull.get("headRefName"), pull.get("baseRefName"), pull.get("isCrossRepository")) != (
            wait.data["pr"], wait.data["branch"], "main", False):
        raise S["Refused"]("canonical PR identity changed; reconcile its authorized publication")
    marker = LINK["parse"](pull.get("body") or "")
    if marker is None or marker.issue != wait.issue or wait.issue not in {
            item["number"] for item in pull.get("closingIssuesReferences", [])}:
        raise S["Refused"]("canonical PR relationship changed")
    candidates = json.loads(run(["gh", "pr", "list", "--repo", store.repo, "--state", "open", "--base", "main",
                                  "--limit", "10000", "--json",
                                  "number,url,headRefName,isCrossRepository,closingIssuesReferences"]))
    if any(item["url"] != wait.data["pr"] for item in READINESS["open_for_issue"](candidates, wait.issue)):
        raise S["Refused"]("another canonical PR implements this issue; publication identity needs review")
    return pull


def wake_ready(store: Store, wait: Wait, run: Runner) -> None:
    if wait.data["pr"] is None:
        return  # Initial implementation has no publication to reconcile yet.
    pull = exact_pull(store, wait, run)
    if pull["state"] != "OPEN" or pull["headRefOid"] != wait.data["head"]:
        raise S["Refused"]("canonical PR changed or is no longer open; repair wake refused")


def actionable(store: Store, wait: Wait, run: Runner, key: str, detail: str, now: float) -> Wait:
    if wait.data["last_action"] == key:
        return S["save"](store, S["notice"](wait, "decision",
            "The worker returned without changing this failed observation; diagnosis is needed before another phase", now))
    if wait.data["pending"] != key:
        wait = S["save"](store, S["notice"](replace(wait, data={**wait.data, "pending": key}), "repair", detail, now))
    return A["dispatch"](store, wait, run, now)


def tick(store: Store, wait: Wait, run: Runner, now: float) -> Wait:
    if wait.data["terminal"]:
        return wait
    current = P["lane"](store, wait)
    if (current.get("receipt") or {}).get("abandoned"):
        wait = replace(wait, data={**wait.data, "terminal": True})
        return S["save"](store, S["notice"](wait, "decision", "Owner abandoned this lane; automatic effects stopped", now))
    if current.get("status") == "paused":
        return S["save"](store, S["notice"](wait, "held", "Owner paused this lane; no automatic effects", now))
    waking = wait.data["intent"] is not None and wait.data["intent"]["kind"] == "wake"
    if wait.data["acknowledgment"] == wait.generation:
        A["release"](store, wait, run)  # Resource release does not depend on GitHub availability.
    if wait.data["pr"] is None:
        if waking:
            P["access"](store, wait, run)
            return A["dispatch"](store, wait, run, now)
        return wait
    if wait.data["intent"] is None and wait.data["acknowledgment"] != wait.generation:
        return wait  # The active worker still owns its implementation phase.
    pull = exact_pull(store, wait, run)
    state = pull["state"]
    if state == "CLOSED":
        return S["save"](store, S["notice"](wait, "decision",
            "Canonical PR closed without merge; no automatic rerun, reopening or replacement", now))
    P["access"](store, wait, run, merged=state == "MERGED")
    if state == "MERGED":
        wait = S["save"](store, S["notice"](wait, "ready", "Canonical PR merged; no deployment implied", now))
        finished = A["complete"](store, wait, run, now)
        if finished.data["status"] == "settled":
            return S["save"](store, replace(finished, data={**finished.data, "terminal": True}))
        return finished  # A crash before the actual close must remain reconcilable.
    if state != "OPEN":
        return S["save"](store, S["notice"](wait, "unknown", "Canonical PR state is unknown", now))
    if pull["headRefOid"] != wait.data["head"]:
        return S["save"](store, S["notice"](wait, "decision",
            "PR head changed; reconcile submit-owned verification before re-handoff", now))
    if waking:
        return A["dispatch"](store, wait, run, now)
    prefix, readiness = READINESS["inspect"](store.repo, {
        **pull, "baseRefOid": READINESS["current_main"](store.repo, run)}, run)
    observations = CI["observe"](store.repo, wait.issue, pull["headRefOid"], pull.get("statusCheckRollup") or [], run)
    incidents = dict(wait.data["incidents"])
    changed = False
    for observation in observations:
        incident = incidents.get(observation.incident)
        if (incident and not incident["resolved"] and observation.setup_passed and
                observation.finished_at is not None and observation.finished_at > incident["first_at"]):
            incidents[observation.incident] = {**incident, "resolved": True, "resolved_at": observation.finished_at}
            changed = True
    if changed:
        wait = S["save"](store, replace(wait, data={**wait.data, "incidents": incidents}))
    failures = [item for item in observations if item.kind == "repair"]
    infrastructure = [item for item in observations if item.kind == "infra"]
    unknown = [item for item in observations if item.kind == "unknown"]
    pending = any(item.kind == "pending" for item in observations)
    main_repair = [item for item in readiness["repair"] if item.startswith("main advanced;")]
    if pull.get("mergeable") == "CONFLICTING" or pull.get("mergeStateStatus") == "DIRTY":
        main_repair.append("canonical PR has merge conflicts")
    if failures or (main_repair and not infrastructure and not pending):
        key = hashlib.sha256(json.dumps([wait.data["head"], main_repair,
                                        sorted(item.fingerprint for item in failures)]).encode()).hexdigest()
        detail = "; ".join([*main_repair, *[
            f"{item.name}: assertion failure, run={item.run} job={item.job} attempt={item.attempt}" for item in failures]])
        return actionable(store, wait, run, key, detail, now)
    if unknown:
        detail = "CI failure needs diagnosis: " + ", ".join(item.name for item in unknown)
        return S["save"](store, S["notice"](wait, "diagnosis", detail, now))
    if infrastructure:
        A["release"](store, wait, run)
        details = []
        for observation in infrastructure:
            before = sum(len(item["retries"]) for item in wait.data["incidents"].values())
            wait, detail = A["retry"](store, wait, observation, run, now, pending=pending)
            details.append(f"{observation.name}: {detail}")
            if sum(len(item["retries"]) for item in wait.data["incidents"].values()) > before:
                break  # At most one job/dependency rerun submission per pass.
        return S["save"](store, S["notice"](wait, "waiting", "; ".join(details), now))
    if pending or readiness["waiting"] or prefix != "FOLLOWUP_PR_READY":
        A["release"](store, wait, run)
        detail = "; ".join(readiness["repair"] + readiness["waiting"]) or "Waiting for current canonical PR checks"
        return S["save"](store, S["notice"](wait, "waiting", detail, now))
    if current.get("closedAt") and wait.data["status"] == "settled":
        return wait
    wait = S["save"](store, S["notice"](wait, "ready", "Current canonical head/main and required checks pass", now))
    return A["complete"](store, wait, run, now)


def watch(store: Store, run: Runner, seen: set[str], now: float | None = None) -> list[str]:
    lines = []
    clock = time.time() if now is None else now
    for issue in S["issues"](store):
        wait = None
        try:
            wait = S["load"](store, issue)
            if wait is None:
                continue
            wait = tick(store, wait, run, clock)
        except (S["Changed"], A["S"]["Changed"], P["S"]["Changed"]):
            continue  # A different controller owns the committed effect; reconcile next pass.
        except (RuntimeError, ValueError, OSError, KeyError) as error:
            # Keep unknown identity and authority failures visible without repeating model work.
            detail = "Controller inspection unavailable: " + SYNC["safe_detail"](str(error))[:400]
            if wait is None:
                identity = f"damaged-custody:{issue}"
                if identity not in seen:
                    lines.append(f"FOLLOWUP_WARN issue={issue} {detail}")
                    seen.add(identity)
                continue
            current = S["load"](store, wait.issue)
            if current is None:
                raise
            if current.revision != wait.revision:
                continue
            status = {
                P["S"]["Refused"]: "held", P["AUTH"]["Refused"]: "held",
                A["P"]["S"]["Refused"]: "held", A["P"]["AUTH"]["Refused"]: "held",
                S["Refused"]: "decision",
            }.get(type(error), "unknown")
            wait = S["save"](store, S["notice"](current, status, detail, clock))
        lines.extend(S["notices"](wait, seen))
    return lines
