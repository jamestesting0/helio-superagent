"""Legacy-compatible issue projections, integrity and public change notes."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import runpy
from typing import TypedDict

POSTS = runpy.run_path(str(Path(__file__).with_name("helio_github_posts.py")))
START = "<!-- helio-status:start -->"
END = "<!-- helio-status:end -->"
HASH = re.compile(r"\n?<!-- helio-body-sha256:([0-9a-f]{64}) -->\s*\Z")


class StatusBlock(TypedDict):
    status: str
    note: str
    observed: str
    summary: str
    links: list[str]
    delivery: list[str]


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def valid(body: str) -> bool:
    if not any(marker in body for marker in (START, END, "<!-- helio-body-sha256:")):
        return True
    return (body.startswith(START) and body.count(START) == body.count(END) == 1
            and body.count("<!-- helio-body-sha256:") == 1 and HASH.search(body) is not None)


def split(body: str) -> tuple[str, str | None]:
    marker = HASH.search(body)
    unsigned = body[:marker.start()] if marker else body
    content = unsigned.split(END, 1)[1].lstrip("\n") if unsigned.startswith(START) and END in unsigned else unsigned
    return content.rstrip(), marker.group(1) if marker else None


def render(content: str, block: StatusBlock) -> str:
    if content.startswith(POSTS["ISSUE_FORMAT"] + "\n"):
        body = POSTS["delivery"](content, block.get("delivery", []), block["observed"])
    else:
        note = " ".join(block["note"].split())
        summary = " ".join(block["summary"].split())
        body = f"{START}\n**Status:** {block['status']}\n**In short:** {summary}\n**Links:** {' · '.join(block['links'])}\n**Updated:** {block['observed']}" + (f" · {note}" if note else "") + f"\n{END}\n\n{content.rstrip()}"
    return POSTS["bounded"](body + f"\n<!-- helio-body-sha256:{digest(body)} -->")


def without_timestamp(body: str) -> str:
    unsigned = body[:HASH.search(body).start()] if HASH.search(body) else body
    if unsigned.startswith(START):
        header, separator, content = unsigned.partition(END)
        return re.sub(r"(?m)^\*\*(?:Updated|As of):\*\*.*$", "", header) + separator + content
    return unsigned


def only_status_refreshed(current: str, written: str) -> bool:
    marker = HASH.search(current)
    content, recorded = split(current)
    return valid(current) and marker is not None and digest(current[:marker.start()]) == recorded and content == split(written)[0]
