"""Durable owner-side administration operations and replay protection."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time

type Json = str | int | float | bool | None | list[Json] | dict[str, Json]


class Refused(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Operations:
    def __init__(self, state: Path) -> None:
        self.state = state
        self.path = state / "operations.sqlite"

    def get(self, actor: str, operation: str,
            reconcile: Callable[[Mapping[str, Json]], dict[str, Json]] | None = None) -> dict[str, Json]:
        if not self.path.exists():
            raise Refused("invalid", "Unknown administration operation")
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute("SELECT actor,status,result,request FROM operations WHERE id=?", (operation,)).fetchone()
        if not row or row[0] != actor:
            raise Refused("denied", "This operation does not belong to you")
        receipt = {"status": row[1], "result": json.loads(row[2]) if row[2] else None}
        if reconcile is not None:
            resolved = reconcile(json.loads(row[3]))
            if resolved["status"] in ("done", "refused"):
                with closing(sqlite3.connect(self.path)) as db, db:
                    db.execute("UPDATE operations SET status=?,result=? WHERE id=?",
                               (resolved["status"], json.dumps(resolved["result"]), operation))
                return resolved
        return receipt

    def audit(self, actor: str, query: Mapping[str, Json],
              reconcile: Callable[[Mapping[str, Json]], dict[str, Json]], visible: set[str]) -> list[Json]:
        if not self.path.exists():
            return []
        target = query.get("target")
        operation = target.removeprefix("owner-operation-") if isinstance(target, str) and target.startswith("owner-operation-") else None
        if operation is not None:
            try:
                self.get(actor, operation, reconcile)
            except Refused as error:
                if error.code != "denied":
                    raise
                return []
        filters = query.get("filters")
        filters = filters if isinstance(filters, dict) else {}
        with closing(sqlite3.connect(self.path)) as db:
            rows = db.execute("""SELECT id,request,status,result,created_at FROM operations
                WHERE actor=? AND (status IN ('running','uncertain') OR id=?) ORDER BY created_at DESC,id LIMIT 1000""",
                              (actor, operation)).fetchall()
        records: list[Json] = []
        for identity, raw, status, raw_result, created in rows:
            request = json.loads(raw)
            action = request.get("action") if request["kind"] == "configure" else request["query"]["action"]
            selected = request.get("target") if request["kind"] == "configure" else request["query"]["target"]
            if target not in (None, "owner-operation-" + identity) or any(
                    filters.get(key) not in (None, "", "all", value) for key, value in (("user", actor), ("action", action), ("state", status))):
                continue
            outcome = json.loads(raw_result) if raw_result else {}
            target_visible = request["kind"] == "configure" or identity in visible or operation == identity
            detail = (outcome.get("notice") or outcome.get("application") or outcome.get("error")) if target_visible else None
            detail = detail or "Open or refresh this item to check its authoritative receipt."
            records.append({"id": "owner-operation-" + identity, "title": action, "user": actor, "state": status,
                            "revision": status, "summary": f"{status} | <t:{created}:R>",
                            "fields": [{"name": "Operation", "value": identity}, {"name": "Target", "value": selected if target_visible else "Visibility must be rechecked"},
                                       {"name": "Outcome", "value": detail}]})
        return records

    def perform(self, request: Mapping[str, Json], actor: str,
                dispatch: Callable[[Mapping[str, Json]], Json],
                reconcile: Callable[[Mapping[str, Json]], dict[str, Json]] | None = None) -> Json:
        operation = request.get("operation")
        if not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", operation):
            raise Refused("invalid", "Invalid administration operation ID")
        fingerprint = json.dumps(request, sort_keys=True, separators=(",", ":"))
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=5)) as db:
            self.path.chmod(0o600)
            db.execute("""CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY, actor TEXT NOT NULL, request TEXT NOT NULL,
                status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL)""")
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT actor,request,status,result FROM operations WHERE id=?", (operation,)).fetchone()
            if row:
                db.rollback()
                if row[0] != actor or row[1] != fingerprint:
                    raise Refused("denied", "This operation ID was already used")
                if row[2] == "done":
                    return json.loads(row[3])
                receipt = self.get(actor, operation, reconcile)
                if receipt["status"] == "done":
                    return receipt["result"]
                raise Refused("uncertain", "This operation is already recorded; check its result instead of repeating it")
            db.execute("INSERT INTO operations VALUES (?,?,?,'running',NULL,?)",
                       (operation, actor, fingerprint, int(time.time())))
            db.commit()
            try:
                result = dispatch(request)
            except Refused as error:
                db.execute("UPDATE operations SET status=?,result=? WHERE id=? AND status IN ('running','uncertain')",
                           ("uncertain" if error.code == "uncertain" else "refused",
                            json.dumps({"error": str(error), "code": error.code}), operation))
                db.commit()
                raise
            except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
                db.execute("UPDATE operations SET status='uncertain' WHERE id=? AND status IN ('running','uncertain')", (operation,))
                db.commit()
                raise Refused("uncertain", "The administration operation outcome must be checked before another change") from error
            db.execute("UPDATE operations SET status='done',result=? WHERE id=?", (json.dumps(result), operation))
            db.commit()
            return result
