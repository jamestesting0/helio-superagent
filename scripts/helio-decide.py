#!/usr/bin/env python3
"""Record verified standing guidance: record, revoke, list and history."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import sys
import time

HERE = Path(__file__).resolve().parent
LEDGER = runpy.run_path(str(HERE / "helio_decisions.py"))
CHECK = runpy.run_path(str(HERE / "release-check.py"))
REPO = os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot")
STATE = Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state")))
PROTECTED = {"permissions", "trusted-users", "credentials", "release-rules", "authority"}


def sourced(message_id: str) -> dict:
    context = CHECK["load"](message_id)
    context["author"] = CHECK["verify_source"](context["payload"], context["live"], context["owner"],
                                              context["trusted"], context["channel_ok"])
    live = context["live"]
    sent = datetime.datetime.fromisoformat(live["timestamp"].replace("Z", "+00:00"))
    age = (datetime.datetime.now(datetime.timezone.utc) - sent).total_seconds()
    if not -30 <= age <= 72 * 3600 or live.get("edited_timestamp"):
        raise LEDGER["Refused"]("Use a fresh unedited instruction from the last 72 hours.")
    mentions = {item["id"] for item in live.get("mentions", [])}
    referenced = live.get("referenced_message") or {}
    if mentions - {context["bot_id"]} and context["bot_id"] not in mentions and (referenced.get("author") or {}).get("id") != context["bot_id"]:
        raise LEDGER["Refused"]("That message addresses another person; ask for an instruction to Helio.")
    return context


def review_hash(rows: list[dict]) -> str:
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    record = sub.add_parser("record")
    record.add_argument("--message", required=True)
    record.add_argument("--kind", choices=("rule", "hold"), required=True)
    record.add_argument("--topic", required=True)
    record.add_argument("--scope", required=True)
    record.add_argument("--statement-file", type=Path, required=True)
    record.add_argument("--quote-file", type=Path, required=True)
    record.add_argument("--reviewed", required=True, help="review hash from list --active --scope")
    record.add_argument("--replaces")
    record.add_argument("--until", type=int)
    record.add_argument("--action", choices=("merge", "restart"), default="merge")
    revoke = sub.add_parser("revoke")
    revoke.add_argument("--id", required=True)
    revoke.add_argument("--message", required=True)
    listing = sub.add_parser("list")
    listing.add_argument("--active", action="store_true")
    listing.add_argument("--scope")
    listing.add_argument("--offset", type=int, default=0)
    sub.add_parser("history").add_argument("--id", required=True)
    digest = sub.add_parser("digest")
    digest.add_argument("--id", required=True)
    digest.add_argument("--offset", type=int, default=0)
    digest.add_argument("--done", action="store_true")
    args = parser.parse_args(argv)
    if getattr(args, "offset", 0) < 0:
        parser.error("--offset must be nonnegative")
    try:
        db = LEDGER["connect"](STATE / "decisions.sqlite")
        try:
            if args.command == "record":
                if not re.fullmatch(r"global|project|issue#[1-9]\d*|lane:[\w-]+", args.scope):
                    raise LEDGER["Refused"]("Scope must be global, project, issue#N or lane:KEY.")
                message = sourced(args.message)
                owner = message["author"] == message["owner"]
                if args.topic in PROTECTED and not owner:
                    raise LEDGER["Refused"]("Only the owner can record guidance on authority or permissions.")
                if args.kind == "hold" and not args.scope.startswith("issue#"):
                    raise LEDGER["Refused"]("A hold must identify one issue.")
                rows = [item for item in LEDGER["active"](db, REPO) if LEDGER["overlaps"](item["scope"], args.scope)]
                if args.reviewed != review_hash(rows):
                    raise LEDGER["Refused"]("Applicable decisions changed; read list --active --scope again.")
                statement, quote = args.statement_file.read_text().strip(), args.quote_file.read_text().strip()
                if not 1 <= len(statement) <= 200 or not 1 <= len(quote) <= 300 or quote not in message["live"]["content"]:
                    raise LEDGER["Refused"]("Use a short statement and an exact quote from the instruction.")
                if quote.lower() in ("yes", "ok", "okay", "approve", "sure"):
                    raise LEDGER["Refused"]("Record the explicit instruction, not an unbound affirmative.")
                if args.until is not None and args.until <= time.time():
                    raise LEDGER["Refused"]("Expiry must be in the future.")
                decision = LEDGER["Decision"](
                    REPO, args.kind, args.topic, args.scope, statement, quote, message["author"],
                    "owner" if owner else "trusted", message["payload"]["channel_id"], args.message,
                    "owner" if message["is_dm"] else "trusted", args.action, args.until,
                    json.dumps(message["live"]))
                identity = LEDGER["record"](db, decision, args.replaces)
                print(f"DECISION_RECORDED id={identity} statement={json.dumps(statement)}; confirm to the speaker, offer undo")
            elif args.command == "revoke":
                message = sourced(args.message)
                text = message["live"]["content"]
                if not re.search(r"\b(undo|revoke|cancel|lift|remove)\b", text, re.I):
                    raise LEDGER["Refused"]("Ask for an explicit undo or lift instruction.")
                if args.id not in text:
                    referenced = message["live"].get("referenced_message") or {}
                    if (referenced.get("author") or {}).get("id") != message["bot_id"] or args.id not in referenced.get("content", ""):
                        raise LEDGER["Refused"]("Undo must name the decision or reply to its Helio confirmation.")
                LEDGER["revoke"](db, args.id, message["author"], message["owner"], args.message)
                print(f"DECISION_REVOKED id={args.id}")
            elif args.command == "digest":
                row = db.execute("SELECT data FROM decision_digest WHERE id=?", (args.id,)).fetchone()
                if row is None:
                    raise LEDGER["Refused"]("Unknown digest.")
                if args.done:
                    db.execute("UPDATE decision_digest SET handled=1 WHERE id=?", (args.id,));db.commit()
                page = row[0][args.offset:args.offset + 2000]
                print(json.dumps({"audience": "owner", "content": page,
                                  "next_offset": args.offset + len(page) if args.offset + len(page) < len(row[0]) else None}))
            else:
                rows = LEDGER["active"](db, REPO) if args.command == "list" else [
                    dict(row) for row in db.execute("SELECT * FROM decisions WHERE id=? OR superseded_by=?", (args.id, args.id))]
                if getattr(args, "scope", None):
                    rows = [item for item in rows if LEDGER["overlaps"](item["scope"], args.scope)]
                token = review_hash(rows)
                if args.command == "list":
                    rows = [{key: value for key, value in item.items() if key not in ("source", "data")} for item in rows]
                text = json.dumps(rows)
                offset = getattr(args, "offset", 0)
                page = text[offset:offset + 2000]
                print(json.dumps({"count": len(rows), "review_hash": token, "content": page,
                                  "next_offset": offset + len(page) if offset + len(page) < len(text) else None,
                                  "audience": "owner-or-trusted-only"}))
        finally:
            db.close()
    except (LEDGER["Refused"], CHECK["Refused"], OSError, ValueError, sqlite3.Error) as error:
        print(f"DECISION_REFUSED {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
