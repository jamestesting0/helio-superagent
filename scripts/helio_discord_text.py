"""Discord link presentation and canonical approval wording."""
from __future__ import annotations

import re


class Refused(Exception):
    pass


def format_links(text: str) -> str:
    """Link GitHub issue/PR URLs in prose while retaining code and existing links."""
    pattern = r"```[\s\S]*?(?:```|\Z)|`[^`\n]*`|^[ \t]*>>>[\s\S]*$|^[ \t]*>[^\n]*(?:\n|$)|\[(?:\\.|[^\]\\\n])*\]\((?:<[^>\n]*>|[^)\n]*)\)|<?https://github\.com/[\w.-]+/[\w.-]+/(?:issues|pull)/[1-9]\d*(?![\w-])(?:[/?#][^\s<>)]+)?>?"

    def replace(match: re.Match[str]) -> str:
        token = match[0]
        url = token.removeprefix("<").removesuffix(">")
        github = re.match(r"https://github\.com/[\w.-]+/[\w.-]+/(issues|pull)/([1-9]\d*)", url, re.I)
        if not github or len(url) > 500:
            return token
        suffix = re.search(r"[.,!?;:]+$", url)
        tail = suffix[0] if suffix else ""
        core = url[:-len(tail)] if tail else url
        label = "PR" if github[1].lower() == "pull" else "Issue"
        return f"[{label} #{github[2]}](<{core}>){tail}"

    return re.sub(pattern, replace, text, flags=re.I | re.M)


def clip_links(text: str, maximum: int) -> str:
    """Fit displayed prose without cutting a generated hyperlink in half."""
    if len(text) <= maximum:
        return text
    end = max(0, maximum - 1)
    for match in re.finditer(r"\[(?:\\.|[^\]\\])*\]\(<https://(?:github\.com|discord\.com)/[^>\s]+>\)", text):
        if match.start() < end < match.end():
            end = match.start()
            break
    return text[:end].rstrip() + "…"


def bot_text(content: str, repo: str | None = None, *, pull: bool | None = None) -> str:
    """Normalize only exact profile links and matching GitHub labels/destinations."""
    content = re.sub(
        r"\*\*\[(?:\\.|[^\]\\\n])*\]\(<https://discord\.com/users/(\d{1,30})>\)\*\*",
        lambda match: f"<@{match[1]}>", content,
    )
    if repo is None:
        return content
    pattern = rf"\[(PR|Issue) #([1-9]\d*)\]\(<https://github\.com/{re.escape(repo)}/(pull|issues)/([1-9]\d*)>\)"

    def target(match: re.Match[str]) -> str:
        valid = match[2] == match[4] and (match[1], match[3]) in (("PR", "pull"), ("Issue", "issues"))
        valid = valid and (pull is None or (match[3] == "pull") == pull)
        return f"#{match[2]}" if valid else match[0]

    return re.sub(pattern, target, content)


def prompt_line(action: str, number: int | None, revision: str) -> str:
    short = f"`{revision[:7]}`"
    values = {"merge": f"Merge #{number} · {short}?", "restart": f"Restart Elo Bot on {short}?",
              "pr": f"Open PR for #{number} · {short}?"}
    if action not in values:
        raise Refused("unsupported action")
    return values[action]


def result_line(action: str, number: int | None, revision: str, user: str) -> str:
    short = f"`{revision[:7]}`"
    if action == "plan":
        return f"✅ <@{user}> approved the plan for #{number} (r{revision})"
    if action == "merge":
        return f"✅ <@{user}> confirmed merge #{number} · {short}"
    if action == "restart":
        return f"✅ <@{user}> confirmed restart on {short}"
    return f"✅ <@{user}> confirmed PR for #{number} · {short}"
