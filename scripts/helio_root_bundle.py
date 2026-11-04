#!/usr/bin/env python3
"""Explicit owner-run update of the root broker bundle; never changes Oracle."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

BUNDLE = (
    "helio-beta.py", "helio_beta_backup.py", "helio_beta_broker.py", "helio_beta_service.py",
    "helio_beta_vault.py", "helio_isolated_launcher.py", "helio_release_service.py",
    "helio_approval.py", "helio_isolated_admin.py", "helio_deploy_plan.py",
    "helio_owner_policy.py", "helio_state_backup.py",
)
TARGET = Path("/opt/helio-beta-service/scripts")
UNITS = ("helio-release.service", "helio-beta-maintenance.service")
UNIT_TARGET = Path("/etc/systemd/system")
BACKUPS = Path("/var/lib/helio-agent-backups/brokers")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run this owner-side installer as root.")
    source = Path(__file__).resolve().parent
    content = {}
    destinations = {name: TARGET / name for name in BUNDLE}
    destinations.update({name: UNIT_TARGET / name for name in UNITS})
    for name in (*BUNDLE, *UNITS):
        path = source / name if name in BUNDLE else source.parent / "isolation/systemd" / name
        if path.is_symlink() or not path.is_file():
            parser.error(f"Source is not a regular file: {name}")
        content[name] = path.read_bytes()
    changed = [name for name, data in content.items() if not destinations[name].exists() or destinations[name].read_bytes() != data]
    version = hashlib.sha256(b"".join(content.values())).hexdigest()[:16]
    print(json.dumps({"bundle_version": version, "changed": changed, "applied": args.apply}))
    if not args.apply:
        return 0
    backup = BACKUPS / datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup.mkdir(parents=True, mode=0o700)
    TARGET.mkdir(parents=True, mode=0o755, exist_ok=True)
    UNIT_TARGET.mkdir(parents=True, mode=0o755, exist_ok=True)
    for name in changed:
        target = destinations[name]
        if target.exists():
            shutil.copyfile(target, backup / name)
            (backup / name).chmod(0o600)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
            stream.write(content[name])
            temporary = Path(stream.name)
        temporary.chmod(0o644)
        temporary.replace(target)
    (TARGET / "bundle-version.json").write_text(json.dumps({"version": version, "files": {
        name: hashlib.sha256(data).hexdigest() for name, data in content.items()}}, indent=2))
    # Stop no services until all files are installed; production EloBot is never touched.
    if any(name in changed for name in UNITS):
        subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=30)
    if any(name in changed for name in ("helio_release_service.py", "helio_approval.py", "helio-release.service")):
        subprocess.run(["systemctl", "restart", "helio-release.service"], check=True, timeout=30)
    if any(name in changed for name in ("helio-beta.py", "helio_beta_backup.py", "helio_beta_broker.py", "helio_beta_service.py", "helio_beta_vault.py", "helio-beta-maintenance.service")):
        subprocess.run(["systemctl", "restart", "helio-beta-maintenance.service"], check=True, timeout=30)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
