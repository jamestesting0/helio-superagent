"""Seed planning sources through the actual intake schema without live policy."""
import os
from pathlib import Path
import subprocess


def stage_source(state: Path, payload: str) -> None:
    root = Path(__file__).resolve().parent.parent
    code = (
        "import {Delivery} from " + repr(str(root / "discord-inbound/delivery/delivery.ts")) + ";"
        "const q=new Delivery(process.argv.at(-2)), payload=process.argv.at(-1), value=JSON.parse(payload);"
        "if(!q.contains('inbound',value.message_id))q.stage('inbound',value.message_id,payload);q.close();"
    )
    env = {**os.environ, "HOME": str(state.parent)}
    env.pop("DORI_POLICY_DIR", None)
    subprocess.run([str(Path.home() / ".bun/bin/bun"), "--eval", code,
                    str(state / "discord-delivery.sqlite"), payload],
                   env=env, check=True, capture_output=True, text=True)
