"""Merge train: one approval merges several PRs, tested together, and ships exactly the tree that was tested.

A train builds current main plus every approved head in a temporary worktree, runs the repository's CI on that
candidate once, asks once, then merges the members back to back and checks that main's tree equals the candidate's.
Being behind main is never a reason to refresh a PR or ask again; the combination is verified at merge time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import tempfile
import time
from typing import Callable
import uuid

HERE = Path(__file__).resolve().parent
WORKFLOW = "python-tests.yml"
UNKNOWN_WAIT_S = 120
CI_WAIT_S = 20 * 60
APPROVAL_MAX_AGE_S = 12 * 3600
ACTIVE = ("binding", "approved", "merging", "merged", "restarting", "stopped")
REQUIRED_JOBS = ("Unit tests", "Integration tests")
# helio_release_client's errors that leave the outcome unknown, as opposed to a refusal relayed from the broker.
TRANSPORT = re.compile(r"inspect before retrying|Invalid release response|outcome uncertain|unavailable")
# Failures that are GitHub's or the runner's, not the code's: the only ones worth one rerun.
INFRASTRUCTURE = re.compile(r"Temporary failure resolving|Could not resolve host|The runner has received a shutdown signal|"
                            r"Internal Server Error|503 Service Unavailable|lost communication with the server")
TERMINAL = ("done", "cancelled", "expired", "blocked")


class TrainError(Exception):
    """A refusal or failure with a plain explanation for the lead."""


@dataclass
class World:
    """Every external effect, so tests can replace GitHub, Discord, git and the release broker."""
    repo: str
    state: Path
    project: Path
    run: Callable[..., str]
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.time
    check: dict = field(default_factory=dict)        # release-check.py functions (Discord and policy verification)
    release: dict = field(default_factory=dict)      # helio_release_client.py functions
    broker_current: Callable[[], bool] = lambda: True  # whether the root release broker runs this Helio's code
    running_revision: Callable[[], str | None] = lambda: None  # what Elo Bot runs now (scope of a restart)


def command(argv: list[str], cwd: Path | None = None, input: str | None = None, ok: tuple[int, ...] = (0,)) -> str:
    result = subprocess.run(argv, cwd=cwd, input=input, capture_output=True, text=True, timeout=600)
    if result.returncode not in ok:
        raise TrainError(f"{' '.join(argv[:3])} failed: {(result.stderr or result.stdout).strip()[-300:]}")
    return result.stdout


ROOT_BUNDLE_FIX = ("wsl.exe -d Ubuntu-22.04 -u root -- python3 "
                   "/home/james/PythonProjects/helio-superagent/scripts/helio_root_bundle.py --apply")


def expected_broker_version() -> str:
    """The broker reports this hash of its own three files; a mismatch means the root bundle is older than Helio."""
    return hashlib.sha256(b"".join((HERE / name).read_bytes() for name in
                                   ("helio_release_service.py", "helio_approval.py", "helio_discord_text.py"))).hexdigest()[:16]


def broker_matches(release: dict) -> bool:
    try:
        reported = release["exchange"]({"action": "inspect"}, timeout=60).get("broker_version")
    except Exception as error:  # an unreachable broker is the restart path's concern, not a version verdict
        if type(error).__name__ != "ReleaseError":
            raise
        return True
    return reported == expected_broker_version()


def broker_incident() -> str:
    return "HELIO_INCIDENT " + json.dumps({
        "audience": "owner", "kind": "release-broker-outdated",
        "problems": ["the root release broker is older than Helio, so it refuses restarts approved through a merge train"],
        "fix": f"In WSL run: {ROOT_BUNDLE_FIX} - Helio then finishes the waiting restart by itself"})


def default_world() -> World:
    return World(repo=os.environ.get("HELIO_GITHUB_REPO", "jamestesting0/elo-bot"),
                 state=Path(os.environ.get("DORI_STATE_DIR", str(Path.home() / ".dori/elobot/state"))),
                 project=Path(os.environ.get("HELIO_PROJECT", str(Path.home() / "PythonProjects/elo-bot"))).expanduser(),
                 run=command, check=runpy.run_path(str(HERE / "release-check.py")),
                 release=(release := runpy.run_path(str(HERE / "helio_release_client.py"))),
                 broker_current=lambda: broker_matches(release),
                 running_revision=lambda: release["exchange"]({"action": "inspect"}, timeout=60).get("running_revision"))


def journal(world: World) -> sqlite3.Connection:
    db = sqlite3.connect(world.state / "merge-trains.sqlite", timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS trains (id TEXT PRIMARY KEY, repo TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)""")
    # How often one request has had to leave a PR out, across every re-plan, with each time's evidence.
    db.execute("""CREATE TABLE IF NOT EXISTS exclusions (repo TEXT NOT NULL, request TEXT NOT NULL, pr INTEGER NOT NULL,
        count INTEGER NOT NULL, evidence TEXT NOT NULL, followed INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL,
        PRIMARY KEY(repo,request,pr))""")
    return db


def load(world: World, train: str) -> dict:
    with journal(world) as db:
        row = db.execute("SELECT data FROM trains WHERE id=?", (train,)).fetchone()
    if not row:
        raise TrainError(f"unknown merge train {train}")
    return json.loads(row["data"])


def save(world: World, data: dict) -> dict:
    now = world.now()
    data["updated_at"] = now
    with journal(world) as db:
        db.execute("INSERT INTO trains VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,"
                   "data=excluded.data,updated_at=excluded.updated_at",
                   (data["id"], data["repo"], data["status"], json.dumps(data), data.get("created_at", now), now))
    return data


def trains(world: World, statuses: tuple[str, ...]) -> list[dict]:
    with journal(world) as db:
        rows = db.execute(f"SELECT data FROM trains WHERE repo=? AND status IN ({','.join('?' * len(statuses))}) "
                          "ORDER BY created_at", (world.repo, *statuses)).fetchall()
    return [json.loads(row["data"]) for row in rows]


def frozen(state: Path, repo: str) -> set[str]:
    """Branches of members of an approved, running train: nothing may push to them until it ends."""
    path = state / "merge-trains.sqlite"
    if not path.is_file():
        return set()
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        rows = db.execute(f"SELECT data FROM trains WHERE repo=? AND status IN ({','.join('?' * len(ACTIVE))})", (repo, *ACTIVE)).fetchall()
    return {m["branch"] for (data,) in rows for m in json.loads(data)["members"] if not m.get("merged")}


def line(prefix: str, payload: dict) -> str:
    return f"{prefix} {json.dumps(payload, separators=(',', ':'))}"


def gh_json(world: World, *argv: str) -> object:
    return json.loads(world.run(["gh", *argv]))


PULL_FIELDS = ("number,title,state,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,mergeable,"
               "mergeStateStatus,statusCheckRollup,closingIssuesReferences,body")


def pull(world: World, number: int) -> dict:
    return gh_json(world, "pr", "view", str(number), "--repo", world.repo, "--json", PULL_FIELDS)


def main_sha(world: World) -> str:
    sha = world.run(["gh", "api", f"repos/{world.repo}/branches/main", "--jq", ".commit.sha"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise TrainError("current main is unavailable")
    return sha


def mergeable(world: World, number: int) -> dict:
    """GitHub computes mergeability in the background; UNKNOWN means ask again shortly, never a refusal."""
    deadline = world.now() + UNKNOWN_WAIT_S
    while True:
        current = pull(world, number)
        if current.get("mergeable") != "UNKNOWN" or world.now() >= deadline:
            return current
        world.sleep(10)


def screen(world: World, number: int) -> tuple[dict | None, str | None]:
    """A PR that may join a train, or the reason it cannot."""
    current = mergeable(world, number)
    if current.get("state") != "OPEN":
        return None, f"is {str(current.get('state', 'unknown')).lower()}"
    if current.get("baseRefName") != "main" or current.get("isCrossRepository") or current.get("isDraft"):
        return None, "is not an open, non-draft PR against main"
    check = world.check
    try:
        check["ISSUE_LINK"]["require_link"](current.get("body", ""), {item["number"] for item in current.get("closingIssuesReferences") or []},
                                            current.get("baseRefName", ""))
        check["require_passing"](current.get("statusCheckRollup"))
        check["require_no_holds"]("merge", current)
    except Exception as error:  # Refused types differ per module; every one is a plain reason here
        if type(error).__name__ != "Refused":
            raise
        return None, str(error)
    if current.get("mergeable") == "CONFLICTING":
        return None, "conflicts with main"
    if current.get("mergeable") == "UNKNOWN":
        return None, "GitHub has not finished checking it; it joins the next train"
    return current, None


def git(world: World, *argv: str, cwd: Path | None = None, ok: tuple[int, ...] = (0,)) -> str:
    return world.run(["git", *argv], cwd=cwd or world.project, ok=ok)


def build(world: World, train: dict) -> dict:
    """main plus every member head, in PR order; a member that conflicts is left out with the files named."""
    base = train["base"]
    git(world, "fetch", "--quiet", "origin", "main", *(f"+refs/pull/{m['pr']}/head:refs/helio-train/{train['id']}/{m['pr']}"
                                                       for m in train["members"]))
    with tempfile.TemporaryDirectory(prefix="helio-train-") as scratch:
        tree = Path(scratch) / "candidate"
        git(world, "worktree", "add", "--detach", "--quiet", str(tree), base)
        try:
            kept: list[dict] = []
            for member in train["members"]:
                got = git(world, "rev-parse", f"refs/helio-train/{train['id']}/{member['pr']}").strip()
                if got != member["head"]:
                    train["excluded"].append({"pr": member["pr"], "reason": "its head changed while the train was planned"})
                    continue
                world.run(["git", "merge", "--no-ff", "--no-edit", "-m", f"Merge pull request #{member['pr']}",
                                    member["head"]], cwd=tree, ok=(0, 1))
                if git(world, "rev-parse", "-q", "--verify", "MERGE_HEAD", cwd=tree, ok=(0, 1)).strip():
                    files = git(world, "diff", "--name-only", "--diff-filter=U", cwd=tree).split()
                    git(world, "merge", "--abort", cwd=tree)
                    with_ = [f"#{k['pr']}" for k in kept if set(k.get("files", ())) & set(files)]
                    train["excluded"].append({"pr": member["pr"], "head": member["head"], "kind": "conflict", "reason": "conflicts with " +
                                              (", ".join(with_) or "main") + (f" in {', '.join(files[:3])}" if files else "")})
                    continue
                member["files"] = git(world, "diff", "--name-only", f"{base}...{member['head']}").split()
                kept.append(member)
            train["members"] = kept
            if kept:
                train["candidate"] = git(world, "rev-parse", "HEAD", cwd=tree).strip()
                train["tree"] = git(world, "rev-parse", "HEAD^{tree}", cwd=tree).strip()
                git(world, "push", "--quiet", "--force", "origin", f"HEAD:refs/heads/{train['branch']}", cwd=tree)
        finally:
            git(world, "worktree", "remove", "--force", str(tree), ok=(0, 1, 128))
    return train


def dispatched(world: World, train: dict) -> list[dict]:
    return gh_json(world, "run", "list", "--repo", world.repo, "--workflow", WORKFLOW, "--branch", train["branch"],
                   "--event", "workflow_dispatch", "--limit", "20", "--json", "databaseId,headSha")


def infrastructure(world: World, run_id: int, jobs: list[dict]) -> bool:
    """A failure is rerun only when no test step failed and its log shows a known infrastructure cause."""
    for job in jobs:
        tests = [s for s in job.get("steps") or [] if s.get("name") in ("Run unit tests", "Run integration tests")]
        if any(s.get("conclusion") == "failure" for s in tests):
            return False
        log = world.run(["gh", "run", "view", str(run_id), "--job", str(job.get("databaseId")), "--log-failed",
                         "--repo", world.repo], ok=(0, 1))
        if not INFRASTRUCTURE.search(log):
            return False
    return bool(jobs)


def ci(world: World, train: dict) -> tuple[bool, str]:
    """Run the repository's own CI on the candidate and wait for the run this call dispatched. Passing means its
    latest attempt ran on the candidate and both required jobs succeeded; only an infrastructure failure is rerun."""
    known = {r["databaseId"] for r in dispatched(world, train)}
    world.run(["gh", "workflow", "run", WORKFLOW, "--repo", world.repo, "--ref", train["branch"]])
    deadline = world.now() + CI_WAIT_S
    run_id = None
    while run_id is None:
        fresh = [r["databaseId"] for r in dispatched(world, train)
                 if r["databaseId"] not in known and r["headSha"] == train["candidate"]]
        if fresh:
            run_id = max(fresh)
        elif world.now() >= deadline:
            return False, "the CI run for the combined change never started"
        else:
            world.sleep(10)
    train["run"] = run_id
    train["ci"] = {"candidate": train["candidate"], "run": run_id, "attempt": None, "passed": False}
    save(world, train)
    link = f"https://github.com/{world.repo}/actions/runs/{run_id}"
    rerun, expected = False, 1
    while True:
        state = gh_json(world, "run", "view", str(run_id), "--repo", world.repo, "--json", "status,conclusion,headSha,attempt,jobs")
        if state.get("headSha") != train["candidate"]:
            return False, "the CI run is not for the combined change"
        if state.get("status") != "completed" or int(state.get("attempt") or 1) < expected:  # a rerun may still be queued
            if world.now() >= deadline:
                return False, f"CI did not finish within {CI_WAIT_S // 60} minutes ({link})"
            world.sleep(20)
            continue
        train["ci"]["attempt"] = state.get("attempt")
        jobs = {job["name"]: job for job in state.get("jobs") or []}
        missing = [name for name in REQUIRED_JOBS if name not in jobs]
        failed = [jobs[name] for name in REQUIRED_JOBS if name in jobs and jobs[name].get("conclusion") != "success"]
        if not missing and not failed:
            train["ci"]["passed"] = True
            save(world, train)
            return True, ""
        if missing:
            return False, f"CI did not run {', '.join(missing)} ({link})"
        if not rerun and infrastructure(world, run_id, failed):
            rerun, expected = True, int(state.get("attempt") or 1) + 1
            world.run(["gh", "run", "rerun", str(run_id), "--repo", world.repo, "--failed"])
            world.sleep(10)
            continue
        names = ", ".join(job["name"] for job in failed)
        return False, f"{names} failed with all of them together ({link})"


def ci_passed(train: dict) -> bool:
    record = train.get("ci") or {}
    return bool(record.get("passed")) and record.get("candidate") == train.get("candidate")


def plan(world: World, prs: list[int] | None, all_open: int | None, restart: bool, request: str, channel: str,
         reply_to: str | None = None, attempt: dict | None = None) -> list[str]:
    settled = settle(world)
    if trains(world, ACTIVE):
        busy = trains(world, ACTIVE)[0]
        raise TrainError(f"merge train {busy['id']} is still running; this request joins the next one")
    if all_open is not None:
        open_prs = gh_json(world, "pr", "list", "--repo", world.repo, "--state", "open", "--base", "main", "--json", "number")
        if len(open_prs) != all_open:
            raise TrainError(f"{len(open_prs)} PRs are open, not {all_open}; name them")
        prs = [item["number"] for item in open_prs]
    if not prs:
        raise TrainError("name at least one PR")
    train = attempt or {"id": uuid.uuid4().hex[:20], "repo": world.repo, "request": request, "channel": channel,
                        "reply_to": reply_to or request, "restart": restart, "created_at": world.now(), "drops": {}}
    train.update(status="planning", base=main_sha(world), members=[], excluded=list(train.pop("carried", None) or []),
                 candidate=None, tree=None, run=None, ci=None)
    train["branch"] = f"helio/merge-train-{train['id']}"
    for number in sorted(set(prs)):
        current, reason = screen(world, number)
        if reason:
            train["excluded"].append({"pr": number, "reason": reason})
        else:
            train["members"].append({"pr": number, "head": current["headRefOid"], "branch": current["headRefName"],
                                     "title": current.get("title", "")})
    train["ships"] = shipped(world, train) if restart else []
    save(world, train)
    if train["members"]:
        build(world, train)
    handed = settled + [hand_off(world, train, item) for item in train["excluded"] if item.get("kind") == "conflict" and not item.get("handed")]
    if not train["members"]:
        return handed + finish_blocked(world, train, "no PR can be merged: " + "; ".join(f"#{x['pr']} {x['reason']}" for x in train["excluded"]))
    train["status"] = "testing"
    save(world, train)
    passed, reason = ci(world, train)
    if not passed:
        train["ci_failure"] = reason
        return handed + finish_blocked(world, train, reason)
    train["status"] = "ready"
    save(world, train)
    warn = [broker_incident()] if train["restart"] and not world.broker_current() else []
    return warn + handed + [line("MERGE_TRAIN_READY", {"id": train["id"], "members": [m["pr"] for m in train["members"]],
                                       "excluded": train["excluded"], "candidate": train["candidate"], "run": train["run"],
                                       "next": f"helio merge ask --train {train['id']}"})]


def shipped(world: World, train: dict) -> list[int]:
    """PRs already merged into main but not yet running in Elo Bot: the restart deploys them too, so the one prompt
    names them and the broker accepts exactly them."""
    running = world.running_revision()
    if not running:
        return []
    messages = gh_json(world, "api", f"repos/{world.repo}/compare/{running}...{train['base']}", "--jq", "[.commits[].commit.message]")
    numbers = {int(a or b) for text in messages for a, b in re.findall(r"^Merge pull request #(\d+)|\(#(\d+)\)\s*$", text.split("\n")[0])}
    return sorted(numbers - {m["pr"] for m in train["members"]})


def finish_blocked(world: World, train: dict, reason: str) -> list[str]:
    train.update(status="blocked", error=reason)
    save(world, train)
    delete_branch(world, train)
    return [line("MERGE_TRAIN_BLOCKED", {"id": train["id"], "reason": reason, "excluded": train["excluded"],
                                         "members": [m["pr"] for m in train["members"]], "run": train.get("run"),
                                         "next": f"helio merge drop --train {train['id']} --pr N  (after reading the failed log)"})]


def joined(numbers: list[int]) -> str:
    named = [f"#{n}" for n in numbers]
    return named[0] if len(named) == 1 else ", ".join(named[:-1]) + " and " + named[-1]


def prompt_text(world: World, train: dict) -> str:
    members = train["members"]
    head = f"Merge #{members[0]['pr']}" if len(members) == 1 else f"Merge {len(members)} PRs"
    lines = [head + (" and restart Elo Bot?" if train["restart"] else "?")]
    for member in members:
        title = re.sub(r"\s+", " ", member["title"]).strip()[:90]
        lines.append(f"[PR #{member['pr']}](<https://github.com/{world.repo}/pull/{member['pr']}>) · `{member['head'][:7]}` {title}".rstrip())
    if train["restart"] and train.get("ships"):
        lines.append(f"Also deploys already-merged {joined(train['ships'])}.")
    lines.append("Tested together: unit and integration tests passed." if len(members) > 1 else
                 "Tested with current main: unit and integration tests passed.")
    for item in train["excluded"]:
        lines.append(f"#{item['pr']} isn't included: it {item['reason']}.")
    return "\n".join(lines)


def ask(world: World, train_id: str) -> list[str]:
    train = load(world, train_id)
    if train["status"] != "ready":
        raise TrainError(f"merge train {train_id} is {train['status']}, not ready to ask")
    train["prompt"] = prompt_text(world, train)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
        handle.write(train["prompt"])
    try:
        out = world.run(["helio", "confirm", "train", "--train", train["id"],
                         "--target", f"{world.repo}#{','.join(str(m['pr']) for m in train['members'])}",
                         "--revision", train["candidate"], "--text-file", handle.name, "--channel", train["channel"],
                         "--reply-to", train["reply_to"], *(["--restart"] if train["restart"] else [])], ok=(0, 1))
    finally:
        os.unlink(handle.name)
    train["status"] = "asked"
    save(world, train)
    return [out.strip(), line("MERGE_TRAIN_ASKED", {"id": train["id"], "wait": "INBOUND_CONFIRM for this id, then helio merge run --train " + train["id"]})]


def approve(world: World, train: dict, message: str | None) -> list[str] | None:
    """Verify the approval once, record it, then bind it with the repository lock; None when this train may proceed.
    The record comes first, so a crash between the journal and the prompt store resumes the same binding."""
    if train["status"] == "binding":
        return bind(world, train)
    check, approval = world.check, world.check["APPROVAL"]
    numbers = {m["pr"] for m in train["members"]}
    if message:
        loaded = check["load"](message)
        live = loaded["live"]
        approver = check["verify_source"](loaded["payload"], live, loaded["owner"], loaded["trusted"], loaded["channel_ok"])
        named = set(approval["pr_numbers"](str(live.get("content", "")), world.repo))
        spelled = set(named)  # what the message itself names, as opposed to what the replied-to prompt lists
        replied = approval["train_reference"](live, world.repo, loaded["bot_id"])
        if replied is not None:  # a reply to the scoped prompt approves what that prompt names
            named |= set(replied) | approval["train_ships"](str((live.get("referenced_message") or {}).get("content", "")), world.repo)
        if train["restart"] and not set(train.get("ships") or []) <= named:
            raise TrainError(f"this deploy also ships already-merged {joined(train['ships'])}, which the message does not name; "
                             f"ask once with helio merge ask --train {train['id']}")
        try:
            # Already-merged PRs the deploy ships may be named beside the members; they are never merged again.
            approval["check_intent"]("merge", live, loaded["bot_id"], world.repo,
                                     numbers | (spelled & set(train.get("ships") or [])))
            if train["restart"]:
                approval["check_intent"]("restart", live, loaded["bot_id"], world.repo, None)
            for member in train["members"]:
                approval["check_revision"](member["head"], live, world.repo, member["branch"], bot_id=loaded["bot_id"],
                                           pr=member["pr"])
        except approval["Refused"] as error:
            raise TrainError(str(error)) from None
        approved_at = approval["sent_at"](live).timestamp() * 1000
        argv = ["--message", message, "--approver", approver, "--at", str(int(approved_at))]
        train["approval"] = {"kind": "message", "id": message, "channel": loaded["payload"]["channel_id"]}
    else:
        row = check["prompt_row"](train["id"])
        if row["status"] == "confirmed":
            action = "train-restart" if train["restart"] else "train"
            token = os.environ.get("DORI_DISCORD_TOKEN", "")
            result = check["api"](f"/channels/{row['channel_id']}/messages/{row['result_message_id']}", token)
            prompt = check["api"](f"/channels/{row['channel_id']}/messages/{row['message_id']}", token)
            bot_id = str(check["api"]("/users/@me", token).get("id", ""))
            try:
                approval["check_click"](action, result, prompt, bot_id, None, train["candidate"],
                                                     repo=world.repo, expected_prompt=train["prompt"])
            except approval["Refused"] as error:
                raise TrainError(str(error)) from None
        elif row["status"] != "used":
            raise TrainError(f"the train prompt is {row['status']}; nothing was merged")
        argv = ["--prompt", train["id"]]
        train["approval"] = {"kind": "prompt", "id": train["id"], "channel": row["channel_id"],
                             "result": row["result_message_id"]}
    train["approval"]["argv"] = argv
    train["status"] = "binding"
    save(world, train)
    return bind(world, train)


def bind(world: World, train: dict) -> list[str] | None:
    result = world.run(["helio", "confirm", "bind", *train["approval"]["argv"], "--train", train["id"]], ok=(0, 2, 3))
    outcome = json.loads(result.split("CONFIRM_BIND ", 1)[1])
    if outcome["outcome"] == "locked":
        return [line("MERGE_TRAIN_WAITING", {"id": train["id"], "reason": "another merge train is running"})]
    if outcome["outcome"] not in ("bound", "already"):
        train["status"] = "asked"
        train.pop("approval", None)
        save(world, train)
        raise TrainError("this approval was already used for a different train; nothing was merged")
    train["approval"].update(approver=outcome["approver"], approved_at=outcome["approved_at"] / 1000)
    train["status"] = "approved"
    save(world, train)
    return None


def refusal(action) -> str | None:
    """Release-check helpers raise their module's own Refused; any of them is a plain reason to stop."""
    try:
        action()
    except Exception as error:
        if type(error).__name__ != "Refused":
            raise
        return str(error)
    return None


def authorized(world: World, train: dict) -> str | None:
    """Current authority, rechecked before every merge and the restart: trust, place and age."""
    check = world.check
    approver, channel = train["approval"]["approver"], train["approval"]["channel"]
    trusted = check["ids"](check["BASE"] / "trusted-users")
    if approver != os.environ.get("DORI_DISCORD_OWNER_ID", "") and approver not in trusted:
        return "the approver is no longer the owner or a trusted user"
    allowed = set(os.environ.get("DORI_DISCORD_ALLOWED", "").split(","))
    if not check["location"](channel, os.environ.get("DORI_DISCORD_TOKEN", ""), allowed)[0]:
        return "the approval's channel is no longer permitted"
    if world.now() - train["approval"]["approved_at"] > APPROVAL_MAX_AGE_S:
        return "the approval is more than 12 hours old"
    return None


def eligible(world: World, member: dict) -> str | None:
    """Immediately before its merge: still the approved head, checks still green, no hold."""
    current = pull(world, member["pr"])
    if current.get("headRefOid") != member["head"]:
        return f"#{member['pr']} changed after approval"
    return (refusal(lambda: world.check["require_passing"](current.get("statusCheckRollup")))
            or refusal(lambda: world.check["require_no_holds"]("merge", current)))


def merged_state(world: World, number: int) -> dict:
    return gh_json(world, "pr", "view", str(number), "--repo", world.repo, "--json", "state,mergeCommit,headRefOid")


def merge_one(world: World, member: dict, expected: str) -> tuple[str, bool]:
    """Merge one member and return its merge commit and whether it landed directly on the expected main.

    A member GitHub already merged at the approved head (a run interrupted after the merge) is adopted, never merged
    twice; an uncertain merge is read back, never retried blindly.
    """
    def landed() -> tuple[str, bool] | None:
        state = merged_state(world, member["pr"])
        if state.get("state") != "MERGED":
            return None
        commit = (state.get("mergeCommit") or {}).get("oid", "")
        parents = gh_json(world, "api", f"repos/{world.repo}/commits/{commit}", "--jq", "[.parents[].sha]")
        if state.get("headRefOid") != member["head"]:
            raise TrainError(f"#{member['pr']} was merged at a different head; inspect main")
        return commit, bool(parents) and parents[0] == expected

    already = landed()
    if already:
        return already
    for _ in range(4):
        if main_sha(world) != expected:
            raise TrainError("main moved while the train was merging")
        out = world.run(["gh", "pr", "merge", str(member["pr"]), "--repo", world.repo, "--merge",
                         "--match-head-commit", member["head"]], ok=(0, 1))
        done = landed()
        if done:
            return done
        if "Base branch was modified" not in out and "not mergeable" in out:
            raise TrainError(f"GitHub refused to merge #{member['pr']}: {out.strip()[-200:]}")
        world.sleep(5)
    raise TrainError(f"GitHub did not merge #{member['pr']}")


RUNNABLE = ("ready", "asked", "binding", "approved", "merging", "merged", "restarting", "stopped", "done")


def run(world: World, train_id: str, message: str | None = None) -> list[str]:
    train = load(world, train_id)
    if train["status"] not in RUNNABLE:
        raise TrainError(f"merge train {train_id} is {train['status']}; only a tested, approved train runs")
    if train["status"] == "done":
        return done(world, train)  # finishes a cleanup an interruption cut short
    if train["status"] in ("ready", "asked", "binding"):
        waiting = approve(world, train, message)
        if waiting:
            return waiting
    if train["status"] == "stopped":
        reason = reconcile(world, train)
        if reason:
            return [line("MERGE_TRAIN_STOPPED", {"id": train["id"], "reason": reason})]
        train["status"] = "restarting" if train.get("restart_requested_at") else "merging"
    if train["status"] in ("approved", "merging"):
        stop = merge_all(world, train)
        if stop:
            return stop
    if train["status"] in ("merged", "restarting") and train["restart"]:
        pending = restart(world, train)
        if pending:
            return pending
    return done(world, train)


def merge_all(world: World, train: dict) -> list[str] | None:
    expected = train.get("expected") or train["base"]
    for member in train["members"]:  # adopt merges GitHub completed before an interruption, in train order
        if member.get("merged"):
            expected = member["merged"]
            continue
        state = merged_state(world, member["pr"])
        commit = (state.get("mergeCommit") or {}).get("oid", "")
        if state.get("state") != "MERGED" or state.get("headRefOid") != member["head"]:
            break
        if gh_json(world, "api", f"repos/{world.repo}/commits/{commit}", "--jq", "[.parents[].sha]")[:1] != [expected]:
            break
        member["merged"] = expected = train["expected"] = commit
        save(world, train)
    if not any(m.get("merged") for m in train["members"]):
        current = {m["pr"]: pull(world, m["pr"]) for m in train["members"]}
        moved = main_sha(world) != train["base"]
        changed = [pr for pr, p in current.items() if p.get("headRefOid") != next(m["head"] for m in train["members"] if m["pr"] == pr)]
        if moved or changed:
            for pr in changed:
                train["excluded"].append({"pr": pr, "reason": "changed after approval; it needs its own approval"})
            train["members"] = [m for m in train["members"] if m["pr"] not in changed]
            if not train["members"]:
                return stopped(world, train, "every approved PR changed after approval")
            # Re-test the approved heads on the new main; their approval stands, the combination is Helio's job.
            train["base"] = main_sha(world)
            build(world, train)
            passed, reason = ci(world, train) if train["members"] else (False, "nothing left to merge")
            if not passed:
                return stopped(world, train, reason)
            expected = train["base"]
        elif not ci_passed(train):
            return stopped(world, train, "the combined change has no passing CI run, so nothing was merged")
    train["status"] = "merging"
    save(world, train)
    # A hold or failing check known now stops the train before anything merges; each merge rechecks its own member.
    for member in train["members"]:
        problem = None if member.get("merged") else eligible(world, member)
        if problem:
            return stopped(world, train, problem)
    for member in train["members"]:
        if member.get("merged"):
            expected = member["merged"]
            continue
        problem = authorized(world, train) or eligible(world, member)
        if problem:
            return stopped(world, train, problem)
        try:
            member["merged"], direct = merge_one(world, member, expected)
        except TrainError as error:
            return stopped(world, train, str(error))
        expected = train["expected"] = member["merged"]
        save(world, train)
        if not direct:
            return stopped(world, train, f"someone pushed to main while #{member['pr']} was merging, so main is no longer what "
                                         "was tested; nothing was restarted")
    tree = world.run(["gh", "api", f"repos/{world.repo}/commits/{expected}", "--jq", ".commit.tree.sha"]).strip()
    if tree != train["tree"]:
        return stopped(world, train, f"main's tree {tree[:7]} differs from the tested {train['tree'][:7]}; nothing was restarted")
    train["tip"] = expected
    train["status"] = "merged"
    save(world, train)
    return None


def stopped(world: World, train: dict, reason: str) -> list[str]:
    train.update(status="stopped", error=reason)
    save(world, train)
    return [line("MERGE_TRAIN_STOPPED", {"id": train["id"], "reason": reason,
                                         "merged": [m["pr"] for m in train["members"] if m.get("merged")],
                                         "message": message_for(world, train)})]


def reconcile(world: World, train: dict) -> str | None:
    """A stopped train resumes only when what stopped it no longer holds."""
    for member in train["members"]:
        state = merged_state(world, member["pr"])
        if state.get("state") == "MERGED" and not member.get("merged"):
            return f"#{member['pr']} was merged outside the train; inspect main before continuing"
    return authorized(world, train)


def restart(world: World, train: dict) -> list[str] | None:
    """Request the restart once, then confirm Elo Bot runs the merged tip and logged in after the request.
    An unknown outcome stays recoverable ("restarting"); it is never reported as a success."""
    approval = train["approval"]
    confirmation = approval["result"] if approval["kind"] == "prompt" else approval["id"]
    if train["status"] == "merged":
        if not world.broker_current():
            # An outdated root broker would refuse this approval; keep it unused and finish once the bundle is updated.
            train["waiting"] = "broker"
            save(world, train)
            return [broker_incident(), line("MERGE_TRAIN_WAITING_BROKER", {
                "id": train["id"], "message": message_for(world, train),
                "next": "nothing until the owner updates the root bundle; MERGE_TRAIN_RESUME then names the command"})]
        train.pop("waiting", None)
        problem = authorized(world, train) or refusal(lambda: world.check["require_no_holds"]("restart"))
        if problem:
            return stopped(world, train, problem)
        train.update(status="restarting", restart_requested_at=world.now())
        save(world, train)
        try:
            result = world.release["exchange"]({"action": "restart", "channel_id": approval["channel"],
                                                "message_id": confirmation, "revision": train["tip"]})
        except Exception as error:
            if type(error).__name__ != "ReleaseError":
                raise
            # The client's transport failures (lost or incomplete response) may follow the effect; only the broker's
            # own refusal text proves nothing happened.
            if TRANSPORT.search(str(error)):
                return uncertain(world, train, f"the restart request's outcome is unknown ({error})")
            train.pop("restart_requested_at")
            return stopped(world, train, f"the release service refused the restart: {error}")
        train["invocation"], train["restart_result"] = result.get("invocation"), result.get("status")
        save(world, train)
        if result.get("status") != "restarted":  # e.g. "uncertain": the effect may have happened; inspect, never re-request
            return uncertain(world, train, f"the release service reported {result.get('status')!r}; the restart outcome is unknown")
    if train.get("invocation"):
        observed = world.release["observe"](train["invocation"])
        state, readiness = observed.get("observation") or {}, observed.get("readiness")
    else:  # no invocation was recorded: the running revision and a login after the request decide
        state = world.release["exchange"]({"action": "inspect"})
        requested = train["restart_requested_at"]
        new_process = after(state.get("process_started_at"), requested)  # a later login alone may be the old process
        readiness = ("login_observed" if new_process and after(state.get("login_observed_at"), requested)
                     and state.get("login_evidence") == "observed" else "unverified")
    train["running"], train["readiness"] = state.get("running_revision"), readiness
    save(world, train)
    if train["running"] != train["tip"]:
        return uncertain(world, train, f"Elo Bot runs {str(train['running'] or 'an unknown revision')[:7]}, not the merged "
                                       f"{train['tip'][:7]}")
    if readiness != "login_observed":
        return uncertain(world, train, "Elo Bot runs the merged revision but its login is not confirmed yet")
    return None


def after(stamp: object, moment: float) -> bool:
    """Whether a timestamp (ISO, or systemd's "Thu 2026-11-13 16:00:00 UTC") is at or after moment; unreadable is no."""
    text = str(stamp or "")
    systemd = re.fullmatch(r"\w{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC", text)
    try:
        when = (datetime.datetime.fromisoformat(systemd.group(1)).replace(tzinfo=datetime.timezone.utc) if systemd else
                datetime.datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return False
    return when.tzinfo is not None and when.timestamp() >= moment


def uncertain(world: World, train: dict, reason: str) -> list[str]:
    train["error"] = reason
    save(world, train)
    return [line("MERGE_TRAIN_UNCERTAIN", {"id": train["id"], "reason": reason,
                                           "next": f"helio release inspect, then helio merge run --train {train['id']}"})]


def finish(world: World, train: dict, status: str, **fields: object) -> None:
    """The only way into a terminal state, so a finished train can never keep the repository's release lock."""
    assert status in TERMINAL, status
    train.update(status=status, **fields)
    save(world, train)  # recorded first: a rerun only repeats the idempotent unlock
    world.run(["helio", "confirm", "unlock", train["id"]], ok=(0, 1))


def includes(world: World, running: str | None, tip: str) -> bool:
    """Whether the revision Elo Bot runs contains the train's merged tip."""
    if not running:
        return False
    if running == tip:
        return True
    git(world, "fetch", "-q", "origin", ok=(0, 1))
    try:
        git(world, "merge-base", "--is-ancestor", tip, running)
    except TrainError:
        return False
    return True


def settle(world: World) -> list[str]:
    """Finish trains that can no longer move: their merges reached production another way, or their approval
    expired so they can never resume. Either way they stop blocking new trains and release the lock."""
    lines = []
    for train in trains(world, ("stopped", "merged")):
        if train["status"] == "merged" and train.get("waiting") != "broker":
            continue  # a merged train mid-run is still moving
        merged = [m["pr"] for m in train["members"] if m.get("merged")]
        if merged and len(merged) == len(train["members"]) and train.get("tip"):
            try:
                running = world.running_revision() if train["restart"] else train["tip"]
            except Exception as error:  # an unreachable broker only means production cannot be confirmed now
                if type(error).__name__ != "ReleaseError":
                    raise
                running = None
            if includes(world, running, train["tip"]):
                finish(world, train, "done", error=None, settled=f"production runs {running[:7]}, which includes it")
                delete_branch(world, train)
                lines.append(line("MERGE_TRAIN_SETTLED", {"id": train["id"], "merged": merged, "running": running[:7],
                                                          "note": "already reported when it stopped; nothing to send"}))
                continue
        approval = train.get("approval") or {}
        if world.now() - approval.get("approved_at", world.now()) > APPROVAL_MAX_AGE_S:
            left = [m["pr"] for m in train["members"] if not m.get("merged")]
            finish(world, train, "expired", error="its approval is more than 12 hours old, so it can never resume")
            delete_branch(world, train)
            lines.append(line("MERGE_TRAIN_EXPIRED", {
                "id": train["id"], "merged": merged, "unmerged": left, "restart_pending": bool(train["restart"] and merged),
                "next": "a new merge request is needed for anything still wanted; nothing to send unless someone asks"}))
    return lines


def done(world: World, train: dict) -> list[str]:
    finish(world, train, "done")
    delete_branch(world, train)
    return [line("MERGE_TRAIN_DONE", {"id": train["id"], "merged": [m["pr"] for m in train["members"]],
                                      "excluded": train["excluded"], "tip": train.get("tip"),
                                      "message": message_for(world, train),
                                      "send": "reply with this message once, verbatim, to the request"})]


def delete_branch(world: World, train: dict) -> None:
    world.run(["gh", "api", "-X", "DELETE", f"repos/{world.repo}/git/refs/heads/{train['branch']}"], ok=(0, 1))


def message_for(world: World, train: dict) -> str:
    """The one message the requester sees: what merged, whether Elo Bot runs it, and what is next."""
    merged = [m["pr"] for m in train["members"] if m.get("merged")]
    lines = []
    if merged:
        text = f"Merged {joined(merged)}."
        if train.get("waiting") == "broker":
            text += f" Elo Bot restarts on `{train['tip'][:7]}` as soon as a server update finishes; I've asked the owner."
        elif train.get("readiness") == "login_observed" and train.get("running") == train.get("tip"):
            text += f" Elo Bot restarted on `{train['tip'][:7]}` and is back online."
        lines.append(text)
    if train["status"] == "stopped":
        left = [m["pr"] for m in train["members"] if not m.get("merged")]
        lines.append(f"I stopped before merging {joined(left)}: {train['error']}." if left else f"I stopped: {train['error']}.")
    for item in train["excluded"]:
        lines.append(f"#{item['pr']} is next: it {item['reason']}.")
    return "\n".join(lines)


def drop(world: World, train_id: str, number: int) -> list[str]:
    """After reading a failed combined run, leave the PR that breaks it out, hand it to its custody repair and re-plan
    the rest without asking. A PR left out twice for one request goes to the owner once, with both runs."""
    train = load(world, train_id)
    if train["status"] != "blocked":
        raise TrainError(f"merge train {train_id} is {train['status']}; only a blocked train is re-planned")
    rest = [m["pr"] for m in train["members"] if m["pr"] != number]
    if not rest:
        raise TrainError("nothing would be left to merge")
    head = next(m["head"] for m in train["members"] if m["pr"] == number)
    item = {"pr": number, "head": head, "kind": "ci", "reason": f"broke the combined tests ({train.get('ci_failure') or 'CI failed'})"}
    count, evidence = excluded_again(world, train["request"], number, item["reason"])
    lines = [line("MERGE_TRAIN_DROPPED", {"id": train_id, "pr": number, "times": count}), hand_off(world, train, item)]
    if count == 2:
        lines.append(line("MERGE_TRAIN_OWNER", {"pr": number, "evidence": evidence,
                                                "reason": "it broke the combined tests twice; tell the owner once with both runs"}))
    retry = {**train, "id": uuid.uuid4().hex[:20], "created_at": world.now(), "carried": [*train["excluded"], item]}
    return lines + plan(world, rest, None, train["restart"], train["request"], train["channel"], train["reply_to"], retry)


def excluded_again(world: World, request: str, number: int, evidence: str) -> tuple[int, list[str]]:
    with journal(world) as db:
        row = db.execute("SELECT count,evidence FROM exclusions WHERE repo=? AND request=? AND pr=?",
                         (world.repo, request, number)).fetchone()
        count, items = (row["count"] + 1, [*json.loads(row["evidence"]), evidence]) if row else (1, [evidence])
        db.execute("INSERT INTO exclusions (repo,request,pr,count,evidence,updated_at) VALUES (?,?,?,?,?,?) "
                   "ON CONFLICT(repo,request,pr) DO UPDATE SET count=excluded.count,evidence=excluded.evidence,"
                   "followed=0,updated_at=excluded.updated_at",
                   (world.repo, request, number, count, json.dumps(items[-5:]), world.now()))
    return count, items[-5:]


def hand_off(world: World, train: dict, item: dict) -> str:
    """A PR the train left out gets a keyed repair, with the evidence, in its own custody record; a PR Helio does not
    hold is named to the lead instead. Its readiness later produces MERGE_TRAIN_FOLLOWUP."""
    item["handed"] = True
    recovery = runpy.run_path(str(HERE / "helio_pr_recovery.py"))
    store = runpy.run_path(str(HERE / "helio_issues.py"))["Issues"](world.repo, world.state,
                                                                    command=lambda argv, _stdin=None: world.run(argv))
    url = f"https://github.com/{world.repo}/pull/{item['pr']}"
    runner = lambda argv, _stdin=None: world.run(argv)  # noqa: E731
    for issue in recovery["S"]["issues"](store):
        wait = recovery["S"]["load"](store, issue)
        if wait is None or wait.data.get("terminal") or wait.data.get("pr") != url:
            continue
        key = hashlib.sha256(json.dumps([train["request"], item["pr"], item.get("head"), train.get("candidate"),
                                         item["reason"]]).encode()).hexdigest()
        detail = f"Merge train {train['id']} left this PR out: it {item['reason']}. Fix it on its branch and verify again"
        try:
            recovery["actionable"](store, wait, runner, key, detail, world.now())
        except Exception as error:
            if type(error).__name__ != "Refused":
                raise
            return line("MERGE_TRAIN_REPAIR", {"pr": item["pr"], "issue": issue, "repair": key, "deferred": str(error)[:200]})
        return line("MERGE_TRAIN_REPAIR", {"pr": item["pr"], "issue": issue, "repair": key})
    return line("MERGE_TRAIN_REPAIR", {"pr": item["pr"], "custody": None,
                                       "next": "not in Helio's custody: tell the requester once why it was left out"})


def followups(state: Path, repo: str, readiness: Callable[[int], str]) -> list[str]:
    """A PR a train left out is announced once per request when it is ready, so its own train can follow. A PR that
    broke the combined tests twice for that request is the owner's (MERGE_TRAIN_OWNER), never replanned automatically."""
    path = state / "merge-trains.sqlite"
    if not path.is_file():
        return []
    release = runpy.run_path(str(HERE / "helio_release_client.py"))
    world = World(repo=repo, state=state, run=command,
                  project=Path(os.environ.get("HELIO_PROJECT", ".")).expanduser(),
                  running_revision=lambda: release["exchange"]({"action": "inspect"}, timeout=60).get("running_revision"))
    lines, seen = settle(world), set()
    held = [train for train in trains(world, ("merged", "stopped")) if train.get("restart") and (
        train.get("waiting") == "broker" or str(train.get("error") or "").startswith("the release service refused the restart"))]
    if held and broker_matches(release):
        for train in held:
            if train.get("resume_noticed") == expected_broker_version():
                continue
            train["resume_noticed"] = expected_broker_version()
            save(world, train)
            # A train planned before restart prompts named already-merged PRs needs one scoped prompt instead.
            verb = "reask" if "ships" not in train else "run"
            lines.append(line("MERGE_TRAIN_RESUME", {"id": train["id"], "reason": "the release broker is now up to date",
                                                     "next": f"helio merge {verb} --train {train['id']}"}))
    for train in trains(world, ("done", "stopped", "blocked")):
        for item in train["excluded"]:
            key = (train["request"], item["pr"])
            if key in seen:
                continue
            seen.add(key)
            with journal(world) as db:
                row = db.execute("SELECT count,followed FROM exclusions WHERE repo=? AND request=? AND pr=?",
                                 (repo, *key)).fetchone()
            if row and (row["followed"] or row["count"] >= 2):
                continue
            try:
                ready = readiness(item["pr"]).startswith(("FOLLOWUP_PR_READY", "PR_MERGED"))
            except (RuntimeError, OSError, ValueError, TrainError):
                continue
            if not ready:
                continue
            with journal(world) as db:  # one claim per request and PR: a concurrent check that loses it emits nothing
                claimed = db.execute(
                    "INSERT INTO exclusions (repo,request,pr,count,evidence,followed,updated_at) VALUES (?,?,?,0,'[]',1,?) "
                    "ON CONFLICT(repo,request,pr) DO UPDATE SET followed=1,updated_at=excluded.updated_at "
                    "WHERE exclusions.followed=0 AND exclusions.count<2", (repo, *key, time.time())).rowcount
            if not claimed:
                continue
            lines.append(line("MERGE_TRAIN_FOLLOWUP", {
                "pr": item["pr"], "train": train["id"], "request": train["request"],
                "next": f"helio merge plan --pr {item['pr']} --request {train['request']} --channel {train['channel']}"
                        + (" --restart" if train["restart"] else "")}))
    return lines


def reask(world: World, train_id: str) -> list[str]:
    """One scoped restart prompt for a train whose members are merged but whose restart approval cannot ship main as
    it is (for example it predates naming already-merged PRs). Nothing is merged again; the old approval is retired."""
    old = load(world, train_id)
    if not old.get("restart") or old["status"] not in ("stopped", "merged") or old.get("invocation") or \
            not old["members"] or not all(m.get("merged") for m in old["members"]):
        raise TrainError(f"merge train {train_id} is {old['status']}; only a merged train still waiting to restart is re-asked")
    new = {key: value for key, value in old.items() if key not in (
        "approval", "waiting", "error", "restart_requested_at", "invocation", "prompt", "resume_noticed", "readiness", "running")}
    new.update(id=uuid.uuid4().hex[:20], created_at=world.now(), status="ready", predecessor=old["id"])
    new["ships"] = shipped(world, {**new, "base": old["tip"]})
    finish(world, old, "cancelled", error=f"superseded by {new['id']} for a scoped restart approval")
    save(world, new)
    return [line("MERGE_TRAIN_REASKED", {"id": new["id"], "replaces": old["id"], "ships": new["ships"]}), *ask(world, new["id"])]


def cancel(world: World, train_id: str) -> list[str]:
    train = load(world, train_id)
    if train["status"] not in ("planning", "testing", "ready", "asked", "blocked"):
        raise TrainError(f"merge train {train_id} is {train['status']} and cannot be cancelled")
    finish(world, train, "cancelled")
    delete_branch(world, train)
    return [line("MERGE_TRAIN_CANCELLED", {"id": train_id})]


def show(world: World, train_id: str | None) -> list[str]:
    if train_id:
        return [json.dumps(load(world, train_id))]
    return [line("MERGE_TRAIN", {k: t.get(k) for k in ("id", "status", "error")} | {"members": [m["pr"] for m in t["members"]]})
            for t in trains(world, ("planning", "testing", "ready", "asked", *ACTIVE))]



def recoverable(state: Path, repo: str) -> list[str]:
    """Trains an interruption or a stop left between approval and completion, for helio health."""
    if not (state / "merge-trains.sqlite").is_file():
        return []
    with sqlite3.connect(f"file:{state / 'merge-trains.sqlite'}?mode=ro", uri=True) as db:
        rows = db.execute(f"SELECT id,status FROM trains WHERE repo=? AND status IN ({','.join('?' * len(ACTIVE))})",
                          (repo, *ACTIVE)).fetchall()
        statuses = dict(db.execute("SELECT id,status FROM trains WHERE repo=?", (repo,)).fetchall())
    problems = [f"merge train {train} is {status}: helio merge run --train {train}" for train, status in rows]
    prompts = state / "discord-prompts.sqlite"
    if prompts.is_file():
        try:
            with sqlite3.connect(f"file:{prompts}?mode=ro", uri=True) as db:
                locks = db.execute("SELECT train FROM release_locks WHERE repo=?", (repo,)).fetchall()
        except sqlite3.OperationalError:  # no train has ever taken a lock
            locks = []
        problems += [f"the release lock is held by merge train {train}, which is {statuses.get(train, 'unknown')}: "
                     f"helio confirm unlock {train}" for (train,) in locks if statuses.get(train) not in ACTIVE]
    return problems
