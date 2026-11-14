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

ADMIN_BUNDLE = (
    "helio_isolated_launcher.py", "helio_isolated_admin.py", "helio_deploy_plan.py",
    "helio_owner_policy.py", "helio_state_backup.py", "helio_doctor.py", "helio_health.py",
    "helio_admin_service.py", "helio_admin_controller.py", "helio_config.py",
    "helio_admin_journal.py", "helio_admin_process.py", "helio_admin_socket.py",
    "helio_admin_recovery.py", "helio_admin_lifecycle.py", "helio_admin_install.py", "helio_root_bundle.py",
)
BUNDLE = ("helio-beta.py", "helio_beta_backup.py", "helio_beta_broker.py", "helio_beta_service.py",
          "helio_beta_vault.py", "helio_release_service.py", "helio_approval.py", "helio_discord_text.py", *ADMIN_BUNDLE)
TARGET = Path("/opt/helio-beta-service/scripts")
UNITS = ("helio-release.service", "helio-beta-maintenance.service", "helio-admin.service", "helio-admin-controller.service")
UNIT_TARGET = Path("/etc/systemd/system")
BACKUPS = Path("/var/lib/helio-agent-backups/brokers")
INSTALL = "sudo python3 ~/PythonProjects/helio-superagent/scripts/helio_root_bundle.py --apply"


def files(source: Path, administration_only: bool = False) -> dict[str, tuple[Path, Path]]:
    """Every protected file this bundle installs: name -> (kit source, installed destination)."""
    selected = ADMIN_BUNDLE if administration_only else BUNDLE
    units = tuple(name for name in UNITS if name.startswith("helio-admin")) if administration_only else UNITS
    mapping = {name: (source / name, TARGET / name) for name in selected}
    mapping.update({name: (source.parent / "isolation/systemd" / name, UNIT_TARGET / name) for name in units})
    mapping["helio.env.example"] = (source.parent / "helio.env.example", TARGET.parent / "helio.env.example")
    return mapping


def drift(source: Path) -> list[str]:
    """Protected files whose installed copy differs from the kit; read-only, so deploy and doctor can report it."""
    return sorted(name for name, (path, target) in files(source).items()
                  if path.is_file() and (not target.is_file() or target.read_bytes() != path.read_bytes()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--administration-only", action="store_true",
                        help="Install administration/startup helpers without changing or restarting beta/release services")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run this owner-side installer as root.")
    source = Path(__file__).resolve().parent
    content = {}
    destinations = {name: target for name, (_, target) in files(source).items()}
    for name, (path, _) in files(source, args.administration_only).items():
        if path.is_symlink() or not path.is_file():
            parser.error(f"Source is not a regular file: {name}")
        content[name] = path.read_bytes()
    changed = [name for name, data in content.items() if not destinations[name].exists() or destinations[name].read_bytes() != data]
    installed = {name: hashlib.sha256(content[name] if name in content else path.read_bytes()).hexdigest()
                 for name, path in destinations.items() if name in content or path.is_file()}
    version = hashlib.sha256(json.dumps(installed, sort_keys=True).encode()).hexdigest()[:16]
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
    (TARGET / "bundle-version.json").write_text(json.dumps({"version": version, "files": installed}, indent=2))
    # Stop no services until all files are installed; production EloBot is never touched.
    if any(name in changed for name in UNITS):
        subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=30)
    if any(name in changed for name in ("helio_release_service.py", "helio_approval.py", "helio_discord_text.py", "helio-release.service")):
        subprocess.run(["systemctl", "restart", "helio-release.service"], check=True, timeout=30)
    if any(name in changed for name in ("helio-beta.py", "helio_beta_backup.py", "helio_beta_broker.py", "helio_beta_service.py", "helio_beta_vault.py", "helio-beta-maintenance.service")):
        subprocess.run(["systemctl", "restart", "helio-beta-maintenance.service"], check=True, timeout=30)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
