"""Resolve owner operation outcomes from the journals that own the actual changes."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import closing
import json
from pathlib import Path
import sqlite3

type Json = str | int | float | bool | None | list[Json] | dict[str, Json]
type Dispatch = Callable[[Mapping[str, Json], Mapping[str, Json]], Json]


def reconcile(home: Path, request: Mapping[str, Json], policy: Mapping[str, Json],
              configure: Dispatch, runtime: Dispatch) -> dict[str, Json]:
    if request["kind"] == "configure":
        path = home / ".config/helio/admin-config.sqlite"
        if not path.exists():
            return {"status": "uncertain", "result": None}
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute("SELECT request,result,completed FROM changes WHERE id=? AND actor=?",
                             (request["operation"], request["actor"])).fetchone()
        expected = json.dumps([request[name] for name in ("actor", "expected", "action", "target", "value")], separators=(",", ":"))
        if not row or row[0] != expected:
            return {"status": "uncertain", "result": None}
        if not row[2]:
            # The canonical transaction already owns this operation; its idempotent
            # completion can finish derived writes without creating a second change.
            return {"status": "done", "result": configure(request, policy)}
        receipt = json.loads(row[1])
        receipt["application"] = "Saved; inspect current configuration application status"
        return {"status": "done", "result": receipt}
    query = request.get("query")
    if request.get("kind") != "runtime" or not isinstance(query, dict) or query.get("kind") != "mutate":
        return {"status": "uncertain", "result": None}
    inspected = runtime({**request, "query": {**query, "kind": "receipt"}}, policy)
    if not isinstance(inspected, dict) or not isinstance(inspected.get("receipt"), dict):
        return {"status": "uncertain", "result": None}
    receipt = inspected["receipt"]
    if receipt.get("status") == "done" and isinstance(receipt.get("outcome"), dict):
        return {"status": "done", "result": receipt["outcome"]}
    if receipt.get("status") == "refused":
        return {"status": "refused", "result": {"error": receipt.get("error", "The operation was refused"), "code": "invalid"}}
    return {"status": "uncertain", "result": None}
