"""Read-only startup snapshot. No acknowledgements, repairs, migrations or network probes."""
from __future__ import annotations

import argparse
from contextlib import closing
import datetime
import json
from pathlib import Path
import runpy
import shlex
import sqlite3
import time


def read_json(path: Path, errors: list[str], default=None):
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, type(default) if default is not None else dict):
            raise ValueError("unexpected JSON shape")
        return value
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as error:
        errors.append(f"{path.name}: {type(error).__name__}")
        return default


def query(state: Path, database: str, sql: str, errors: list[str]):
    path = state / database
    try:
        if not path.exists():
            return None
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(sql)]
    except (OSError, sqlite3.Error) as error:
        errors.append(f"{database}: {error}")
        return None


def processes_for(home: Path) -> list[dict]:
    """Sample only this installation's Unix account; disappearing processes are normal."""
    uid = home.stat().st_uid
    found = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid != uid:
                continue
            argv = [arg.decode(errors="replace") for arg in (path / "cmdline").read_bytes().split(b"\0") if arg]
            stat = (path / "stat").read_text().rsplit(")", 1)[1].split()
            namespace_pid = int(next(line.split()[-1] for line in (path / "status").read_text().splitlines() if line.startswith("NSpid:")))
            found.append({"pid": int(path.name), "argv": argv, "namespace_pid": namespace_pid, "start_ticks": stat[19]})
        except (OSError, ValueError, IndexError, StopIteration):
            continue
    return found


def snapshot(home: Path, *, runtime_home: Path | None = None, processes: list[dict] | None = None) -> dict:
    home = home.resolve()
    runtime_home = runtime_home or home
    state = home / ".dori/elobot/state"
    now = time.time()
    health = runpy.run_path(str(Path(__file__).with_name("helio_health.py")))
    errors: list[str] = []
    deploy = read_json(home / ".dori/elobot/deploy-state.json", errors, {})
    sessions = read_json(state / "helio-lead-sessions.json", errors, [])
    session = None
    if sessions:
        if isinstance(sessions[-1], dict) and isinstance(sessions[-1].get("id"), str):
            session = sessions[-1]["id"]
        else:
            errors.append("helio-lead-sessions.json: invalid session record")
    processes = processes_for(home) if processes is None else processes
    inbound = [p for p in processes if str(runtime_home / ".dori/discord-inbound/inbound.ts") in p["argv"]]
    lead = [p["pid"] for p in processes if session and session in p["argv"]]
    receipt = read_json(state / "intake-readiness.json", errors, {})
    ready = bool(len(inbound) == 1 and receipt.get("phase") == "ready"
                 and receipt.get("pid") == inbound[0]["namespace_pid"]
                 and receipt.get("start_ticks") == inbound[0]["start_ticks"])
    evidence = {key: receipt.get(key) for key in ("phase", "pid", "start_ticks", "at_ms")} if receipt else None
    monitors = {}
    for name, script, action in (
        ("inbound", "/discord-inbound/inbound.ts", None),
        ("learning", "/discord-inbound/context.ts", "--loop"),
        ("questions", "/helio-questions.py", "watch"), ("followups", "/helio-followups.py", "watch"),
        ("lanes", "dori", "watch"), ("dead_panes", "dori", "dead-panes"),
        ("guard", "dori", "guard"), ("freshness", "dori", "freshness"),
    ):
        monitors[name] = [p["pid"] for p in processes
                          if any((arg.endswith("/dori") or arg.endswith("/dori-mode/scripts/src/cli.ts")) if script == "dori"
                                 else arg.endswith(script) for arg in p["argv"])
                          and (not action or action in p["argv"])
                          and not (name == "questions" and "--lane" in p["argv"])]
    queues = {}
    queries = {
        "pending_inbound": ("discord-delivery.sqlite", "SELECT count(*) n FROM delivery WHERE stream='inbound' AND payload IS NOT NULL"),
        "pending_context": ("discord-delivery.sqlite", "SELECT count(*) n FROM delivery WHERE stream='context' AND payload IS NOT NULL"),
        "recovery_pending": ("discord-delivery.sqlite", "SELECT count(*) n FROM inbound_recovery WHERE reviewed_at IS NULL OR outcome='needs-review'"),
        "claims_in_progress": ("discord-conversations.sqlite", "SELECT count(*) n FROM working WHERE closed_at IS NULL AND claimed_at IS NOT NULL"),
        "waiting_on_helio": ("discord-conversations.sqlite", """SELECT count(*) n FROM conversations c WHERE status='open' AND
            (c.user_id=(SELECT author_id FROM transcript t WHERE t.channel_id=c.channel_id AND t.user_id=c.user_id
             AND t.opened_at=c.opened_at ORDER BY t.rowid DESC LIMIT 1) OR (c.waiting_on='' AND c.request!=''))"""),
        "answered_questions": ("discord-questions.sqlite", "SELECT count(*) n FROM questions WHERE status='answered'"),
        "followups": ("discord-conversations.sqlite", "SELECT count(*) n FROM followups WHERE status!='done'"),
    }
    for name, (database, sql) in queries.items():
        rows = query(state, database, sql, errors)
        queues[name] = rows[0]["n"] if rows else None
    queues["unclaimed_inbound"] = None
    delivery, conversations = state / "discord-delivery.sqlite", state / "discord-conversations.sqlite"
    try:
        if delivery.exists() and conversations.exists():
            with closing(sqlite3.connect(delivery.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
                db.execute("ATTACH DATABASE ? AS conversations", (conversations.as_uri() + "?mode=ro",))
                queues["unclaimed_inbound"] = db.execute("""SELECT count(*) FROM delivery d
                    LEFT JOIN acceptance a ON a.stream=d.stream AND a.id=d.id
                    LEFT JOIN conversations.working w ON w.message_id=d.id AND w.closed_at IS NULL AND w.claimed_at IS NOT NULL
                    WHERE d.stream='inbound' AND d.payload IS NOT NULL AND a.id IS NULL AND w.message_id IS NULL""").fetchone()[0]
    except (OSError, sqlite3.Error) as error:
        errors.append(f"unclaimed inbound: {error}")
    questions = query(state, "discord-questions.sqlite",
                      "SELECT id,lane,status FROM questions WHERE status IN ('answered','send_failed','delivery_unknown') ORDER BY updated DESC LIMIT 20", errors)
    for row in questions or []:
        row["inspect"] = f"helio question show {shlex.quote(row['id'])}"
    lanes: dict = {"counts": {}, "failed": []}
    try:
        lane_files = sorted((state / "lanes").glob("*.json"))
    except OSError as error:
        errors.append(f"lanes: {error}")
        lane_files = []
        lanes["counts"] = None
    for path in lane_files:
        lane = read_json(path, errors)
        if lane is None:
            continue
        if not isinstance(lane.get("key"), str):
            errors.append(f"{path.name}: missing lane key")
            continue
        status = "closed" if lane.get("closedAt") else "launch-failed" if lane.get("launchState") == "failed" else lane.get("status", "working")
        lanes["counts"][status] = lanes["counts"].get(status, 0) + 1
        if status == "launch-failed" and len(lanes["failed"]) < 20:
            key = lane["key"]
            lanes["failed"].append({"key": key, "error": str(lane.get("launchError") or "not recorded")[:300],
                                    "opened_at": lane.get("openedAt"), "pane": lane.get("pane"),
                                    "age_s": health["age_seconds"](lane.get("openedAt"), now),
                                    "basis": "recorded launch failure; not current intake state",
                                    "inspect": f"helio dori show {shlex.quote(key)}"})
    observation = query(state, "discord-conversations.sqlite", "SELECT data FROM oracle_observations WHERE singleton=1", errors)
    oracle = {}
    if observation:
        try:
            raw = json.loads(observation[0]["data"])
            if not isinstance(raw, dict):
                raise ValueError("expected an observation object")
            oracle = {key: raw.get(key) for key in ("phase", "running_revision", "observed_at", "login_observed_at",
                                                   "login_evidence", "gateway_health", "crash_loop")}
        except (ValueError, TypeError) as error:
            errors.append(f"Oracle observation: {type(error).__name__}")
    oracle["current_connectivity_verified"] = False
    oracle["basis"] = "saved observation; no independent connectivity probe"
    oracle["inspect"] = "helio release inspect"
    oracle["observation_age_s"] = health["age_seconds"](oracle.get("observed_at"), now)
    oracle["login_age_s"] = health["age_seconds"](oracle.get("login_observed_at"), now)
    try:
        health_problems = health["problems"](health["snapshot"](state, home, now), now)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, sqlite3.Error) as error:
        errors.append(f"health: {type(error).__name__}")
        health_problems = None
    attention = [f"Recorded lane failure {row['key']} opened {row['opened_at'] or 'unknown'} "
                 f"(age_s={row['age_s']}): {row['error']} ({row['inspect']}); intake readiness is separate"
                 for row in lanes["failed"]]
    if not lead:
        attention.append("No live process for the recorded lead session")
    if not ready:
        attention.append("Intake readiness is not confirmed for the current process")
    missing = [name for name, pids in monitors.items() if not pids]
    if missing:
        attention.append("Monitor processes not observed: " + ", ".join(missing))
    for name in ("recovery_pending", "answered_questions", "waiting_on_helio"):
        if queues[name]:
            attention.append(f"{name}={queues[name]}")
    attention.extend(health_problems or [])
    if deploy.get("lead_restart_pending") or deploy.get("full_restart_pending"):
        attention.append("Installed changes require a Helio restart")
    return {
        "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "versions": {key: deploy.get(key) for key in ("version", "lead_version", "deployed_at", "lead_restart_pending", "full_restart_pending")},
        "lead": {"session": session, "pids": lead},
        "ingestion": {"pids": [p["pid"] for p in inbound], "ready_observed": ready, "readiness_receipt": evidence,
                      "current_gateway_connectivity_verified": False},
        "monitors": {"basis": "live processes; subscription pause state is not inferred", "processes": monitors},
        "queues": queues, "questions": questions, "lanes": lanes, "health": health_problems,
        "dependencies": {"oracle": oracle, "browser": "not probed; inside Helio run bsk doctor --json",
                         "beta": "not probed; inside Helio run helio beta status"},
        "attention": attention, "errors": errors,
        "inspect": ["helio recovery scan", "helio question list", "helio health --json"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--home", type=Path, default=Path.home(), help=argparse.SUPPRESS)
    parser.add_argument("--runtime-home", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    report = snapshot(args.home, runtime_home=args.runtime_home)
    if args.json:
        print(json.dumps(report))
    else:
        print("HELIO_DOCTOR " + ("attention" if report["attention"] or report["errors"] else "ok"))
        for name in ("observed_at", "versions", "lead", "ingestion", "monitors", "queues", "questions", "lanes", "health", "dependencies"):
            print(f"{name}: {json.dumps(report[name])}")
        for item in report["attention"] + report["errors"]:
            print(f"ATTENTION {item}")
        print("Inspect: " + "; ".join(report["inspect"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
