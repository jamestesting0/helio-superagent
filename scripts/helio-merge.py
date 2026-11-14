#!/usr/bin/env python3
"""helio merge: the only way Helio merges PRs. One approval per request; the combination is tested before merging."""
from __future__ import annotations

import argparse
from pathlib import Path
import runpy
import sys

TRAIN = runpy.run_path(str(Path(__file__).resolve().with_name("helio_merge_train.py")))


def main(argv: list[str] | None = None, world=None) -> int:
    parser = argparse.ArgumentParser(prog="helio merge", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="check the PRs, build main plus all of them, and run CI on it (minutes)")
    which = plan.add_mutually_exclusive_group(required=True)
    which.add_argument("--pr", type=int, action="append", help="a PR the request names (repeat)")
    which.add_argument("--all-open", type=int, metavar="K", help="every open PR, refused unless exactly K are open")
    plan.add_argument("--restart", action="store_true", help="the request also asks to deploy (restart Elo Bot)")
    plan.add_argument("--request", required=True, help="the requester's Discord message ID")
    plan.add_argument("--channel", required=True)
    plan.add_argument("--reply-to")
    for name in ("ask", "cancel", "reask"):
        sub.add_parser(name).add_argument("--train", required=True)
    run = sub.add_parser("run", help="merge an approved train (resumes safely after any interruption)")
    run.add_argument("--train", required=True)
    run.add_argument("--message", help="the typed request that names exactly these PRs (decision D1); omit after a click")
    drop = sub.add_parser("drop", help="leave a PR out of a blocked train and re-plan the rest")
    drop.add_argument("--train", required=True)
    drop.add_argument("--pr", type=int, required=True)
    show = sub.add_parser("show")
    show.add_argument("--train")
    args = parser.parse_args(argv)
    world = world or TRAIN["default_world"]()
    try:
        if args.command == "plan":
            lines = TRAIN["plan"](world, args.pr, args.all_open, args.restart, args.request, args.channel, args.reply_to)
        elif args.command == "ask":
            lines = TRAIN["ask"](world, args.train)
        elif args.command == "run":
            lines = TRAIN["run"](world, args.train, args.message)
        elif args.command == "drop":
            lines = TRAIN["drop"](world, args.train, args.pr)
        elif args.command == "reask":
            lines = TRAIN["reask"](world, args.train)
        elif args.command == "cancel":
            lines = TRAIN["cancel"](world, args.train)
        else:
            lines = TRAIN["show"](world, args.train)
    except TRAIN["TrainError"] as error:
        print(f"MERGE_REFUSED {error}", file=sys.stderr)
        return 2
    for line in lines:
        print(line, flush=True)
    return 1 if any(line.startswith(("MERGE_TRAIN_BLOCKED", "MERGE_TRAIN_STOPPED")) for line in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
