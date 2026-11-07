"""Fixed host lifecycle operations for the administration companion services."""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import runpy
from typing import Final, Literal

UNIT: Final = "helio-admin-controller.service"
CONTROLLER: Final = Path("/opt/helio-admin-service/controller.js")
OBSERVATION: Final = Path("/var/lib/helio-admin-controller/commands.json")
SOURCES: Final = Path("/home/james/.dori/discord-inbound")
SOURCE_RECEIPT: Final = Path("/opt/helio-admin-service/controller-source.json")


@dataclass(frozen=True, slots=True)
class AdministrationStatus:
    state: Literal["not_installed", "disabled", "stopped", "starting", "active", "activation_pending"]
    installed_version: str = ""
    loaded_version: str = ""
    pid: int = 0
    dm: str = "unknown"
    guild: str = "unknown"
    dm_reason: str = ""
    guild_reason: str = ""
    checked_at_ms: float = 0
    dm_changes: str = ""
    guild_changes: str = ""
    staged_version: str = ""
    deployed_source_version: str = ""
    deployment_pending: bool = False


def status() -> AdministrationStatus:
    """Report staged source separately from the installed and running controller."""
    current = runtime_status()
    staged = runpy.run_path(str(Path(__file__).with_name("helio_admin_install.py")))["source_version"](SOURCES)
    try:
        receipt = json.loads(SOURCE_RECEIPT.read_text())
    except FileNotFoundError:
        receipt = {}
    deployed = receipt.get("source_sha256", "") if receipt.get("controller_sha256") == current.installed_version else ""
    return replace(current, staged_version=staged, deployed_source_version=deployed,
                   deployment_pending=bool(staged and staged != deployed))


def runtime_status() -> AdministrationStatus:
    """Bind the unprivileged observation to the actual systemd process."""
    if not CONTROLLER.is_file():
        return AdministrationStatus("not_installed")
    target = CONTROLLER.resolve(strict=True)
    version = hashlib.sha256(target.read_bytes()).hexdigest()
    result = subprocess.run(["systemctl", "show", UNIT, "-p", "ActiveState", "-p", "UnitFileState", "-p", "MainPID"],
                            capture_output=True, text=True, timeout=15, check=False)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if result.returncode or not fields.get("UnitFileState"):
        return AdministrationStatus("not_installed", installed_version=version)
    if fields.get("UnitFileState") not in ("enabled", "enabled-runtime"):
        return AdministrationStatus("disabled", installed_version=version)
    if fields.get("ActiveState") != "active":
        return AdministrationStatus("stopped", installed_version=version)
    pid = int(fields.get("MainPID", "0"))
    arguments = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    current_bundle = os.fsencode(target) in arguments
    pending = AdministrationStatus("starting" if current_bundle else "activation_pending",
                                   installed_version=version, loaded_version=version if current_bundle else "", pid=pid)
    try:
        descriptor = os.open(OBSERVATION, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "r") as stream:
            row = json.loads(stream.read(65536))
        if not isinstance(row, dict):
            return pending
        started = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
        if row.get("version") != 1 or row.get("supportsSync") is not True or row.get("pid") != pid or row.get("processStart") != started:
            return pending
        loaded = str(row["loadedVersion"])
        config = runpy.run_path(str(Path(__file__).with_name("helio_config.py")))
        credential = config["load"](Path("/home/james"))["DORI_DISCORD_TOKEN"]
        credential_current = row.get("credentialVersion") == hashlib.sha256(credential.encode()).hexdigest()
        dm, guild = row["dm"], row["guild"]
        return AdministrationStatus(
            state="active" if current_bundle and loaded == version and credential_current else "activation_pending",
            installed_version=version, loaded_version=loaded, pid=pid, dm=str(dm["state"]), guild=str(guild["state"]),
            dm_reason=str(dm.get("reason", "")), guild_reason=str(guild.get("reason", "")), checked_at_ms=float(row["checkedAt"]),
            dm_changes=json.dumps(dm.get("changes", {}), sort_keys=True),
            guild_changes=json.dumps(guild.get("changes", {}), sort_keys=True))
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return pending


def synchronize() -> AdministrationStatus:
    """Request the running publisher; never signal an incompatible old process."""
    current = status()
    if current.state == "active":
        descriptor = os.pidfd_open(current.pid)
        try:
            observed = status()
            if observed.state == "active" and observed.pid == current.pid and observed.loaded_version == current.loaded_version:
                signal.pidfd_send_signal(descriptor, signal.SIGHUP)
        finally:
            os.close(descriptor)
    return current


def activate() -> AdministrationStatus:
    """Load the deployed companion at an explicit Helio start/restart boundary."""
    current = status()
    if current.state in ("not_installed", "disabled"):
        return current
    if current.state == "stopped":
        subprocess.run(["systemctl", "start", UNIT], check=True, timeout=30)
        return replace(current, state="starting")
    if current.state == "activation_pending":
        subprocess.run(["systemctl", "restart", UNIT], check=True, timeout=30)
        return replace(current, state="starting")
    return synchronize()


def report(activate_controller: bool = False) -> None:
    """Report administration independently of the main workspace lifecycle."""
    try:
        current = activate() if activate_controller else synchronize()
        print("ADMINISTRATION " + json.dumps(asdict(current), sort_keys=True))
        if current.deployment_pending:
            print("Administration source awaits deployment: run `helio deploy` before activating it.")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print("ADMINISTRATION " + json.dumps({"state": "unavailable", "error": type(error).__name__}))
