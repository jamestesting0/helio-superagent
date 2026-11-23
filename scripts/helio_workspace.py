"""Host-owned lifecycle admission and observation for the one interactive workspace."""
from __future__ import annotations

from base64 import b64encode
from contextlib import closing, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from typing import Iterator, Literal
import uuid

STATE = Path("/var/lib/helio-admin-service")
SCOPE = Path("/sys/fs/cgroup/system.slice/helio-isolated.scope/cgroup.procs")
HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / "helio_isolated_launcher.py"
WINDOWS = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
DESKTOP_TASK = "Helio Foreground Start"
LAUNCH_WINDOW = 45
Action = Literal["start", "stop"]
Process = tuple[int, str, str]


class WorkspaceError(RuntimeError):
    """The requested change could not be verified on the host."""


def process(pid: int) -> Process:
    started = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
    return pid, started, Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def alive(identity: Process) -> bool:
    try:
        return process(identity[0]) == identity
    except FileNotFoundError:
        return False


@dataclass(frozen=True, slots=True)
class Observation:
    state: str
    launcher: Process | None = None
    lead: str = ""
    detail: str = ""
    pane: str = ""


def runtime_command(args: list[str], *, timeout: int = 4, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run Herdr and read lead hints inside the existing isolation boundary."""
    account = pwd.getpwnam("helio-agent")
    candidates = []
    for pid in SCOPE.read_text().split():
        path = Path("/proc") / pid
        try:
            cmd = (path / "cmdline").read_bytes().split(b"\0")
            if path.stat().st_uid == account.pw_uid and cmd[:2] == [
                b"/usr/bin/python3", b"/home/james/helio-agent/scripts/helio_isolated_start.py",
            ]:
                candidates.append(pid)
        except FileNotFoundError:
            continue
    if len(candidates) != 1:
        raise WorkspaceError("The private Herdr runtime could not be identified.")
    return subprocess.run(
        ["/usr/bin/nsenter", "--target", candidates[0], "--user", "--mount", "--net", "--pid",
         "--setuid", str(account.pw_uid), "--setgid", str(account.pw_gid), "--",
         "/usr/bin/env", "-i", "HOME=/home/james", "HERDR_SESSION=elobot", *args],
        capture_output=True, text=True, timeout=timeout, check=check,
    )


def herdr(*args: str) -> dict:
    result = runtime_command(["/home/james/.local/bin/herdr", *args])
    return json.loads(result.stdout)["result"]


def observe() -> Observation:
    try:
        pids = SCOPE.read_text().split()
    except FileNotFoundError:
        return Observation("stopped") if SCOPE.parent.parent.is_dir() else Observation(
            "unavailable", detail="The systemd workspace scope could not be inspected.",
        )
    candidates = []
    for pid in pids:
        path = Path("/proc") / pid
        try:
            args = (path / "cmdline").read_bytes().split(b"\0")
            if path.stat().st_uid == 0 and args[:3] == [b"/usr/bin/python3", b"-I", os.fsencode(LAUNCHER)]:
                candidates.append((process(int(pid)), args[3:-1]))
        except FileNotFoundError:
            continue
    if len(candidates) != 1:
        return Observation("unavailable", detail="The workspace supervisor could not be identified.")
    identity, args = candidates[0]
    if args and args not in ([b"--start"], [b"--resume"]) and not (
        len(args) == 2 and args[0] == b"--desktop-start" and re.fullmatch(rb"[0-9a-f]{32}", args[1])
    ):
        return Observation("unavailable", detail="A host maintenance operation is using the workspace scope.")
    try:
        panes = herdr("pane", "list")["panes"]
        # The state directory belongs to the agent. Read its hint inside an unprivileged process.
        hint = runtime_command(["/usr/bin/head", "-c", "128", "/home/james/.dori/elobot/state/lead-pane"],
                               timeout=2, check=False)
        receipt = runtime_command(["/usr/bin/head", "-c", "4096", "/home/james/.dori/elobot/state/lead-start.json"],
                                  timeout=2, check=False)
        generation = hashlib.sha256(receipt.stdout.encode()).hexdigest() if receipt.returncode == 0 else ""
        pane = hint.stdout.strip()
        if pane and any(item.get("pane_id") == pane for item in panes):
            info = herdr("pane", "process-info", "--pane", pane)["process_info"]
            foreground = info["foreground_processes"]
            agents = [row for row in foreground if any(arg.endswith("/senpi/dist/bundle/cli.js") for arg in row["argv"])]
            if len(agents) == 1:
                return Observation("running", identity, f"{generation}:{pane}:{agents[0]['pid']}", pane=pane)
            if len(agents) > 1 or any(row["pid"] != info["shell_pid"] for row in foreground):
                return Observation("unavailable", identity, detail="The lead pane has an unverified foreground process.")
        lock = runtime_command(["/usr/bin/flock", "-n", "-E", "77", "/home/james/.dori/elobot/state/lead.lock",
                                "/usr/bin/true"], timeout=2, check=False)
        if lock.returncode == 77:
            return Observation("starting", identity, generation, "The local lead is initializing.")
        if lock.returncode:
            return Observation("unavailable", identity, detail="Lead initialization could not be checked.")
        return Observation("idle", identity, generation)
    except (OSError, ValueError, KeyError, TypeError, WorkspaceError, subprocess.SubprocessError):
        return Observation("unavailable", identity, detail="Herdr has not verified the lead pane.")


def desktop_start(ticket: str) -> None:
    # The only interpolated value is a UUID generated by this host for this operation.
    program = (
        "$ErrorActionPreference='Stop'; "
        "$scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); "
        f"$task=$scheduler.GetFolder('\\').GetTask('{DESKTOP_TASK}'); "
        f"$running=$task.Run('{ticket}'); if (!$running) {{ exit 1 }}"
    )
    encoded = b64encode(program.encode("utf-16-le")).decode("ascii")
    subprocess.run([WINDOWS, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                   stdin=subprocess.DEVNULL, capture_output=True, timeout=8, check=True)


class Workspace:
    def __init__(self, state: Path) -> None:
        self.state = state

    @contextmanager
    def database(self) -> Iterator[sqlite3.Connection]:
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.state / "operations.sqlite", timeout=2)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("""CREATE TABLE IF NOT EXISTS workspace_operations (
                id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, expected TEXT NOT NULL,
                outcome TEXT NOT NULL, phase TEXT NOT NULL, ticket TEXT, launcher TEXT, deadline REAL NOT NULL)""")
            db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS workspace_one_transition
                          ON workspace_operations ((1)) WHERE outcome = 'pending'""")
            db.execute("BEGIN IMMEDIATE")
            yield db

    @staticmethod
    def active(db: sqlite3.Connection) -> sqlite3.Row | None:
        return db.execute("SELECT * FROM workspace_operations WHERE outcome='pending'").fetchone()

    @staticmethod
    def finish(db: sqlite3.Connection, row: sqlite3.Row, outcome: str) -> None:
        db.execute("UPDATE workspace_operations SET outcome=? WHERE id=? AND outcome='pending'", (outcome, row["id"]))

    def reconcile(self, db: sqlite3.Connection, seen: Observation) -> None:
        row = self.active(db)
        if row is None:
            return
        target = tuple(json.loads(row["launcher"])) if row["launcher"] else None
        phase = row["phase"]
        if row["action"] == "stop":
            if seen.state == "stopped" and target and not alive(target):
                cleanup = subprocess.run(["/usr/sbin/iptables", "-w", "1", "-S"],
                                         capture_output=True, text=True, timeout=3, check=True)
                if "HELIO_AGENT_EGRESS" not in cleanup.stdout:
                    self.finish(db, row, "stopped")
            return
        if target and seen.launcher == target and (
            seen.state == "running" and (phase != "restart" or row["expected"] != seen.lead) and
            (phase != "warm" or row["ticket"] == seen.pane) or
            phase == "local-shell" and seen.state == "idle"
        ):
            self.finish(db, row, seen.state)
        elif phase == "desktop" and time.time() >= row["deadline"]:
            self.finish(db, row, "desktop-unavailable")
        elif target and not alive(target) and seen.state == "stopped":
            self.finish(db, row, "start-failed")

    @staticmethod
    def revision(db: sqlite3.Connection, seen: Observation) -> str:
        latest = db.execute("SELECT coalesce(max(rowid),0) FROM workspace_operations WHERE phase != 'reply'").fetchone()[0]
        return hashlib.sha256(repr((seen.launcher, seen.lead, latest)).encode()).hexdigest()

    def status(self, actor: str = "") -> dict:
        seen = observe()
        with self.database() as db:
            self.reconcile(db, seen)
            pending = self.active(db)
            last = db.execute("""SELECT id,outcome FROM workspace_operations
                WHERE actor=? AND phase!='reply' AND outcome!='pending' ORDER BY rowid DESC LIMIT 1""", (actor,)).fetchone()
            revision = self.revision(db, seen)
        if pending:
            waiting = time.time() < pending["deadline"]
            return {"state": ("starting" if pending["action"] == "start" else "stopping") if waiting else "unavailable",
                    "revision": "", "detail": "" if waiting else f"Operation {pending['id']} needs host observation. See the recovery instructions."}
        return {"state": seen.state, "revision": revision, "detail": seen.detail,
                **({"last": last["outcome"]} if last else {})}

    def action(self, action: Action, actor: str, operation: str, expected: str = "") -> str:
        # The lock is shared by the launcher and the broker. The durable claim
        # survives process exit while the lock fences the immediate side effect.
        with self.admission(blocking=False) as acquired:
            if not acquired:
                return self.busy(action, actor, operation, expected)
            seen = observe()
            ticket = uuid.uuid4().hex if action == "start" and seen.state == "stopped" else None
            with self.database() as db:
                existing = db.execute("SELECT * FROM workspace_operations WHERE id=?", (operation,)).fetchone()
                if existing:
                    if (existing["action"], existing["actor"], existing["expected"]) != (action, actor, expected):
                        raise WorkspaceError("Operation belongs to another request.")
                    self.reconcile(db, seen)
                    outcome = db.execute("SELECT outcome FROM workspace_operations WHERE id=?", (operation,)).fetchone()[0]
                    return f"{action}-pending" if outcome == "pending" else outcome
                self.reconcile(db, seen)
                pending = self.active(db)
                if pending:
                    result = f"busy-{pending['action']}"
                elif seen.state == "starting":
                    result = "busy-start"
                elif action == "stop" and expected != self.revision(db, seen):
                    result = "changed"
                elif seen.state == "unavailable":
                    result = "unavailable"
                elif action == "start" and seen.state == "running":
                    result = "already-running"
                elif action == "stop" and seen.state == "stopped":
                    result = "already-stopped"
                else:
                    result = "pending"
                phase = ("desktop" if ticket else "warm" if action == "start" else "workspace") if result == "pending" else "reply"
                db.execute("INSERT INTO workspace_operations VALUES (?,?,?,?,?,?,?,?,?)",
                           (operation, actor, action, expected, result, phase, ticket,
                            json.dumps(seen.launcher) if seen.launcher else None, time.time() + LAUNCH_WINDOW))
            if result != "pending":
                return result
            if action == "stop" and seen.launcher:
                current = observe()
                if current != seen:
                    with self.database() as db:
                        row = self.active(db)
                        if row and row["id"] == operation:
                            self.finish(db, row, "changed")
                    return "changed"
                self.stop(seen.launcher)
            elif ticket:
                try:
                    desktop_start(ticket)
                except (OSError, subprocess.SubprocessError):
                    # The scheduler may have accepted the request before the call
                    # failed. Invalidate the ticket before releasing admission.
                    with self.database() as db:
                        db.execute("UPDATE workspace_operations SET outcome='desktop-unavailable' WHERE id=? AND phase='desktop'",
                                   (operation,))
                    return "desktop-unavailable"
            else:
                try:
                    tab = herdr("tab", "create", "--cwd", "/home/james/PythonProjects/elo-bot", "--label", "Helio", "--focus")
                    pane = tab["root_pane"]["pane_id"]
                    deadline = time.monotonic() + 4
                    while True:
                        info = herdr("pane", "process-info", "--pane", pane)["process_info"]
                        foreground = info["foreground_processes"]
                        if len(foreground) == 1 and foreground[0]["pid"] == info["shell_pid"]:
                            break
                        if time.monotonic() >= deadline:
                            raise WorkspaceError("The new pane is not ready for the lead.")
                        time.sleep(0.1)
                except (OSError, ValueError, KeyError, WorkspaceError, subprocess.SubprocessError):
                    with self.database() as db:
                        db.execute("UPDATE workspace_operations SET outcome='start-failed' WHERE id=? AND outcome='pending'",
                                   (operation,))
                    return "start-failed"
                with self.database() as db:
                    db.execute("UPDATE workspace_operations SET ticket=? WHERE id=? AND outcome='pending'", (pane, operation))
                runtime_command(["/home/james/.local/bin/herdr", "pane", "run", pane, "helio start"])
            return f"{action}-pending"

    def busy(self, action: Action, actor: str, operation: str, expected: str) -> str:
        with self.database() as db:
            existing = db.execute("SELECT * FROM workspace_operations WHERE id=?", (operation,)).fetchone()
            if existing:
                if (existing["action"], existing["actor"], existing["expected"]) != (action, actor, expected):
                    raise WorkspaceError("Operation belongs to another request.")
                return f"{action}-pending" if existing["outcome"] == "pending" else existing["outcome"]
            pending = self.active(db)
            result = f"busy-{pending['action']}" if pending else "busy"
            db.execute("INSERT INTO workspace_operations VALUES (?,?,?,?,?,'reply',NULL,NULL,0)",
                       (operation, actor, action, expected, result))
            return result

    @contextmanager
    def admission(self, *, blocking: bool = True) -> Iterator[bool]:
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.state / "workspace.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
            else:
                yield True

    def begin_launcher(self, mode: str, ticket: str = "") -> None:
        with self.admission(), self.database() as db:
            row = self.active(db)
            if row and row["phase"] == "desktop" and time.time() >= row["deadline"]:
                self.finish(db, row, "desktop-unavailable")
                row = None
            if not ticket and row and row["launcher"]:
                # systemd already admitted this process into a new singleton
                # scope. The launcher checked that the old firewall and agent
                # processes were gone before crossing this boundary.
                target = tuple(json.loads(row["launcher"]))
                if not alive(target):
                    self.finish(db, row, "stopped" if row["action"] == "stop" else "start-failed")
                    row = None
            if ticket:
                if not row or row["phase"] != "desktop" or row["ticket"] != ticket:
                    raise WorkspaceError("The desktop launch request expired or was already used.")
                db.execute("UPDATE workspace_operations SET phase='workspace', launcher=? WHERE id=?",
                           (json.dumps(process(os.getpid())), row["id"]))
            elif row:
                raise WorkspaceError("Helio already has a lifecycle operation in progress.")
            elif mode in ("start", "resume", "shell"):
                # A local handoff has its own receipt so callers can observe progress.
                db.execute("INSERT INTO workspace_operations VALUES (?,?,?,?,?,?,?,?,?)",
                           ("local-" + uuid.uuid4().hex, "", "start", "", "pending",
                            "local-shell" if mode == "shell" else "workspace", None,
                            json.dumps(process(os.getpid())), time.time() + LAUNCH_WINDOW))

    def begin_restart(self, db: sqlite3.Connection, seen: Observation) -> None:
        self.reconcile(db, seen)
        if self.active(db) or seen.state == "starting":
            raise WorkspaceError("Helio already has a lifecycle operation in progress.")
        if not seen.launcher:
            raise WorkspaceError("The interactive workspace could not be identified.")
        db.execute("INSERT INTO workspace_operations VALUES (?,?,?,?,?,'restart',NULL,?,?)",
                   ("local-" + uuid.uuid4().hex, "", "start", seen.lead, "pending",
                    json.dumps(seen.launcher), time.time() + LAUNCH_WINDOW))

    def finish_launcher(self) -> None:
        with self.database() as db:
            row = self.active(db)
            if row and row["action"] == "start" and row["launcher"] == json.dumps(process(os.getpid())):
                self.finish(db, row, "start-failed")

    @staticmethod
    def stop(identity: Process) -> None:
        fd = os.pidfd_open(identity[0])
        try:
            if not alive(identity) or str(identity[0]) not in SCOPE.read_text().split():
                raise WorkspaceError("The workspace changed before shutdown.")
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        finally:
            os.close(fd)
