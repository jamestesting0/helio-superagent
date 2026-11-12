# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""CLI boundary for helio pr wait/phase; registered by helio-plan.py."""
from __future__ import annotations

import argparse
from dataclasses import asdict, replace
import json
from pathlib import Path
import re
import runpy
import sqlite3
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_recovery_store import Store, Wait

HERE = Path(__file__).resolve().parent
C = runpy.run_path(str(HERE / "helio_pr_recovery.py"))
S, P = C["S"], C["P"]
Runner = Callable[[list[str]], str]


def register(prs: argparse._SubParsersAction) -> None:
    wait = prs.add_parser("wait", help="transfer external PR waiting to the controller")
    wait.add_argument("--issue", type=int, required=True)
    wait.add_argument("--generation", type=int, required=True)
    wait.add_argument("--verification", required=True)
    phases = prs.add_parser("phase").add_subparsers(dest="phase_action", required=True)
    for name in ("start", "check", "show", "ack"):
        phase = phases.add_parser(name)
        phase.add_argument("--issue", type=int, required=True)
        if name in ("start", "check"):
            phase.add_argument("--generation", type=int, required=True)
        if name == "ack":
            phase.add_argument("--event", required=True)
    decide = phases.add_parser("decide", help="apply the owner's answer to a custody question, then close it")
    decide.add_argument("--issue", type=int, required=True)
    decide.add_argument("--question", help="the answered custody question")
    decide.add_argument("--option", help="the chosen option; required for a typed reply or a later message")
    decide.add_argument("--message", help="a later owner message that answers it (needs --channel and --option)")
    decide.add_argument("--channel")
    decide.add_argument("--title", help="title of the issue a follow-up or related option creates")
    decide.add_argument("--body-file", type=Path, help="requirements of the issue a follow-up or related option creates")
    decide.add_argument("--restored-body-file", type=Path, help="this issue's requirements without the moved ones")
    decide.add_argument("--labels", nargs="+")
    authorize = phases.add_parser("authorize")
    authorize.add_argument("--lane", required=True)
    authorize.add_argument("--effect", choices=("wake", "complete"), required=True)
    authorize.add_argument("--lane-revision", type=int, required=True)


def ready(store: Store, wait: Wait, run: Runner) -> bool:
    pull = C["exact_pull"](store, wait, run)
    merged = pull["state"] == "MERGED"
    P["access"](store, wait, run, merged=merged)
    if merged:
        return True
    if pull["state"] != "OPEN" or pull["headRefOid"] != wait.data["head"]:
        return False
    prefix, _ = C["READINESS"]["inspect"](store.repo, {
        **pull, "baseRefOid": C["READINESS"]["current_main"](store.repo, run)}, run)
    checks = C["CI"]["observe"](store.repo, wait.issue, pull["headRefOid"], pull.get("statusCheckRollup") or [], run)
    return prefix == "FOLLOWUP_PR_READY" and all(item.kind == "pass" for item in checks)


def authorize(args: argparse.Namespace, store: Store, run: Runner) -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,60}", args.lane) or ".." in args.lane:
        raise S["Refused"]("invalid lane identity")
    paths = [store.state / "lanes" / f"{args.lane}.json", store.state / "lanes/archive" / f"{args.lane}.json"]
    path = next((candidate for candidate in paths if candidate.is_file()), None)
    if path is None:
        raise S["Refused"]("lane record missing")
    current = json.loads(path.read_text())
    issue = re.fullmatch(r"issue-(\d+)", current.get("job") or "")
    wait = S["load"](store, int(issue[1])) if issue else None
    marked = (current.get("phase") or {}).get("owner") == "helio-pr"
    if not marked and wait is None:
        return "PHASE_LEGACY"  # No managed protocol; existing authorization remains in force.
    if not marked or wait is None:
        raise S["Refused"]("managed lane and controller marker disagree")
    if current.get("phase") != {"owner": "helio-pr", "version": 1, "generation": wait.generation}:
        raise S["Refused"]("phase generation changed")
    P["lane"](store, wait)
    if current.get("revision", 0) != args.lane_revision or current.get("status") == "paused":
        raise S["Refused"]("lane changed or is explicitly paused")
    intent = wait.data["intent"]
    if intent is None or intent["kind"] != args.effect or intent["generation"] != wait.generation:
        raise S["Refused"]("no matching controller effect intent")
    match args.effect:
        case "wake":
            C["wake_ready"](store, wait, run)
            P["access"](store, wait, run)
        case "complete":
            if current.get("status") != "verified-done" or not ready(store, wait, run):
                raise S["Refused"]("completion is not reserved with live canonical readiness")
        case _:
            raise S["Refused"]("unknown phase effect")
    return f"PHASE_AUTHORIZED issue={wait.issue} generation={wait.generation} effect={args.effect}"


def execute(args: argparse.Namespace, store: Store, run: Runner) -> int:
    try:
        if getattr(args, "generation", 1) < 1:
            raise S["Refused"]("generation must be positive")
        if args.pr_command == "phase" and args.phase_action == "authorize":
            print(authorize(args, store, run))
            return 0
        wait = S["load"](store, args.issue)
        if wait is None:
            raise S["Refused"]("issue has no managed worker phase")
        if getattr(args, "generation", wait.generation) != wait.generation:
            raise S["Refused"]("requested generation is not the active phase")
        if args.pr_command == "wait":
            wait = P["handoff"](store, wait, args.verification, run)
            print(f"PR_CUSTODY_ACK issue={wait.issue} generation={wait.generation} receipt={wait.data['receipt']}")
            return 0
        match args.phase_action:
            case "show":
                print(json.dumps(asdict(wait), indent=2))
            case "start":
                wait = P["start"](store, wait, run)
                print(f"PHASE_STARTED issue={wait.issue} generation={wait.generation} session={wait.data['started_session']}")
            case "check":
                if wait.data.get("blocked"):
                    print(f"PHASE_BLOCKED issue={wait.issue} generation={wait.generation} "
                          f"stage={wait.data['blocked']['stage']} reason={json.dumps(wait.data['blocked']['reason'])}")
                elif wait.data["acknowledgment"] == wait.generation and wait.data["receipt"]:
                    print(f"PHASE_HANDED_OFF issue={wait.issue} generation={wait.generation} receipt={wait.data['receipt']}")
                elif wait.data["pr"] and ready(store, wait, run):
                    print(f"PHASE_READY issue={wait.issue} generation={wait.generation}")
                else:
                    print(f"PHASE_UNRESOLVED issue={wait.issue} generation={wait.generation}")
                    return 2
            case "ack":
                if not any(item["id"] == args.event for item in wait.data["notices"]):
                    raise S["Refused"]("custody event is unknown")
                notices = [{**item, "acknowledged": True} if item["id"] == args.event else item
                           for item in wait.data["notices"]]
                S["save"](store, replace(wait, data={**wait.data, "notices": notices}))
                print(f"PR_CUSTODY_EVENT_ACK issue={wait.issue} event={args.event}")
            case _:
                raise S["Refused"]("unknown phase command")
        return 0
    except (RuntimeError, ValueError, OSError, KeyError, sqlite3.Error) as error:
        print(f"PR_PHASE_REFUSED {C['SYNC']['safe_detail'](str(error))}")
        return 2
