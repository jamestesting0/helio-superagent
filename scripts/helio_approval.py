"""Natural-language merge/restart approvals, verified deterministically.

Shared by scripts/release-check.py (agent side) and the root release broker.
An approval is a fresh, single-use human message that expresses the action and
identifies the target, or a plain "yes" replying to Helio's own confirmation
question that names both. The approved revision must be the one that existed
when the message was sent: it is named in the message, or GitHub's push
activity shows it was pushed before the message.
"""
from __future__ import annotations

import datetime
import json
import re
import urllib.error
import urllib.request

MAX_AGE_SECONDS = 900
INTENT = {
    "merge": re.compile(r"\b(merge|merged|merging|land|ship|approved?|go ahead|lgtm)\b", re.I),
    "restart": re.compile(r"\b(restart|redeploy|deploy|reboot|bounce|ship|go live|roll ?out)\b", re.I),
}
AFFIRMATIVE = re.compile(
    r"^\s*(yes|yep|yeah|yup|y|ok|okay|sure|go|go ahead|do it|confirm(ed)?|approved?|ship it|lgtm)\b[\s.!]*$", re.I)


class Refused(Exception):
    pass


def pr_numbers(text: str, repo: str) -> set[int]:
    owner_repo = re.escape(repo)
    found = {int(n) for n in re.findall(rf"(?i)https?://github\.com/{owner_repo}/pull/(\d+)", text)}
    found |= {int(n) for n in re.findall(rf"(?i)\b{owner_repo}#(\d+)\b", text)}
    found |= {int(n) for n in re.findall(r"(?<![\w/<])#(\d{1,6})\b", text)}
    return found


def sent_at(message: dict) -> datetime.datetime:
    try:
        return datetime.datetime.fromisoformat(str(message["timestamp"]).replace("Z", "+00:00"))
    except (KeyError, ValueError):
        raise Refused("invalid confirmation timestamp") from None


def check_intent(action: str, message: dict, bot_id: str, repo: str, pr: int | None,
                 now: datetime.datetime | None = None) -> None:
    if action not in INTENT:
        raise Refused("unsupported action")
    age = ((now or datetime.datetime.now(datetime.timezone.utc)) - sent_at(message)).total_seconds()
    if age < -30 or age > MAX_AGE_SECONDS:
        raise Refused("confirmation is too old or has a future timestamp; ask for a fresh one")
    content = str(message.get("content", ""))
    referenced = message.get("referenced_message") or {}
    referenced_text = str(referenced.get("content", ""))
    replies_to_helio = bool(referenced) and str((referenced.get("author") or {}).get("id", "")) == bot_id
    direct = bool(INTENT[action].search(content))
    confirmed = (AFFIRMATIVE.match(content) is not None and replies_to_helio
                 and INTENT[action].search(referenced_text) is not None)
    if not (direct or confirmed):
        raise Refused(f"message does not clearly ask to {action}; ask the sender to confirm")
    if action == "merge":
        refs = pr_numbers(content, repo) | pr_numbers(referenced_text, repo)
        if not refs:
            raise Refused("no pull request identified; ask which one")
        if refs != {pr}:
            raise Refused(f"message refers to {sorted(refs)}, not #{pr}; ask which pull request")


def github_activity(repo: str, branch: str) -> list:
    url = f"https://api.github.com/repos/{repo}/activity?ref=refs/heads/{branch}&per_page=1"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "helio-release"})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        raise Refused("GitHub push history unavailable; ask the sender to confirm with the commit SHA") from None


def check_revision(revision: str, message: dict, repo: str, branch: str, activity=github_activity) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise Refused("revision must be a full commit SHA")
    named = {token.lower() for token in re.findall(r"\b[0-9a-fA-F]{7,40}\b", str(message.get("content", "")))}
    if any(revision.startswith(token) for token in named):
        return
    if named:
        raise Refused("message names a different commit than the one requested; ask the sender to confirm")
    events = activity(repo, branch)
    if not events or events[0].get("after") != revision:
        raise Refused(f"{branch} has changed since the last recorded push; ask the sender to confirm the new head")
    pushed = datetime.datetime.fromisoformat(str(events[0].get("timestamp", "")).replace("Z", "+00:00"))
    if pushed > sent_at(message):
        raise Refused(f"{branch} moved after the approval; ask the sender to confirm the new head")
