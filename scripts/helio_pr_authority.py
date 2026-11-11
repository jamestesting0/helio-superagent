"""Recheck a saved publication's existing task authority without another user decision."""
from __future__ import annotations

from contextlib import closing
import datetime
import fnmatch
import json
import os
from pathlib import Path
import runpy
import sqlite3
from typing import Callable

FORMAT = runpy.run_path(str(Path(__file__).with_name("helio_issue_format.py")))

class Refused(ValueError):
    """The original task authority or reviewed scope changed."""
    stage = "pr_review"
    uncertain = False


def reader(message: str, channel: str | None = None, fingerprint: str | None = None) -> dict:
    checker = runpy.run_path(str(Path(__file__).with_name("release-check.py")))
    try:
        return {**checker["load"](message, channel, fingerprint), "verify_source": checker["verify_source"],
                "Refused": checker["Refused"]}
    except checker["Refused"] as error:
        raise Refused(str(error)) from error


def legacy_record(proof: dict, database: str, query: str) -> str | None:
    path = Path(proof["state"]) / database
    if not path.exists():
        return None
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute(query, (proof["message"],)).fetchone()
            return row[0] if row else None
    except sqlite3.Error as error:
        raise Refused(f"Cannot inspect legacy plan source: {error}") from error


def verify(proof: dict, source_reader: Callable[..., dict] = reader) -> None:
    if proof.get("kind") == "autofix":
        if os.environ.get("HELIO_AUTOFIX", "on") != "on":
            raise Refused("Automatic fixes are currently disabled.")
        if proof["lines"] > int(os.environ.get("HELIO_AUTOFIX_MAX_LINES", "40")) or proof["files"] > int(os.environ.get("HELIO_AUTOFIX_MAX_FILES", "3")):
            raise Refused("Automatic fix no longer fits the current size limits.")
        patterns = os.environ.get("HELIO_AUTOFIX_DENY", proof["deny"]).split(",")
        if any(fnmatch.fnmatch(path, pattern.strip()) or fnmatch.fnmatch(path, pattern.strip().removeprefix("**/"))
               for path in proof["paths"] for pattern in patterns if pattern.strip()):
            raise Refused("Automatic fix touches a currently denied path.")
        return
    confirmation = proof.get("confirmation")
    if not confirmation and proof.get("posted_at") and proof.get("state"):
        confirmation = legacy_record(proof, "discord-prompts.sqlite",
                                     "SELECT id FROM prompts WHERE result_message_id=? AND kind='plan'")
    if confirmation:
        checker = runpy.run_path(str(Path(__file__).with_name("release-check.py")))
        try:
            checker["load_click"](confirmation, "plan", proof["target"], proof["revision"],
                                  not_before=datetime.datetime.fromisoformat(proof["posted_at"]), accepted_plan=True)
        except checker["Refused"] as error:
            raise Refused(str(error)) from error
        return
    channel = proof.get("channel")
    if not channel and proof.get("state"):
        channel = legacy_record(proof, "discord-conversations.sqlite", "SELECT channel_id FROM working WHERE message_id=?")
    source = source_reader(proof["message"], channel, proof.get("source_hash"))
    try:
        author = source["verify_source"](source["payload"], source["live"], source["owner"], source["trusted"], source["channel_ok"])
    except source["Refused"] as error:
        raise Refused(str(error)) from error
    if proof.get("author") and proof["author"] != author:
        raise Refused("Work requester identity differs from the saved publication.")


def publication(change: dict, command: Callable[..., str], repo: str, authorize: Callable[[], None] | None) -> None:
    issue = json.loads(command(["gh", "issue", "view", str(change["issue"]), "--repo", repo,
                               "--json", "state,body,comments,labels"]))
    if issue.get("state") != "OPEN" or FORMAT["digest"](FORMAT["split"](issue.get("body") or "")[0]) != change["scope"]:
        raise Refused("Issue scope changed; the bot must refresh its current task report.")
    if change["authority"].get("kind") == "autofix" and "bug" not in {label["name"] for label in issue.get("labels", [])}:
        raise Refused("Automatic-fix issue is no longer labelled bug.")
    if change["authority"].get("kind") == "autofix" and not change.get("url"):
        pulls = json.loads(command(["gh", "pr", "list", "--repo", repo, "--state", "open",
                                    "--label", "helio-autofix", "--limit", "10000", "--json", "url"]))
        if len(pulls) >= int(os.environ.get("HELIO_AUTOFIX_MAX_OPEN", "3")):
            raise Refused("Automatic-fix cap is occupied; the bot will retry when capacity returns.")
    if change.get("plan_body") and not any(item.get("body") == change["plan_body"] for item in issue.get("comments", [])):
        raise Refused("The approved plan changed; the bot must review the current task.")
    require_unheld(repo, change["issue"])
    if authorize:
        authorize()
    else:
        verify(change["authority"])


def require_unheld(repo: str, issue: int) -> None:
    """Every publication path, background recovery included, honours the requester's latest recorded hold."""
    work = runpy.run_path(str(Path(__file__).with_name("helio-work.py")))
    try:
        newest = work["available"](repo, issue, datetime.datetime.now(datetime.timezone.utc))
    except work["Refused"]:
        return
    if newest.holds:
        raise Refused(f"Held by the requester ({','.join(newest.holds)}); publish only after a newer request lifts it.")
