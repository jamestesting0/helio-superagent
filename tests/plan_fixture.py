"""Seed planning sources through the actual intake schema without live policy."""
from __future__ import annotations
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH

import os
from pathlib import Path
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from helio_pr_verification import Suite


def verified_suite(run: int = 5) -> Suite:
    """The injected suite boundary reports its new structured successful result."""
    return {"counts": {"run": run, "failures": 0, "errors": 0, "skips": 0, "unexpected": 0},
            "inputs": {"python": "/test/python", "version": "test interpreter",
                       "distributions_sha256": "a" * 64, "manifests": {}, "runner_sha256": "b" * 64},
            "started_at": 1.0, "finished_at": 2.0, "regressions": []}


def stage_source(state: Path, payload: str) -> None:
    root = Path(__file__).resolve().parent.parent
    code = (
        "import {Delivery} from " + repr(str(root / "discord-inbound/delivery/delivery.ts")) + ";"
        "const q=new Delivery(process.argv.at(-2)), payload=process.argv.at(-1), value=JSON.parse(payload);"
        "if(!q.contains('inbound',value.message_id))q.stage('inbound',value.message_id,payload);q.close();"
    )
    env = {**os.environ, "HOME": str(state.parent)}
    env.pop("DORI_POLICY_DIR", None)
    subprocess.run([hermetic.BUN, "--eval", code,
                    str(state / "discord-delivery.sqlite"), payload],
                   env=env, check=True, capture_output=True, text=True)
