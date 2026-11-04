"""Natural-language merge/restart/plan approvals, verified deterministically.

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
# A plan is read on GitHub and approved later; freshness is bound to the revision instead.
PLAN_MAX_AGE_SECONDS = 72 * 3600
INTENT = {
    "merge": re.compile(r"\b(merge|merged|merging|land|ship|approved?|go ahead|lgtm)\b", re.I),
    "restart": re.compile(r"\b(restart|redeploy|deploy|reboot|bounce|ship|go live|roll ?out)\b", re.I),
    "plan": re.compile(r"\b(approved?|approving|lgtm|looks good|sounds good|go ahead|proceed|start)\b", re.I),
}
# Helio's plan announcements always start with this; replies to them approve plans, never releases.
PLAN_ANNOUNCEMENT = re.compile(r"^\W*Plan for #(\d+) \(r(\d+)\)")
AFFIRMATIVE = re.compile(
    r"^\s*(yes|yep|yeah|yup|y|ok|okay|sure|go|go ahead|do it|confirm(ed)?|approved?|ship it|lgtm)\b", re.I)
HEDGE = re.compile(r"\b(no|not|wait|hold|later|but|stop|cancel|if|unless|when|after|before|once|maybe|pending|until|tomorrow)\b|n't|\?", re.I)


class Refused(Exception):
    pass


def pr_numbers(text: str, repo: str) -> set[int]:
    owner_repo = re.escape(repo)
    found = {int(n) for n in re.findall(rf"(?i)https?://github\.com/{owner_repo}/pull/(\d+)", text)}
    found |= {int(n) for n in re.findall(rf"(?i)\b{owner_repo}#(\d+)\b", text)}
    found |= {int(n) for n in re.findall(r"(?<![\w/<])#(\d{1,6})\b", text)}
    found |= {int(n) for n in re.findall(r"\b(?:pr|pull(?:\s+request)?)\s+#?(\d{1,6})\b", text, re.I)}
    return found


def sent_at(message: dict) -> datetime.datetime:
    try:
        return datetime.datetime.fromisoformat(str(message["timestamp"]).replace("Z", "+00:00"))
    except (KeyError, ValueError):
        raise Refused("invalid confirmation timestamp") from None


def check_intent(action: str, message: dict, bot_id: str, repo: str, pr: int | None,
                 now: datetime.datetime | None = None, not_before: datetime.datetime | None = None) -> None:
    """For action "plan", `pr` is the issue number and `not_before` the plan revision's posting time."""
    if action not in INTENT:
        raise Refused("unsupported action")
    age = ((now or datetime.datetime.now(datetime.timezone.utc)) - sent_at(message)).total_seconds()
    if age < -30 or age > (PLAN_MAX_AGE_SECONDS if action == "plan" else MAX_AGE_SECONDS):
        raise Refused("confirmation is too old or has a future timestamp; ask for a fresh one")
    if not_before is not None and sent_at(message) < not_before:
        raise Refused("message was sent before the current plan revision; ask for approval of the current revision")
    content = str(message.get("content", ""))
    if HEDGE.search(content):
        raise Refused("confirmation is conditional or asks a question; ask for a clear go-ahead")
    affirmative = AFFIRMATIVE.match(content) is not None and len(content) <= 80
    referenced = message.get("referenced_message") or {}
    referenced_text = str(referenced.get("content", ""))
    replies_to_helio = bool(referenced) and str((referenced.get("author") or {}).get("id", "")) == bot_id
    # "@James merge #12" asks James, not Helio: a message naming another person must also name or answer Helio.
    mentioned = {str(user.get("id", "")) for user in message.get("mentions") or []} | set(re.findall(r"<@!?(\d+)>", content))
    if mentioned - {bot_id} and bot_id not in mentioned and not replies_to_helio:
        raise Refused("message is addressed to someone else, not Helio; ask the sender to confirm to Helio")
    announcement = PLAN_ANNOUNCEMENT.match(referenced_text) if replies_to_helio else None
    if action == "plan":
        if replies_to_helio and not announcement:
            raise Refused("message answers a Helio message that is not a plan announcement; ask for approval of the plan")
        refs = pr_numbers(content, repo) | ({int(announcement.group(1))} if announcement else set())
        if refs != {pr}:
            raise Refused(f"message does not approve the plan for issue #{pr}; ask the sender to name it or reply to its announcement")
        if not (INTENT["plan"].search(content) or (announcement and affirmative)):
            raise Refused("message does not clearly approve the plan; ask the sender to confirm")
        return
    if announcement:
        raise Refused("message answers a plan announcement; a plan approval never approves a merge or restart")
    direct = bool(INTENT[action].search(content))
    confirmed = (affirmative and replies_to_helio
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


CLICK_MAX_AGE_SECONDS = 15 * 60
DISCORD_EPOCH_MS = 1420070400000
SNOWFLAKE = re.compile(r"[0-9]{1,30}")


def snowflake_time(value: object) -> datetime.datetime:
    if not SNOWFLAKE.fullmatch(str(value)):
        raise Refused("invalid Discord identifier")
    return datetime.datetime.fromtimestamp(((int(str(value)) >> 22) + DISCORD_EPOCH_MS) / 1000, datetime.timezone.utc)


# Must match discord-inbound/interactive/text.ts exactly: the person saw this text when clicking.
def prompt_line(action: str, number: int | None, revision: str) -> str:
    short = f"`{revision[:7]}`"
    if action == "merge":
        return f"Merge #{number} · {short}?"
    if action == "restart":
        return f"Restart Elo Bot on {short}?"
    if action == "pr":
        return f"Open PR for #{number} · {short}?"
    raise Refused("unsupported action")


def result_line(action: str, number: int | None, revision: str, user: str) -> str:
    short = f"`{revision[:7]}`"
    if action == "plan":
        return f"✅ <@{user}> approved the plan for #{number} (r{revision})"
    if action == "merge":
        return f"✅ <@{user}> confirmed merge #{number} · {short}"
    if action == "restart":
        return f"✅ <@{user}> confirmed restart on {short}"
    return f"✅ <@{user}> confirmed PR for #{number} · {short}"


def check_click(action: str, result: dict, prompt: dict, bot_id: str, number: int | None, revision: str,
                now: datetime.datetime | None = None, not_before: datetime.datetime | None = None) -> tuple[str, datetime.datetime]:
    """Verify Discord's own record that one person clicked this exact Helio prompt; returns the clicker and click time.

    Discord attests who clicked which message, not which button: the prompt and result wording carry the rest.
    """
    author, meta = result.get("author") or {}, result.get("interaction_metadata") or {}
    if str(author.get("id", "")) != bot_id or not author.get("bot") or result.get("webhook_id") not in (None, bot_id):
        raise Refused("confirmation is not Helio's recorded button result")
    if meta.get("type") != 3 or str(meta.get("interacted_message_id", "")) != str(prompt.get("id", "")):
        raise Refused("confirmation is not a click on this prompt")
    if str((prompt.get("author") or {}).get("id", "")) != bot_id or prompt.get("channel_id") != result.get("channel_id"):
        raise Refused("prompt is not Helio's message in this channel")
    clicker = str((meta.get("user") or {}).get("id", ""))
    if not SNOWFLAKE.fullmatch(clicker):
        raise Refused("the click has no user")
    lines = str(prompt.get("content", "")).split("\n")
    if action == "plan":
        found = PLAN_ANNOUNCEMENT.match(lines[0])
        if not found or int(found.group(1)) != number or found.group(2) != revision:
            raise Refused("the plan prompt is for a different issue or revision")
    elif lines[0] != prompt_line(action, number, revision):
        raise Refused("the prompt names a different action, target or commit")
    if any(line.startswith(("❌", "⌛", "Replaced")) for line in lines[1:]):
        raise Refused("the prompt was cancelled, expired or replaced; ask again")
    if result.get("content") != result_line(action, number, revision, clicker):
        raise Refused("the button result does not match the prompt")
    clicked, posted, shown = snowflake_time(meta.get("id")), snowflake_time(prompt.get("id")), snowflake_time(result.get("id"))
    # A PR prompt stays clickable as long as a plan prompt; its click is still used within 15 minutes.
    open_for = PLAN_MAX_AGE_SECONDS if action in ("plan", "pr") else CLICK_MAX_AGE_SECONDS
    limit = PLAN_MAX_AGE_SECONDS if action == "plan" else CLICK_MAX_AGE_SECONDS
    if clicked < posted or (clicked - posted).total_seconds() > open_for:
        raise Refused("the prompt had expired when it was clicked; ask again")
    if not 0 <= (shown - clicked).total_seconds() <= CLICK_MAX_AGE_SECONDS:
        raise Refused("the button result was not created for this click")
    age = ((now or datetime.datetime.now(datetime.timezone.utc)) - clicked).total_seconds()
    if age < -30 or age > limit:
        raise Refused("the confirmation is too old; ask again")
    if not_before is not None and clicked < not_before:
        raise Refused("the click came before the current plan revision; ask for approval of the current revision")
    return clicker, clicked
