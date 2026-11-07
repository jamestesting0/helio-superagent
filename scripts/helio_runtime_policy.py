"""Read a published policy at the authorization boundary, including long-lived watchers."""
from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path
import re


def values(environment: Mapping[str, str]) -> dict[str, str]:
    directory = environment.get("DORI_POLICY_DIR")
    home = environment.get("HOME")
    if not directory and not home:
        return dict(environment)
    path = Path(directory) / "policy.json" if directory else Path(home) / ".dori/elobot/policy/policy.json"
    if not directory and not path.exists():
        return dict(environment)
    snapshot = json.loads(path.read_text())
    public = snapshot.get("values") if isinstance(snapshot, dict) else None
    if (not isinstance(public, dict) or snapshot.get("version") != 1 or
        not isinstance(snapshot.get("revision"), str) or not re.fullmatch(r"[a-f0-9]{64}", snapshot["revision"]) or
        any(not isinstance(key, str) or not isinstance(value, str) for key, value in public.items()) or
        {"DORI_DISCORD_TOKEN", "BOT_BETA_TOKEN"}.intersection(public)):
        raise ValueError("Invalid published runtime policy; authorization withheld")
    return {**environment, **public, "DORI_DISCORD_TRUSTED_IDS": public.get("HELIO_TRUSTED_USERS", ""),
            "DORI_DISCORD_REPORT_CHANNELS": public.get("HELIO_REPORT_CHANNELS", "")}
