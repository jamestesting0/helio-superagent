#!/usr/bin/env python3
"""Owner-peer administration broker; its socket is never exposed to the agent."""
from __future__ import annotations

import argparse
from collections.abc import Mapping
from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import secrets
import sqlite3
import subprocess
import time
from typing import TypedDict

type Json = str | int | float | bool | None | list[Json] | dict[str, Json]
HERE = Path(__file__).resolve().parent
JOURNAL = runpy.run_path(str(HERE / "helio_admin_journal.py"))
PROCESS = runpy.run_path(str(HERE / "helio_admin_process.py"))
SOCKET = runpy.run_path(str(HERE / "helio_admin_socket.py"))
RECOVERY = runpy.run_path(str(HERE / "helio_admin_recovery.py"))
Refused = JOURNAL["Refused"]
OPERATION = re.compile(r"[A-Za-z0-9_-]{1,100}")
MUTATIONS = frozenset(("conversations.hold", "conversations.resume", "conversations.close",
                      "conversations.reopen", "lanes.pause", "lanes.resume", "lanes.close",
                      "lanes.abandon", "blocks.add", "blocks.remove"))
CONFIG_ACTIONS = frozenset(("trusted.add", "trusted.remove", "channels.set", "timeout.set"))


class PublicPolicy(TypedDict):
    version: int
    revision: str
    values: dict[str, str]


@dataclass(frozen=True, slots=True)
class Settings:
    owner_home: Path
    isolated_home: Path
    policy_dir: Path
    state: Path
    owner_uid: int
    owner_gid: int
    agent_uid: int
    agent_gid: int


def string(request: Mapping[str, Json], name: str, maximum: int = 600) -> str:
    value = request.get(name)
    if not isinstance(value, str) or len(value) > maximum:
        raise Refused("invalid", f"Invalid {name}")
    return value


def authorize(policy: PublicPolicy, actor: str, owner_only: bool = False) -> None:
    if actor == policy["values"]["DORI_DISCORD_OWNER_ID"]:
        return
    if owner_only or actor not in policy["values"]["HELIO_TRUSTED_USERS"].split(","):
        raise Refused("denied", "Only the owner can change this setting" if owner_only else "You no longer have administration access")


class AdminService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.operations = JOURNAL["Operations"](settings.state)

    def policy(self) -> PublicPolicy:
        config = runpy.run_path(str(HERE / "helio_config.py"))
        values = config["load"](self.settings.owner_home)
        if config["problems"](values):
            raise Refused("unavailable", "The owner's canonical configuration is invalid")
        return config["policy_snapshot"](values, self.settings.owner_home)

    def published_revision(self) -> str:
        """The revision the isolated runtime enforces. A proof must carry it, not one recomputed here from this
        service's own copy of the defaults, or every panel fails whenever that copy drifts from the kit."""
        try:
            snapshot = json.loads((self.settings.policy_dir / "policy.json").read_text())
        except (OSError, ValueError):
            raise Refused("unavailable", "The runtime policy is not published; run helio deploy") from None
        values = snapshot.get("values") if isinstance(snapshot, dict) else None
        revision = snapshot.get("revision") if isinstance(snapshot, dict) else None
        if (not isinstance(snapshot, dict) or snapshot.get("version") != 1 or not isinstance(values, dict) or not isinstance(revision, str) or
                hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest() != revision):
            raise Refused("unavailable", "The published runtime policy is invalid; run helio deploy")
        return revision

    def publish(self) -> PublicPolicy:
        owner = runpy.run_path(str(HERE / "helio_owner_policy.py"))
        owner["refresh"](str(self.settings.isolated_home), pwd.getpwuid(self.settings.agent_uid))
        return self.policy()

    def runtime(self, request: Mapping[str, Json], policy: PublicPolicy) -> Json:
        actor = string(request, "actor", 30)
        authorize(policy, actor)
        if string(request, "guild", 30) != policy["values"]["HELIO_ADMIN_GUILD"]:
            raise Refused("denied", "This administration request belongs to a different server")
        operation = string(request, "operation", 100)
        if not OPERATION.fullmatch(operation):
            raise Refused("invalid", "Invalid administration operation ID")
        query = request.get("query")
        if not isinstance(query, dict) or query.get("kind") not in ("read", "mutate", "probe", "receipt"):
            raise Refused("invalid", "Invalid runtime query")
        mutation = query.get("kind") in ("mutate", "receipt")
        if mutation:
            action = query.get("action")
            if not isinstance(action, str) or action not in MUTATIONS:
                raise Refused("invalid", "Unsupported administration mutation")
            authorize(policy, actor, action == "lanes.abandon")
        requests = self.settings.policy_dir / "requests"
        requests.mkdir(mode=0o755, parents=True, exist_ok=True)
        requests.chmod(0o755)
        nonce = secrets.token_hex(16)
        path = requests / (nonce + ".json")
        proof = {"id": nonce, "operation": operation, "actor": actor, "guild": request["guild"],
                 "expires_at": int(time.time() * 1000) + 75_000, "policy_revision": self.published_revision(), "query": query}
        with path.open("x") as stream:
            os.chmod(path, 0o644)
            json.dump(proof, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            result = self.run_runtime(nonce)
            authorize(self.policy(), actor, mutation and query.get("action") == "lanes.abandon")
            if query.get("kind") == "read" and query.get("section") == "audit" and isinstance(result, dict):
                records = result.get("records")
                if isinstance(records, list):
                    records.extend(self.configuration_audit(query))
                    pending = self.operations.audit(actor, query, self.reconcile,
                        {record["id"] for record in records if isinstance(record, dict) and isinstance(record.get("id"), str)})
                    replaced = {record["id"].removeprefix("owner-operation-") for record in pending}
                    records[:] = [record for record in records if isinstance(record, dict) and
                                  record.get("id") not in replaced and str(record.get("id", "")).removeprefix("config-") not in replaced]
                    records.extend(pending)
            return result
        finally:
            path.unlink(missing_ok=True)

    def configuration_audit(self, query: Mapping[str, Json]) -> list[Json]:
        path = self.settings.owner_home / ".config/helio/admin-config.sqlite"
        if not path.exists():
            return []
        filters = query.get("filters")
        filters = filters if isinstance(filters, dict) else {}
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            rows = db.execute("""SELECT id,actor,action,target,created_at,completed FROM changes
                                 ORDER BY created_at DESC,id DESC LIMIT 1000""").fetchall()
        records: list[Json] = []
        for identity, actor, action, target, created, completed in rows:
            state = "saved" if completed else "uncertain"
            record_id = "config-" + identity
            if query.get("target") not in (None, record_id):
                continue
            if any(value not in (None, "", "all", expected) for value, expected in (
                    (filters.get("user"), actor), (filters.get("action"), action), (filters.get("state"), state))):
                continue
            records.append({"id": record_id, "title": action, "user": actor, "revision": str(completed),
                            "state": state, "summary": f"<@{actor}> | {target}\n{state} | <t:{created}:R>",
                            "fields": [{"name": "Target", "value": target}, {"name": "Recorded", "value": f"<t:{created}:F>"}]})
        return records

    def run_runtime(self, nonce: str) -> Json:
        """Enter only the active scoped namespace, dropping to the agent UID before executing it."""
        candidates = []
        scope = Path("/sys/fs/cgroup/system.slice/helio-isolated.scope/cgroup.procs")
        try:
            pids = scope.read_text().split()
        except FileNotFoundError:
            raise Refused("unavailable", "The isolated Helio workspace is not running") from None
        for pid in pids:
            proc = Path("/proc") / pid
            try:
                command = (proc / "cmdline").read_bytes().split(b"\0")
                if (proc.stat().st_uid == self.settings.agent_uid and command[:2] ==
                    [b"/usr/bin/python3", b"/home/james/helio-agent/scripts/helio_isolated_start.py"]):
                    candidates.append(pid)
            except FileNotFoundError:
                continue
        if len(candidates) != 1:
            raise Refused("unavailable", "The active isolated runtime could not be identified uniquely")
        command = ["/usr/bin/nsenter", "--target", candidates[0], "--user", "--mount", "--net", "--pid",
                   "--setuid", str(self.settings.agent_uid), "--setgid", str(self.settings.agent_gid),
                   "--", "/usr/bin/env", "HOME=/home/james",
                   "PATH=/home/james/.local/bin:/home/james/.bun/bin:/usr/bin:/bin",
                   "DORI_POLICY_DIR=/home/james/.dori/elobot/policy",
                   "/bin/bash", "-c", 'source "$HOME/.dori/elobot/env"; exec "$HOME/.bun/bin/bun" "$HOME/.dori/discord-inbound/admin/runtime.ts" "$1"',
                   "helio-admin", nonce]
        try:
            payload = PROCESS["run_bounded"](command)
        except PROCESS["RuntimeFailure"] as error:
            raise Refused("uncertain", str(error)) from None
        try:
            response = json.loads(payload)
        except json.JSONDecodeError:
            raise Refused("uncertain", "The runtime returned an unreadable result; inspect the operation before repeating it") from None
        if not isinstance(response, dict) or response.get("ok") is not True:
            raise Refused(str(response.get("code", "invalid")) if isinstance(response, dict) else "invalid",
                          str(response.get("error", "Runtime operation refused")) if isinstance(response, dict) else "Invalid runtime response")
        return response.get("result")

    def configure(self, request: Mapping[str, Json], policy: PublicPolicy) -> Json:
        actor = string(request, "actor", 30)
        authorize(policy, actor, True)
        action = string(request, "action", 60)
        if action not in CONFIG_ACTIONS:
            raise Refused("invalid", "Unsupported configuration action")
        body = {name: string(request, name, 100) for name in ("operation", "actor", "expected", "action", "target", "value")}
        command = ["setpriv", "--reuid", str(self.settings.owner_uid), "--regid", str(self.settings.owner_gid),
                   "--clear-groups", "--no-new-privs", "/usr/bin/env",
                   f"HOME={self.settings.owner_home}", "PYTHONDONTWRITEBYTECODE=1",
                   "/opt/helio-beta-service/python/bin/python3.12", str(HERE / "helio_config.py"),
                   "--home", str(self.settings.owner_home), "change"]
        result = subprocess.run(command, input=json.dumps(body), capture_output=True, text=True, timeout=20)
        try:
            receipt = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise Refused("uncertain", "The configuration result is unknown; inspect the operation before repeating it") from None
        if result.returncode:
            raise Refused("changed", str(receipt.get("error", "Configuration change refused")))
        try:
            published = self.publish()
        except (OSError, RuntimeError, ValueError):
            receipt["application"] = "Saved; policy publication pending"
            return receipt
        receipt["application"] = "Saved; consumer application pending"
        receipt["published_revision"] = published["revision"]
        try:
            status = self.runtime({"actor": actor, "guild": published["values"]["HELIO_ADMIN_GUILD"],
                                   "operation": body["operation"], "query": {"kind": "read", "section": "settings",
                                   "target": "configuration", "filters": {}}}, published)
            application = status.get("application") if isinstance(status, dict) else None
            consumers = application.get("consumers") if isinstance(application, dict) else None
            if (isinstance(application, dict) and application.get("revision") == published["revision"] and
                isinstance(consumers, list) and len(consumers) == 3 and
                {consumer.get("name") for consumer in consumers if isinstance(consumer, dict)} == {"intake", "learning", "lanes"} and all(
                    isinstance(consumer, dict) and consumer.get("applied") is True for consumer in consumers)):
                receipt["application"] = "Saved and active"
        except Refused:
            receipt["application"] = "Saved; isolated consumer status unavailable"
        return receipt

    def reconcile(self, request: Mapping[str, Json]) -> dict[str, Json]:
        policy = self.policy()
        authorize(policy, string(request, "actor", 30), request.get("kind") == "configure")
        return RECOVERY["reconcile"](self.settings.owner_home, request, policy, self.configure, self.runtime)

    def dispatch(self, request: Mapping[str, Json]) -> Json:
        policy = self.policy()
        match request.get("kind"):
            case "policy":
                return dict(policy)
            case "publish":
                return dict(self.publish())
            case "configure":
                return self.configure(request, policy)
            case "runtime":
                return self.runtime(request, policy)
            case "operation":
                actor = string(request, "actor", 30)
                authorize(policy, actor)
                return self.operations.get(actor, string(request, "operation", 100), self.reconcile)
            case _:
                raise Refused("invalid", "Unknown administration request")

    def perform(self, request: Mapping[str, Json]) -> Json:
        query = request.get("query")
        mutation = request.get("kind") == "configure" or (
            isinstance(query, dict) and query.get("kind") == "mutate")
        if not mutation:
            return self.dispatch(request)
        policy = self.policy()
        actor = string(request, "actor", 30)
        authorize(policy, actor, request.get("kind") == "configure")
        return self.operations.perform(request, actor, self.dispatch, self.reconcile)

    def respond(self, request: Mapping[str, Json]) -> Json:
        try:
            return {"ok": True, "result": self.perform(request)}
        except Refused as error:
            return {"ok": False, "code": error.code, "error": str(error)}
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
            print(f"ADMIN_ERROR {type(error).__name__}", flush=True)
            return {"ok": False, "code": "uncertain", "error": "Administration failed; check the operation before repeating it"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, default=Path("/run/helio-admin-service/admin.sock"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("The owner-side broker requires root")
    owner, agent = pwd.getpwnam("james"), pwd.getpwnam("helio-agent")
    settings = Settings(Path(owner.pw_dir), Path("/var/lib/helio-agent/home"),
                        Path("/var/lib/helio-runtime-policy"), Path("/var/lib/helio-admin-service"),
                        owner.pw_uid, owner.pw_gid, agent.pw_uid, agent.pw_gid)
    SOCKET["serve"](args.socket, settings.owner_uid, AdminService(settings).respond)


if __name__ == "__main__":
    main()
