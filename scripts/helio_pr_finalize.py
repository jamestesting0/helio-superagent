"""Finish publication bookkeeping identically in the foreground and bot recovery."""
from __future__ import annotations

from pathlib import Path
import runpy
from typing import Callable

WORK = runpy.run_path(str(Path(__file__).with_name("helio-work.py")))


class Refused(ValueError):
    stage = "pr_finalize"

    def __init__(self, message: str, uncertain: bool = False) -> None:
        super().__init__(message)
        self.uncertain = uncertain


def account(repo: str, change: dict) -> None:
    proof = change["authority"]
    if not change.get("plan_body") and proof.get("kind") != "autofix":
        try:
            WORK["consume"](repo, change["issue"], proof["message"])
        except WORK["Refused"] as error:
            raise Refused(str(error)) from error


def finish(repo: str, command: Callable[..., str], change: dict, pull: dict,
           permitted: Callable[[], None]) -> None:
    account(repo, change)
    if not change.get("plan_body") or pull.get("state") != "OPEN":
        return
    plan = runpy.run_path(str(Path(__file__).with_name("helio-plan.py")))
    data = plan["parse"](change["plan_body"])
    data["status_note"] = f"implemented in {change['url']}"
    expected = plan["render"](change["issue"], data)
    github = plan["GitHub"](repo, run=command)
    with plan["PLAN_PUBLICATION"]["scope"](repo, change["issue"]):
        _, comment, _, current = github.plan_comment(change["issue"])
        if current == expected:
            return
        if current != change["plan_body"] or comment is None:
            raise Refused("The plan changed; the bot must refresh its current report without overwriting it.")
        github.save(change["issue"], comment, expected, permitted, expected_body=current)
        if github.plan_comment(change["issue"])[3] != expected:
            raise Refused("Plan progress read-back is pending; the bot will reconcile this publication.", True)
