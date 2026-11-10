"""Current privacy for channel-bound planning sources, before reading message text."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import runpy
import sqlite3
from typing import Callable

POLICY = runpy.run_path(str(Path(__file__).with_name("helio_runtime_policy.py")))


class Refused(RuntimeError):
    """The source is not currently readable for planning."""


def ids(value: str) -> set[str]:
    result = {part.strip() for part in value.split(",") if part.strip()}
    if any(not part.isdigit() for part in result):
        raise Refused("invalid planning channel or trusted-user policy")
    return result


def load(message: str, channel: str | None, fingerprint: str | None,
         fetch: Callable[[str, str], dict]) -> dict:
    settings = POLICY["values"](os.environ)
    token, owner = settings.get("DORI_DISCORD_TOKEN", ""), settings.get("DORI_DISCORD_OWNER_ID", "")
    if not token or not owner.isdigit() or not message.isdigit():
        raise Refused("planning source needs current Discord credentials and numeric source IDs")
    allowed = ids(settings.get("DORI_DISCORD_ALLOWED", ""))
    ignored = ids(settings.get("DORI_DISCORD_IGNORED_CHANNELS", ""))
    scope = settings.get("DORI_DISCORD_SCOPE_CATEGORY", "").strip()
    if scope and not scope.isdigit():
        raise Refused("invalid planning scope category")
    state = Path(settings.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
    with closing(sqlite3.connect((state / "discord-delivery.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        row = db.execute("SELECT payload FROM delivery WHERE stream='inbound' AND id=? AND payload IS NOT NULL",
                         (message,)).fetchone()
        accepted = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='acceptance'").fetchone() and
                        db.execute("SELECT 1 FROM acceptance WHERE stream='inbound' AND id=?", (message,)).fetchone())
    if row is None and not (accepted or fingerprint):
        raise Refused("planning source is not pending or backed by an accepted receipt")
    payload = json.loads(row[0]) if row else None
    if channel is None and payload is not None:
        channel = payload.get("channel_id")
    if not isinstance(channel, str) or not channel.isdigit():
        raise Refused("planning source needs a pending channel or saved source location")
    if payload is not None and payload.get("channel_id") != channel:
        raise Refused("planning source changed channel")
    ancestors: set[str] = set()
    current, dm = channel, False
    for depth in range(4):
        if current in ignored:
            raise Refused("planning source is excluded by current ignored-channel policy")
        if current in ancestors:
            raise Refused("planning source ancestry is cyclic")
        ancestors.add(current)
        metadata = fetch(f"/channels/{current}", token)
        if metadata.get("id") != current:
            raise Refused("planning source channel identity changed")
        if depth == 0:
            dm = metadata.get("type") == 1
        parent = metadata.get("parent_id")
        if parent is None:
            break
        if not isinstance(parent, str) or not parent.isdigit():
            raise Refused("planning source ancestry is invalid")
        current = parent
    else:
        raise Refused("planning source ancestry is incomplete")
    if not dm and (not ancestors.intersection(allowed) or scope and scope not in ancestors):
        raise Refused("planning source is outside current allowed scope")
    if POLICY["values"](os.environ) != settings:
        raise Refused("planning privacy policy changed during source verification")
    live = fetch(f"/channels/{channel}/messages/{message}", token)
    if payload is None:
        if not fingerprint and live.get("edited_timestamp"):
            raise Refused("accepted planning source was edited without an original fingerprint")
        payload = {"message_id": message, "channel_id": channel,
                   "author_id": str((live.get("author") or {}).get("id", "")), "content": live.get("content", "")}
    if fingerprint:
        payload = {**payload, "discord_origin": {"content_sha256": fingerprint}}
    if accepted or fingerprint:
        live = {**live, "_helio_accepted_work": True}
    bot_id = str(fetch("/users/@me", token).get("id", ""))
    trusted = settings.get("DORI_DISCORD_TRUSTED_IDS")
    if trusted is None:
        trusted = (Path.home() / ".dori/elobot/trusted-users").read_text()
    if POLICY["values"](os.environ) != settings:
        raise Refused("planning privacy policy changed during source verification")
    author = str((live.get("author") or {}).get("id", ""))
    with closing(sqlite3.connect((state / "discord-delivery.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if author != owner and db.execute("SELECT 1 FROM sqlite_master WHERE name='blocked_users'").fetchone() and \
                db.execute("SELECT 1 FROM blocked_users WHERE user_id=?", (author,)).fetchone():
            raise Refused("planning source sender is currently blocked")
    return {"payload": payload, "live": live, "owner": owner, "trusted": ids(trusted),
            "channel_ok": True, "is_dm": dm, "bot_id": bot_id}
