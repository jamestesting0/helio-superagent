# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""One controller owns managed PR waiting; run by helio followups check/watch."""
from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import os
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
E = runpy.run_path(str(HERE / "helio_pr_escalation.py"))
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
    # A re-verify round is bound to the exact moved head it must reconcile; nothing else may be woken against.
    accepted = (wait.data["intent"] or {}).get("expected_head") or wait.data["head"]
    if pull["state"] != "OPEN" or pull["headRefOid"] != accepted:
        raise S["Refused"]("canonical PR changed or is no longer open; repair wake refused")


def actionable(store: Store, wait: Wait, run: Runner, key: str, detail: str, now: float) -> Wait:
    attempts = dict(wait.data.get("attempts") or {})
    if wait.data["last_action"] == key:
        attempts[key] = attempts.get(key, 1) + 1
        if attempts[key] > 2:
            wait = E["escalate"](store, replace(wait, data={**wait.data, "attempts": attempts}), "repair-exhausted",
                                 f"Two repair rounds did not change this observation: {detail[:400]}", now)
            return S["save"](store, replace(wait, data={**wait.data, "escalation": {**wait.data["escalation"], "observation": key}}))
        detail = (f"{detail}. Your previous attempt did not change this observation; diagnose the cause first and "
                  "try a different approach.")
    if wait.data["pending"] != key or attempts != (wait.data.get("attempts") or {}):
        wait = S["save"](store, S["notice"](replace(wait, data={**wait.data, "pending": key, "attempts": attempts,
                                                               "last_action": None}), "repair", detail, now))
    return A["dispatch"](store, wait, run, now)


def repair(before: Wait, after: Wait) -> tuple[Wait, E["Condition"]]:
    """A repair that could not start (the worker is still busy) is a bounded stop, not a silent retry."""
    if after.generation > before.generation or (after.data.get("escalation") or {}).get("question"):
        return after, None
    return after, ("stalled", "an approved repair is waiting for the worker to be released: "
                   + (after.data.get("release_refusal") or "dispatch did not start"))


def recorded_update(store: Store, issue: int, digest: str) -> dict | None:
    """The newest completed `helio issue update` whose requirements produce this digest, with its stored source."""
    with store.operations() as db:
        rows = db.execute("SELECT after_body,change FROM operations WHERE repo=? AND issue=? AND completed=1 "
                          "ORDER BY rowid DESC", (store.repo, issue)).fetchall()
    for after, change in rows:
        if P["requirements"]({"body": after}) == digest:
            return json.loads(change)
    return None


def requirements_changed(store: Store, wait: Wait, run: Runner, digest: str, now: float) -> tuple[Wait, E["Condition"]]:
    """R1: only an owner-sourced change after handoff reworks the PR automatically; it may add scope."""
    change = recorded_update(store, wait.issue, digest)
    source = (change or {}).get("source") or {}
    owner = os.environ.get("DORI_DISCORD_OWNER_ID", "")
    authorized = wait.data.get("scope_grant") == digest or bool(owner and source.get("author") == owner)
    note = ((change or {}).get("note") or "").strip()[:300]
    if not authorized and change is None:
        wait = S["save"](store, S["notice"](wait, "decision",
            f"Issue #{wait.issue} was edited outside Helio after handoff. Review it (helio issue show {wait.issue}) and "
            f"adopt it with helio issue update --issue {wait.issue} --adopt SHA --body-file F --note-file F "
            "--question QID (or --message M --channel C); an owner-sourced change starts a rework round", now))
        return wait, ("stalled", "issue requirements edited outside Helio after handoff")
    if not authorized:
        who = source.get("author") and f"<@{source['author']}>" or "an unverified source"
        return E["escalate"](store, wait, "scope-authority",
            f"The requirements changed after the PR was handed off, from {who}: {note or 'no note'}. "
            "Including them reworks this PR; otherwise they move to a related issue and this PR keeps the original "
            "requirements.", now), None
    reworked = list(wait.data.get("reworked") or [])
    if digest in reworked:
        return E["escalate"](store, wait, "repair-exhausted",
            "The worker returned from the requirements rework round without handing off the updated requirements.", now), None
    wait = S["save"](store, replace(wait, data={**wait.data, "rescope": digest, "reworked": [*reworked, digest]}))
    return repair(wait, actionable(store, wait, run, "scope:" + digest,
                      f"Requirements changed after handoff: {note or 'owner decision'}. Update this PR to the current "
                      "requirements, verify and submit again.", now))


def guarded_access(store: Store, wait: Wait, run: Runner, now: float, *, merged: bool = False) -> tuple[Wait, bool, E["Condition"]]:
    """R7: a closed issue is an owner decision; lost authority is a bounded stop; a requester hold is a legitimate wait."""
    try:
        P["access"](store, wait, run, merged=merged)
        return wait, True, None
    except P["IssueClosed"]:
        return E["escalate"](store, wait, "issue-closed",
            f"Issue #{wait.issue} was closed while its PR is open. Continuing means a linked follow-up issue; "
            "the closed issue stays as it is.", now), False, None
    except P["ScopeChanged"]:
        raise
    except (P["S"]["Refused"], P["AUTH"]["Refused"]) as error:
        if any(text in str(error) for text in ("requester holds or blocks this task", "Held by the requester")):
            return S["save"](store, S["notice"](wait, "held", f"Held at the requester's request: {error}", now)), False, None
        # Possibly transient (a failed read): it clears when access passes again, and reaches the owner at 90 minutes.
        wait = S["save"](store, S["notice"](wait, "held", f"Controller inspection unavailable: {error}", now))
        return wait, False, ("authority", f"The work's authority does not verify: {error}")


def worker_condition(store: Store, wait: Wait, run: Runner, current: dict, now: float) -> tuple[Wait, E["Condition"]]:
    if current.get("status", "working") != "working" or not current.get("pane") or not current.get("cwd"):
        return wait, ("stalled", f"the unfinished phase has no active worker (lane {current.get('status', 'working')})")
    try:
        checkpoint, _ = P["checkpoint"](current)
    except P["S"]["Refused"]:
        checkpoint = None
    wait, condition = E["worker"](store, wait, run, current["cwd"], checkpoint, now)
    if condition and now - wait.data["worker_progress"]["at"] >= E["OWNER_AFTER"]:
        # Before asking the owner, try the idle release; its refusal tells whether the session is still busy.
        released, refusal = A["reclaim"](store, wait, run)
        if refusal != (wait.data.get("release_refusal") or ""):
            wait = S["save"](store, replace(wait, data={**wait.data, "release_refusal": refusal}))
    return wait, condition


def step(store: Store, wait: Wait, run: Runner, now: float) -> tuple[Wait, E["Condition"]]:
    """One controller pass. Returns the record and its condition: None for progress or a legitimate wait."""
    if wait.data["terminal"]:
        return wait, None
    current = P["lane"](store, wait)
    if (current.get("receipt") or {}).get("abandoned"):
        wait = replace(wait, data={**wait.data, "terminal": True})
        return S["save"](store, S["notice"](wait, "decision", "Owner abandoned this lane; automatic effects stopped", now)), None
    if current.get("status") == "paused" and not (wait.data.get("blocked") or {}).get("kind"):
        return S["save"](store, S["notice"](wait, "held", "Owner paused this lane; no automatic effects", now)), None
    blocked = wait.data.get("blocked")
    if blocked:
        pending = wait.data.get("escalation") or {}
        if pending and not pending.get("question") and not blocked.get("parked"):
            # Recorded before its question was linked (an interrupted pass): ask, or link an existing answer, now.
            wait = E["escalate"](store, wait, pending["kind"], pending["detail"], now)
        wait = E["follow"](store, wait, now)
        blocked = wait.data.get("blocked") or {}
        released, refusal = A["reclaim"](store, wait, run)  # A blocked worker that finished its goal frees its slot.
        if (not released and "unanswered question" in refusal and blocked.get("question")
                and not blocked.get("transferred") and blocked["stage"] != "controller"):
            # The worker is idle and only its own open question pins the slot: move it to the custody lane.
            A["transfer"](store, blocked["question"], E["lane_key"](wait.issue))
            # From here the custody lifecycle owns it: one reminder, one re-ask, then parking; never a second question.
            wait = S["save"](store, replace(wait, data={**wait.data, "blocked": {**blocked, "transferred": E["lane_key"](wait.issue)},
                "escalation": {"kind": "worker-blocked", "at": now, "question": blocked["question"],
                               "options": list(E["OPTIONS"]["worker-blocked"]), "detail": f"The worker asked: {blocked['reason']}"}}))
            released, refusal = A["reclaim"](store, wait, run)
        if refusal != (wait.data.get("release_refusal") or ""):
            wait = S["save"](store, replace(wait, data={**wait.data, "release_refusal": refusal}))
        if blocked.get("parked") or (wait.data.get("escalation") or {}).get("question"):
            return wait, None
        kind = blocked.get("kind") if blocked["stage"] == "controller" else "worker-blocked"
        return wait, (kind or "stalled", f"Blocked: {blocked['reason']}")
    waking = wait.data["intent"] is not None and wait.data["intent"]["kind"] == "wake"
    if wait.data["acknowledgment"] == wait.generation:
        A["release"](store, wait, run)  # Resource release does not depend on GitHub availability.
    if wait.data["pr"] is None:
        if waking:
            wait, allowed, condition = guarded_access(store, wait, run, now)
            if not allowed:
                return wait, condition
            wait = A["dispatch"](store, wait, run, now)
            return wait, ("stalled", "the implementation worker has not started")
        return worker_condition(store, wait, run, current, now)
    if wait.data["intent"] is None and wait.data["acknowledgment"] != wait.generation:
        return worker_condition(store, wait, run, current, now)  # The active worker still owns its phase.
    pull = exact_pull(store, wait, run)
    state = pull["state"]
    if state == "CLOSED":
        return E["escalate"](store, wait, "pr-closed",
            f"PR {wait.data['pr']} was closed without merge. Nothing is reopened without your answer.", now), None
    if state == "MERGED":
        wait, allowed, condition = guarded_access(store, wait, run, now, merged=True)
        if not allowed:
            return wait, condition
        issue = json.loads(run(["gh", "issue", "view", str(wait.issue), "--repo", store.repo, "--json", "body"]))
        # A rework still pending at merge is unfinished work too: the merged PR verified only the bound requirements.
        if (P["scope_bound"](wait) or wait.data.get("rescope")) and P["requirements"](issue) != wait.data["scope"]:
            source = (recorded_update(store, wait.issue, P["requirements"](issue)) or {}).get("source") or {}
            if source.get("kind") == "message":
                wait = S["save"](store, S["notice"](wait, "decision", "Requirements changed after merge; create the linked "
                    f"follow-up from message {source['id']} in channel {source['channel']} (issue-truth-workflow.md)", now))
            elif (not (wait.data.get("escalation") or {}).get("question")
                  and wait.data.get("followup_handled") != P["requirements"](issue)):
                wait = E["escalate"](store, wait, "follow-up", "Requirements changed after merge; the new requirements "
                                     "need a linked follow-up issue. The merged work stays as it is.", now)
        wait = S["save"](store, S["notice"](wait, "ready", "Canonical PR merged; no deployment implied", now))
        finished = A["complete"](store, wait, run, now)
        if finished.data["status"] == "settled":
            if (finished.data.get("escalation") or {}).get("question"):
                return finished, None  # The lane is done; the owner's follow-up decision keeps its reminder/re-ask/park lifecycle.
            return S["save"](store, replace(finished, data={**finished.data, "terminal": True})), None
        return finished, ("stalled", "the merged PR's lane has not closed")  # A crash before close stays reconcilable.
    if state != "OPEN":
        return S["save"](store, S["notice"](wait, "unknown", "Canonical PR state is unknown", now)), ("stalled", "PR state is unknown")
    expected = (wait.data["intent"] or {}).get("expected_head")
    if pull["headRefOid"] != wait.data["head"] and pull["headRefOid"] != expected:
        moved = pull["headRefOid"]
        if "head:" + moved in (wait.data.get("reworked") or []):
            return E["escalate"](store, wait, "repair-exhausted",
                f"The PR branch moved to {moved[:12]} and the re-verify round did not hand it off.", now), None
        wait = S["save"](store, replace(wait, data={**wait.data, "expected_head": moved,
                                                   "reworked": [*(wait.data.get("reworked") or []), "head:" + moved]}))
        return repair(wait, actionable(store, wait, run, "head:" + moved,
                          f"The PR branch moved from {str(wait.data['head'])[:12]} to {moved[:12]} outside this phase. "
                          "Review those commits, merge current main, verify and submit again.", now))
    issue = json.loads(run(["gh", "issue", "view", str(wait.issue), "--repo", store.repo, "--json", "state,body"]))
    if issue.get("state") == "OPEN" and P["scope_bound"](wait) and P["requirements"](issue) != wait.data["scope"]:
        return requirements_changed(store, wait, run, P["requirements"](issue), now)
    wait, allowed, condition = guarded_access(store, wait, run, now)
    if not allowed:
        return wait, condition
    if waking:
        return A["dispatch"](store, wait, run, now), ("stalled", "the repair worker has not started")
    if wait.data.get("rescope"):
        # The new requirements are not verified yet: never judge readiness on the old verification; keep redispatching.
        return repair(wait, A["dispatch"](store, wait, run, now))
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
    pending = any(item.kind == "pending" for item in observations)
    since = wait.data.get("ci_pending_since")
    since = (since or now) if pending else None
    if changed or since != wait.data.get("ci_pending_since"):
        wait = S["save"](store, replace(wait, data={**wait.data, "incidents": incidents, "ci_pending_since": since}))
    failures = [item for item in observations if item.kind == "repair"]
    infrastructure = [item for item in observations if item.kind == "infra"]
    unknown = [item for item in observations if item.kind == "unknown"]
    main_repair = [item for item in readiness["repair"] if item.startswith("main advanced;")]
    if pull.get("mergeable") == "CONFLICTING" or pull.get("mergeStateStatus") == "DIRTY":
        main_repair.append("canonical PR has merge conflicts")
    if failures or (main_repair and not infrastructure and not pending):
        key = hashlib.sha256(json.dumps([wait.data["head"], main_repair,
                                        sorted(item.fingerprint for item in failures)]).encode()).hexdigest()
        detail = "; ".join([*main_repair, *[
            f"{item.name}: assertion failure, run={item.run} job={item.job} attempt={item.attempt}" for item in failures]])
        return repair(wait, actionable(store, wait, run, key, detail, now))
    if unknown:  # R3: a diagnosis round instead of a silent hold.
        key = hashlib.sha256(json.dumps([wait.data["head"], sorted(item.fingerprint for item in unknown)]).encode()).hexdigest()
        names = ", ".join(item.name for item in unknown)
        return repair(wait, actionable(store, wait, run, key,
                          f"CI failure needs diagnosis: {names}. Read the failed job logs (gh run view RUN --log-failed), "
                          "find the cause, fix it or record a blocker with the evidence.", now))
    if infrastructure:
        A["release"](store, wait, run)
        details = []
        for observation in infrastructure:
            before = sum(len(item["retries"]) for item in wait.data["incidents"].values())
            wait, detail = A["retry"](store, wait, observation, run, now, pending=pending)
            details.append(f"{observation.name}: {detail}")
            if sum(len(item["retries"]) for item in wait.data["incidents"].values()) > before:
                break  # At most one job/dependency rerun submission per pass.
        text = "; ".join(details)
        wait = S["save"](store, S["notice"](wait, "waiting", text, now))
        if "budget exhausted" in text:
            return wait, ("ci-budget", text)
        if "identity unavailable" in text or "completion time is unavailable" in text:
            return wait, ("ci-identity", text)
        if "rerun rejected" in text or "acceptance uncertain" in text:
            return wait, ("ci-rejected", text)
        return wait, None  # The controller owns the next scheduled probe.
    if pending or readiness["waiting"] or prefix != "FOLLOWUP_PR_READY":
        A["release"](store, wait, run)
        detail = "; ".join(readiness["repair"] + readiness["waiting"]) or "Waiting for current canonical PR checks"
        wait = S["save"](store, S["notice"](wait, "waiting", detail, now))
        if pending and since is not None and now - since < E["CI_PENDING_BOUND"]:
            return wait, None
        computing = pull.get("mergeable") == "UNKNOWN" and now - wait.data.get("progress_at", now) < 30 * 60
        return wait, None if computing and not pending and not readiness["waiting"] else ("stalled", detail)
    if current.get("closedAt") and wait.data["status"] == "settled":
        return wait, None
    wait = S["save"](store, S["notice"](wait, "ready", "Current canonical head/main and required checks pass", now))
    wait = A["complete"](store, wait, run, now)
    return wait, None if wait.data["status"] == "settled" else ("stalled", "ready, but the worker lane has not closed")


def tick(store: Store, wait: Wait, run: Runner, now: float) -> Wait:
    wait, condition = step(store, wait, run, now)
    busy = "is working" in (wait.data.get("release_refusal") or "")
    return E["clock"](store, wait, condition, now, busy=busy)


def damaged(store: Store, issue: int, detail: str, now: float) -> list[str]:
    """An undecodable custody record follows the same ladder: lead at 30 minutes, owner at 90."""
    with store.operations() as db:
        db.execute("CREATE TABLE IF NOT EXISTS custody_damage (repo TEXT, issue INTEGER, since REAL, lead_at REAL, "
                   "owner_at REAL, PRIMARY KEY(repo,issue))")
        db.execute("INSERT OR IGNORE INTO custody_damage(repo,issue,since) VALUES (?,?,?)", (store.repo, issue, now))
        since, lead_at, owner_at = db.execute("SELECT since,lead_at,owner_at FROM custody_damage WHERE repo=? AND issue=?",
                                              (store.repo, issue)).fetchone()
        lines = []
        if now - since >= E["LEAD_AFTER"] and lead_at is None:
            db.execute("UPDATE custody_damage SET lead_at=? WHERE repo=? AND issue=?", (now, store.repo, issue))
            lines.append(f"FOLLOWUP_WARN issue={issue} custody record unreadable for {int((now - since) // 60)} min: {detail}")
        if now - since >= E["OWNER_AFTER"] and owner_at is None:
            db.execute("UPDATE custody_damage SET owner_at=? WHERE repo=? AND issue=?", (now, store.repo, issue))
            qid, _ = E["ask"](store, issue, f"Helio cannot read the custody record for issue #{issue}: {detail[:500]}. "
                              f"Inspect it with helio pr phase show --issue {issue}; reply with what to do.", [])
            lines.append(f"FOLLOWUP_WARN issue={issue} asked owner {qid} about its unreadable custody record")
    return lines


def watch(store: Store, run: Runner, seen: set[str], now: float | None = None) -> list[str]:
    lines = []
    clock = time.time() if now is None else now
    for issue in S["issues"](store):
        wait = None
        try:
            wait = S["load"](store, issue)
            if wait is None:
                continue
            with store.operations() as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='custody_damage'").fetchone():
                    db.execute("DELETE FROM custody_damage WHERE repo=? AND issue=?", (store.repo, issue))
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
                lines.extend(damaged(store, issue, detail, clock))
                continue
            current = S["load"](store, wait.issue)
            if current is None:
                raise
            if current.revision != wait.revision:
                continue
            status = {
                P["S"]["Refused"]: "held", P["AUTH"]["Refused"]: "held",
                A["P"]["S"]["Refused"]: "held", A["P"]["AUTH"]["Refused"]: "held",
                P["ScopeChanged"]: "held", P["IssueClosed"]: "held",
                S["Refused"]: "decision",
            }.get(type(error), "unknown")
            wait = S["save"](store, S["notice"](current, status, detail, clock))
            wait = E["clock"](store, wait, ("stalled", detail), clock)
        lines.extend(S["notices"](wait, seen))
    return lines
