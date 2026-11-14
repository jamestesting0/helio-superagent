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
import runpy
from pathlib import Path
import urllib.error
import urllib.request

TEXT = runpy.run_path(str(Path(__file__).with_name("helio_discord_text.py")))
prompt_line, result_line, bot_text, Refused = (TEXT[name] for name in ("prompt_line", "result_line", "bot_text", "Refused"))

MAX_AGE_SECONDS = 12 * 3600
WORK_MAX_AGE_SECONDS = 72 * 3600
PR_CLICK_MAX_AGE_SECONDS = 900
# A plan is read on GitHub and approved later; freshness is bound to the revision instead.
PLAN_MAX_AGE_SECONDS = 72 * 3600
INTENT = {
    "merge": re.compile(r"\b(merge|merged|merging|land|ship|approved?|go ahead|lgtm)\b", re.I),
    "restart": re.compile(r"\b(restart|redeploy|deploy|reboot|bounce|go live|roll ?out)\b", re.I),
    "plan": re.compile(r"\b(approved?|approving|lgtm|looks good|sounds good|go ahead|proceed|start|go|ship it|do it)\b", re.I),
}
# Helio's plan announcements always start with this; replies to them approve plans, never releases.
PLAN_ANNOUNCEMENT = re.compile(r"^\W*Plan for #(\d+) \(r(\d+)\)")
AFFIRMATIVE = re.compile(
    r"^\s*(yes|yep|yeah|yup|y|ok|okay|sure|go|go ahead|do it|confirm(ed)?|approved?|ship it|lgtm)\b", re.I)
# "is pr 27 ready? if so merge it and deploy": a condition on readiness is not hesitation. Merges and restarts only
# proceed after Helio verifies that readiness (checks, combined CI, release scope), so such a condition is satisfied
# by the very checks that gate the action. Any other condition ("if Bob agrees", "if not ...") still refuses.
READY_QUESTION = re.compile(r"\b(?:is|are)\s+(?:(?:pr|pull\s+request)\s*#?\d+|#\d+|it|this|that|they|these|everything|all)\s+"
                            r"(?:ready|green|good|ok(?:ay)?|passing|done)\s*\?", re.I)
READY_CONDITION = re.compile(r"\bif\s+(?:so|(?:(?:it|they|everything|all|checks|tests|ci)\s*(?:'s|'re|\s+is|\s+are|\s+pass(?:es)?)?\s*)?"
                             r"(?:ready|green|good|ok(?:ay)?|passing|clean|pass(?:es)?))\b"
                             # Only a complete clause: the action or the end follows, never a further condition.
                             r"(?=\s*(?:[,.!]\s*)?(?:$|(?:(?:then|please)\s+)*(?:merge|deploy|restart|ship|go\s+ahead|land)\b))", re.I)
# What may remain once readiness is removed: a plain release instruction and nothing else. Any further words (another
# person's approval, timing, scope) keep the original "if" and are refused as conditional.
PLAIN_RELEASE = re.compile(
    r"[\s,]*(?:(?:then|please|go\s+ahead\s+and)\s+)*(?:"
    r"(?:merge|ship|land)\s+(?:it|them|(?:(?:pr|pull\s+request)\s*)?#?\d+(?:\s*(?:,|and|&)\s*(?:(?:pr\s*)?#?\d+))*)"
    r"(?:\s*(?:,|and|then|&)\s*(?:then\s+)?(?:deploy|restart|redeploy)(?:\s+(?:it|the\s+bot|elo\s?bot))?)?"
    r"|(?:deploy|restart|redeploy)(?:\s+(?:it|the\s+bot|elo\s?bot))?"
    r"|yes|yep|yeah|ok(?:ay)?|sure|go(?:\s+ahead)?|do\s+it|ship\s+it)\s*(?:please)?[\s.!]*", re.I)
HEDGE = re.compile(r"\b(no|not|wait|hold|later|but|stop|cancel|if|unless|when|after|before|once|maybe|pending|until|tomorrow)\b|n't|\?", re.I)


def instruction_text(content: str) -> str:
    """Exclude quoted evidence and code; embeds and snapshots are never inputs."""
    # A space keeps words on either side of removed code from joining into a new instruction.
    content = re.sub(r"(?s)(`{3,}|~{3,}).*?(?:\1|\Z)", " ", content)
    content = re.split(r"(?m)^[ \t]*>>>", content, maxsplit=1)[0]
    return "\n".join(line for line in content.splitlines() if not line.lstrip().startswith(">")).strip()


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


def check_intent(action: str, message: dict, bot_id: str, repo: str, pr: int | set[int] | None,
                 now: datetime.datetime | None = None, not_before: datetime.datetime | None = None,
                 *, resolved_plan: bool = False) -> None:
    """For action "plan", `pr` is the issue number and `not_before` the plan revision's posting time."""
    if action != "work" and action not in INTENT:
        raise Refused("unsupported action")
    if resolved_plan and action != "plan":
        raise Refused("resolved plan intent cannot authorize a production action")
    age = ((now or datetime.datetime.now(datetime.timezone.utc)) - sent_at(message)).total_seconds()
    limit = PLAN_MAX_AGE_SECONDS if action == "plan" else WORK_MAX_AGE_SECONDS if action == "work" else MAX_AGE_SECONDS
    accepted_work = action == "work" and message.get("_helio_accepted_work") is True
    if age < -30 or (age > limit and not accepted_work):
        raise Refused("confirmation is too old or has a future timestamp; ask for a fresh one")
    if not_before is not None and sent_at(message) < not_before:
        raise Refused("message was sent before the current plan revision; ask for approval of the current revision")
    content = instruction_text(str(message.get("content", "")))
    unhedged = content
    if action in ("merge", "restart"):
        rest = READY_CONDITION.sub(" ", READY_QUESTION.sub(" ", re.sub(rf"<@!?{re.escape(bot_id)}>", " ", content) if bot_id else content))
        # "can you restart the bot?" is a request, not a doubt: a polite question around a plain instruction counts.
        rest = re.sub(r"^[\s,]*(?:can|could|would|will)\s+you\s+(?:please\s+)?(.*?)\s*\?+\s*$", r"\1", rest, flags=re.I | re.S)
        unhedged = rest if rest != content and PLAIN_RELEASE.fullmatch(rest) else content
    if action != "work" and not resolved_plan and HEDGE.search(unhedged):
        raise Refused("confirmation is conditional or asks a question; ask for a clear go-ahead")
    affirmative = AFFIRMATIVE.match(content) is not None and len(content) <= 80
    referenced = message.get("referenced_message") or {}
    referenced_text = instruction_text(bot_text(str(referenced.get("content", "")), repo,
                                              pull=(action == "merge") if action in ("merge", "plan") else None))
    replies_to_helio = bool(referenced) and str((referenced.get("author") or {}).get("id", "")) == bot_id
    # "@James merge #12" asks James, not Helio: a message naming another person must also name or answer Helio.
    mentioned = ({str(user.get("id", "")) for user in message.get("mentions") or []}
                 - set(re.findall(r"<@!?(\d+)>", str(message.get("content", ""))))) | set(re.findall(r"<@!?(\d+)>", content))
    if mentioned - {bot_id} and bot_id not in mentioned and not replies_to_helio:
        raise Refused("message is addressed to someone else, not Helio; ask the sender to confirm to Helio")
    announcement = PLAN_ANNOUNCEMENT.match(referenced_text) if replies_to_helio else None
    if action == "work":
        # The lead resolves work intent and its issue from the conversation. Re-parsing
        # English here rejects clear requests, side questions and unrelated constraints.
        if not content:
            raise Refused("work needs an authored human request, not only quoted evidence")
        return
    if action == "plan":
        if not content:
            raise Refused("plan approval needs authored human text, not only quoted evidence")
        if replies_to_helio and not announcement:
            raise Refused("message answers a Helio message that is not a plan announcement; ask for approval of the plan")
        refs = pr_numbers(content, repo) | ({int(announcement.group(1))} if announcement else set())
        if refs != {pr}:
            raise Refused(f"message does not approve the plan for issue #{pr}; ask the sender to name it or reply to its announcement")
        if not resolved_plan and not (INTENT["plan"].search(content) or (announcement and affirmative)):
            raise Refused("message does not clearly approve the plan; ask the sender to confirm")
        return
    if announcement:
        raise Refused("message answers a plan announcement; a plan approval never approves a merge or restart")
    direct = bool(INTENT[action].search(content))
    if action == "merge" and not re.search(r"\b(merge|land|ship|pr|pull)\b", content, re.I):
        direct = False
    confirmed = (affirmative and replies_to_helio
                 and INTENT[action].search(referenced_text) is not None)
    if not (direct or confirmed):
        raise Refused(f"message does not clearly ask to {action}; ask the sender to confirm")
    if action == "merge":
        # A reply to a merge-train prompt approves its listed members only, never PRs its prose says are left out.
        train = train_reference(message, repo, bot_id)
        refs = pr_numbers(content, repo) | (set(train) if train is not None else pr_numbers(referenced_text, repo))
        if not refs:
            raise Refused("no pull request identified; ask which one")
        expected = set(pr) if isinstance(pr, (set, frozenset)) else {pr}
        if refs != expected:
            raise Refused(f"message refers to {sorted(refs)}, not {', '.join(f'#{n}' for n in sorted(expected))}; ask which pull requests")


def github_activity(repo: str, branch: str) -> list:
    return github_json(repo, f"/activity?ref=refs/heads/{branch}&per_page=1")


def github_json(repo: str, path: str):
    url = f"https://api.github.com/repos/{repo}{path}"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "helio-release"})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        raise Refused("GitHub release evidence unavailable; ask the sender to confirm what would ship") from None


def combined_pr(message: dict, repo: str, bot_id: str) -> set[int] | None:
    """The PRs a combined "merge ... and restart" message names; None when it is not a combined request."""
    content = instruction_text(str(message.get("content", "")))
    reply = message.get("referenced_message") or {}
    train = train_reference(message, repo, bot_id)
    own = pr_numbers(content, repo)
    if AFFIRMATIVE.match(content) and str((reply.get("author") or {}).get("id", "")) == bot_id:
        reply_text = instruction_text(str(reply.get("content", "")))
        content += "\n" + (reply_text.split("\n")[0] if train is not None else reply_text)
    if not (re.search(r"\b(merge|land)\b", content, re.I) and re.search(r"\b(restart|redeploy|reboot|bounce|deploy)\b", content, re.I)):
        return None
    numbers = own | set(train) if train is not None else pr_numbers(content, repo)
    if not numbers:
        raise Refused("combined merge and restart must name the PRs; ask what would ship")
    return numbers


def require_only(numbers: set[int], revision: str, repo: str, running_revision: str | None,
                 pinned: dict[int, str] | None = None, named: list[str] | None = None) -> None:
    """main is exactly these PRs' merges: the tip is one of their merge commits, each merged head matches what was
    approved, and nothing else lies between the running revision and the tip."""
    listed = ", ".join(f"#{n}" for n in sorted(numbers))
    detail = f"ask the sender to approve what would ship: PR {listed}, main {revision}, running {running_revision or 'unknown'}"
    if not running_revision or not re.fullmatch(r"[0-9a-f]{40}", running_revision):
        raise Refused("running revision is unverified; " + detail)
    pulls = {number: github_json(repo, f"/pulls/{number}") for number in sorted(numbers)}
    heads = [pull.get("head", {}).get("sha", "") for pull in pulls.values()]
    if named and not all(any(sha.startswith(token.lower()) for sha in (revision, *heads)) for token in named):
        raise Refused("the PR revision differs from the combined approval; " + detail)
    for number, short in (pinned or {}).items():
        if not pulls[number].get("head", {}).get("sha", "").startswith(short):
            raise Refused(f"PR #{number} merged a different head than the approved {short}; " + detail)
    tip = github_json(repo, "/branches/main")["commit"]["sha"]
    merges = {pull.get("merge_commit_sha") for pull in pulls.values()}
    if not all(pull.get("merged") for pull in pulls.values()) or revision not in merges or tip != revision:
        raise Refused(f"main {tip} is not the merge of PR {listed}; " + detail)
    allowed = set(merges)
    for number in pulls:
        page = 1
        while True:
            commits = github_json(repo, f"/pulls/{number}/commits?per_page=100&page={page}")
            allowed.update(commit["sha"] for commit in commits)
            if len(commits) < 100:
                break
            page += 1
            if page > 3:
                raise Refused("PR commit evidence exceeds GitHub's 250-commit limit; " + detail)
    page, seen = 1, 0
    while True:
        comparison = github_json(repo, f"/compare/{running_revision}...{revision}?per_page=100&page={page}")
        if comparison.get("status") not in ("ahead", "identical") or comparison.get("merge_base_commit", {}).get("sha") != running_revision:
            raise Refused("running revision is not an ancestor of main; " + detail)
        commits = comparison["commits"]
        extra = [commit["sha"] for commit in commits if commit["sha"] not in allowed]
        if extra:
            raise Refused("other commits would ship: " + ", ".join(extra) + "; " + detail)
        seen += len(commits)
        if seen == comparison["total_commits"]:
            return
        if len(commits) != 100 or page >= 100:
            raise Refused("incomplete commit evidence; " + detail)
        page += 1


def named_shas(message: dict) -> list[str]:
    """Commit SHAs a message names. Discord mention, role and channel IDs are long digit strings, never commits."""
    text = re.sub(r"<(?:@[!&]?|#)\d+>", " ", instruction_text(str(message.get("content", ""))))
    return re.findall(r"\b[0-9a-fA-F]{7,40}\b", text)


def check_revision(revision: str, message: dict, repo: str, branch: str, activity=github_activity,
                   running_revision: str | None = None, bot_id: str = "", pr: int | None = None) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise Refused("revision must be a full commit SHA")
    numbers = combined_pr(message, repo, bot_id) if branch == "main" else None
    referenced = message.get("referenced_message") or {}
    train = train_reference(message, repo, bot_id)
    if train is not None:
        # A reply to a merge-train prompt approves exactly the heads it pinned; a changed head needs a new prompt.
        if numbers is not None:
            require_train_subset(train, revision, repo, running_revision, train_ships(str(referenced.get("content", "")), repo))
            return
        pins = [train[pr]] if pr in train else [] if pr is not None else list(train.values())
        if not any(revision.startswith(pin) for pin in pins):
            raise Refused(f"the replied-to merge train does not pin {revision[:7]}"
                          + (f" for #{pr}" if pr is not None else "") + "; ask for approval of the new head")
        return
    if str((referenced.get("author") or {}).get("id", "")) == bot_id:
        prompt = instruction_text(bot_text(str(referenced.get("content", "")), repo)).split("\n")[0]
        pinned = re.fullmatch(r"(?:Merge #\d+ ·|Restart Elo Bot on) `([0-9a-f]{7,40})`\?", prompt)
        if pinned and numbers is None:
            if not revision.startswith(pinned.group(1)):
                raise Refused(f"the replied-to prompt pins {pinned.group(1)}, but the new head is {revision}; ask for approval naming the new head")
            return
    if numbers is not None:
        named = named_shas(message)
        if bot_id and str((referenced.get("author") or {}).get("id", "")) == bot_id:
            named += re.findall(r"`([0-9a-f]{7,40})`", instruction_text(str(referenced.get("content", ""))).split("\n")[0])
        require_only(numbers, revision, repo, running_revision, named=named)
        return
    named = {token.lower() for token in named_shas(message)}
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


CLICK_MAX_AGE_SECONDS = 12 * 3600
DISCORD_EPOCH_MS = 1420070400000
SNOWFLAKE = re.compile(r"[0-9]{1,30}")


def snowflake_time(value: object) -> datetime.datetime:
    if not SNOWFLAKE.fullmatch(str(value)):
        raise Refused("invalid Discord identifier")
    return datetime.datetime.fromtimestamp(((int(str(value)) >> 22) + DISCORD_EPOCH_MS) / 1000, datetime.timezone.utc)


def check_click(action: str, result: dict, prompt: dict, bot_id: str, number: int | None, revision: str,
                now: datetime.datetime | None = None, not_before: datetime.datetime | None = None,
                repo: str | None = None, expected_prompt: str | None = None) -> tuple[str, datetime.datetime]:
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
    lines = bot_text(str(prompt.get("content", "")), repo, pull=action == "merge").split("\n")
    if action == "plan":
        found = PLAN_ANNOUNCEMENT.match(lines[0])
        if not found or int(found.group(1)) != number or found.group(2) != revision:
            raise Refused("the plan prompt is for a different issue or revision")
    elif action in ("train", "train-restart"):
        members = train_members(prompt.get("content", ""), repo)
        restart = lines[0].endswith(" and restart Elo Bot?")
        if not members or not TRAIN_HEAD.fullmatch(lines[0]) or restart != (action == "train-restart"):
            raise Refused("the prompt is not a merge train asking for this action")
        if expected_prompt is not None and str(prompt.get("content", "")).strip() != expected_prompt.strip():
            raise Refused("the prompt text differs from the planned merge train")
    elif lines[0] != prompt_line(action, number, revision):
        raise Refused("the prompt names a different action, target or commit")
    if any(line.startswith(("❌", "⌛", "Replaced")) for line in lines[1:]):
        raise Refused("the prompt was cancelled, expired or replaced; ask again")
    expected_result = (train_result_line(sorted(train_members(prompt.get("content", ""), repo)), action == "train-restart", clicker)
                       if action in ("train", "train-restart") else result_line(action, number, revision, clicker))
    if bot_text(str(result.get("content", "")), repo, pull=action == "merge") != expected_result:
        raise Refused("the button result does not match the prompt")
    clicked, posted, shown = snowflake_time(meta.get("id")), snowflake_time(prompt.get("id")), snowflake_time(result.get("id"))
    # A PR prompt stays clickable as long as a plan prompt; its click is still used within 15 minutes.
    open_for = PLAN_MAX_AGE_SECONDS if action in ("plan", "pr") else CLICK_MAX_AGE_SECONDS
    limit = PLAN_MAX_AGE_SECONDS if action == "plan" else PR_CLICK_MAX_AGE_SECONDS if action == "pr" else CLICK_MAX_AGE_SECONDS
    if clicked < posted or (clicked - posted).total_seconds() > open_for:
        raise Refused("the prompt had expired when it was clicked; ask again")
    if not 0 <= (shown - clicked).total_seconds() <= PR_CLICK_MAX_AGE_SECONDS:
        raise Refused("the button result was not created for this click")
    age = ((now or datetime.datetime.now(datetime.timezone.utc)) - clicked).total_seconds()
    if age < -30 or age > limit:
        raise Refused("the confirmation is too old; ask again")
    if not_before is not None and clicked < not_before:
        raise Refused("the click came before the current plan revision; ask for approval of the current revision")
    return clicker, clicked


# A merge-train prompt: "Merge 3 PRs and restart Elo Bot?" or "Merge #27?", then one line per member.
TRAIN_HEAD = re.compile(r"Merge (?:#[1-9]\d*|(?:[2-9]|[1-9]\d) PRs)(?: and restart Elo Bot)?\?")
TRAIN_MEMBER = re.compile(r"#([1-9]\d*) · `([0-9a-f]{7})`(?: .*)?")


def train_members(content: str, repo: str | None) -> dict[int, str]:
    """The PRs and pinned short heads a train prompt lists, in its own order."""
    lines = bot_text(str(content), repo, pull=True).split("\n")[1:]
    return {int(m.group(1)): m.group(2) for m in (TRAIN_MEMBER.fullmatch(line) for line in lines) if m}


def train_result_line(members: list[int], restart: bool, user: str) -> str:
    named = [f"#{n}" for n in members]
    joined = named[0] if len(named) == 1 else ", ".join(named[:-1]) + " and " + named[-1]
    return f"✅ <@{user}> approved merging {joined}" + (" and restarting Elo Bot" if restart else "")


def train_reference(message: dict, repo: str, bot_id: str) -> dict[int, str] | None:
    """The member pins of the Helio merge-train prompt this message replies to, if it replies to one."""
    referenced = message.get("referenced_message") or {}
    if not bot_id or str((referenced.get("author") or {}).get("id", "")) != bot_id:
        return None
    content = str(referenced.get("content", ""))
    if not TRAIN_HEAD.fullmatch(instruction_text(bot_text(content, repo)).split("\n")[0]):
        return None
    return train_members(content, repo)


TRAIN_SHIPS = re.compile(r"Also deploys already-merged ((?:#[1-9]\d*(?:, | and )?)+)\.")


def train_ships(content: str, repo: str | None) -> set[int]:
    """Already-merged PRs a train prompt says its restart also deploys."""
    for text in bot_text(str(content), repo, pull=True).split("\n")[1:]:
        found = TRAIN_SHIPS.fullmatch(text)
        if found:
            return {int(n) for n in re.findall(r"#(\d+)", found.group(1))}
    return set()


def require_train_subset(members: dict[int, str], revision: str, repo: str, running_revision: str | None,
                         ships: set[int] = frozenset()) -> None:
    """Only listed members ship, each at its pinned head, plus the already-merged PRs the prompt names. A member the
    train left out (it changed after approval) may stay open; its commits, like any other, must not ship."""
    merged = {number for number in members if github_json(repo, f"/pulls/{number}").get("merged")}
    if not merged:
        raise Refused("none of the merge train's pull requests is merged; nothing approved would ship")
    require_only(merged | set(ships), revision, repo, running_revision, pinned={number: members[number] for number in merged})


def check_train_restart(revision: str, prompt_content: str, repo: str, running_revision: str | None) -> None:
    """A click on a train prompt that asked to restart authorizes shipping its merged members' merges only."""
    members = train_members(prompt_content, repo)
    if not members:
        raise Refused("the train prompt lists no pull requests")
    require_train_subset(members, revision, repo, running_revision, train_ships(prompt_content, repo))
