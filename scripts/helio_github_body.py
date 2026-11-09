"""Integrity and reviewed ownership of generated pull request descriptions."""
from __future__ import annotations

import hashlib
import re

START = "<!-- helio-pr:start -->"
END = "<!-- helio-pr:end -->"
SIGNATURE = re.compile(r"\n<!-- helio-pr-sha256:([0-9a-f]{64}) -->\n" + re.escape(END))
RELATION = re.compile(r"(?m)^(?:Fixes|Refs) #[1-9]\d*\n\n" + re.escape(START))


class Refused(ValueError):
    """The current body cannot safely be replaced."""


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def seal(content: str) -> str:
    return f"{content}\n<!-- helio-pr-sha256:{digest(content)} -->\n{END}\n"


def bounded(body: str) -> str:
    if len(body) > 65536:
        raise Refused("PR body exceeds 65536 characters; condense the generated report while preserving reviewer notes.")
    return body


def merge(current: str, generated: str, adopt: str | None = None) -> str:
    """Replace only an intact owned region, or an explicitly reviewed legacy body."""
    if adopt is not None and adopt != digest(current):
        raise Refused("Reviewed PR body changed; read it again before adopting.")
    if not current:
        return bounded(generated)
    relations = list(RELATION.finditer(current))
    signatures = list(SIGNATURE.finditer(current))
    valid = len(relations) == len(signatures) == 1 and current.count(START) == current.count(END) == 1
    if valid:
        start, signature = relations[0].start(), signatures[0]
        valid = start < signature.start() and digest(current[start:signature.start()]) == signature[1]
        if valid or adopt:
            return bounded(current[:start] + generated.rstrip("\n") + current[signature.end():])
    if adopt:
        return bounded(generated)
    raise Refused(f"PR_EDITED_OUTSIDE_HELIO reviewed_sha256={digest(current)}; review the body and use --adopt-body.")
