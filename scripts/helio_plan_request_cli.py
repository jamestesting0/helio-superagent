"""Thin command routing for planning-only request acceptance."""
from __future__ import annotations

import argparse
from contextlib import closing
from dataclasses import asdict
import json
from pathlib import Path
import runpy
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from helio_plan_requests import Reader

REQUESTS = runpy.run_path(str(Path(__file__).with_name("helio_plan_requests.py")))


def register(commands: argparse._SubParsersAction) -> None:
    actions = commands.add_parser("request").add_subparsers(dest="request_action", required=True)
    for name in ("record", "show", "cancel"):
        command = actions.add_parser(name)
        command.add_argument("--issue", type=int, required=True)
        command.add_argument("--message", required=name != "show")
        if name != "show":
            command.add_argument("--channel", required=True)
        if name == "cancel":
            command.add_argument("--from-message", required=True)


def execute(args: argparse.Namespace, repo: str, reader: Reader) -> list[str]:
    if args.request_action == "show":
        if not REQUESTS["path"]().is_file():
            return ["PLAN_REQUESTS []"]
        with closing(REQUESTS["connect"]()) as db:
            rows = db.execute("""SELECT * FROM plan_requests WHERE repo=? AND issue=?
                                 AND (? IS NULL OR message=?) ORDER BY accepted_at""",
                              (repo, args.issue, args.message, args.message)).fetchall()
        return ["PLAN_REQUESTS " + json.dumps([asdict(REQUESTS["from_row"](row)) for row in rows])]
    request = REQUESTS["Request"](repo, args.issue, args.message, args.channel)
    match args.request_action:
        case "record":
            receipt = REQUESTS["record"](request, reader, args.now)
            return ["PLAN_REQUEST_RECORDED " + json.dumps(asdict(receipt))]
        case "cancel":
            receipt = REQUESTS["get"](request.repo, request.issue, request.message)
            if receipt is None:
                raise REQUESTS["Refused"]("no planning receipt exists for this request")
            cancellation = REQUESTS["Cancellation"](receipt.request, args.from_message, args.channel)
            receipt = REQUESTS["cancel"](cancellation, reader, args.now)
            return ["PLAN_REQUEST_CANCELLED " + json.dumps(asdict(receipt))]
        case invalid:
            raise REQUESTS["Refused"](f"unsupported planning request action: {invalid}")
