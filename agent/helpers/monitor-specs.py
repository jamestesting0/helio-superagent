#!/usr/bin/env python3
"""Print the lead's monitor specifications, one JSON object per line, from the installed runbook."""
import json
from pathlib import Path
import re
import sys

MONITORS = ("inbound", "learning", "questions", "followups", "lanes", "dead panes", "guard", "freshness")
FIELDS = {"description", "command", "filter", "persistent", "wakes_per_hour"}


def valid(item: object) -> bool:
    if not isinstance(item, dict) or not {"description", "command", "filter"} <= set(item) <= FIELDS:
        return False
    text = all(isinstance(item[key], str) and item[key].strip() for key in ("description", "command", "filter"))
    wakes = item.get("wakes_per_hour", 1)
    return (text and item["filter"].startswith("^") and item.get("persistent", True) is True
            and isinstance(wakes, int) and not isinstance(wakes, bool) and wakes > 0)


def specs(runbook: Path) -> list[dict]:
    section = runbook.read_text().split("## Arming monitors", 1)[1].split("\n## ", 1)[0]
    block = re.search(r"```json\n(.*?)\n```", section, re.S)
    found = [json.loads(line) for line in block[1].splitlines()] if block else []
    if not all(valid(item) for item in found) or sorted(item["description"] for item in found) != sorted(MONITORS) \
            or len({item["command"] for item in found}) != len(MONITORS):
        raise ValueError(f"expected the {len(MONITORS)} distinct, complete monitor specifications in {runbook}")
    for item in found:
        re.compile(item["filter"])
    return found


if __name__ == "__main__":
    try:
        print("\n".join(json.dumps(item) for item in specs(Path(sys.argv[1]))))
    except (OSError, ValueError, IndexError, re.error) as error:
        print(f"monitor specifications unreadable: {error}", file=sys.stderr)
        sys.exit(2)
