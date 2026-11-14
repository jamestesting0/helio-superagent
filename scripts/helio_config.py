#!/usr/bin/env python3
"""Turn the one user-edited ~/.config/helio/helio.env into the files Helio reads.

    python3 scripts/helio_config.py init [--from-installed]   create helio.env (never overwrites)
    python3 scripts/helio_config.py check                     validate helio.env
    python3 scripts/helio_config.py render [--apply]          preview / write generated files

`helio update` runs `render` before updating managed files, so normally you only
edit helio.env and run `helio update`. Values are never printed, only key names.
"""
from __future__ import annotations

import argparse
from collections.abc import Iterator, Mapping
from contextlib import closing, contextmanager
import fcntl
import hashlib
import json
import os
import re
import shlex
import sqlite3
import socket
import struct
import pwd
import sys
import tempfile
import time
from pathlib import Path
from typing import Final, TypedDict

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "helio.env.example"
KEY = re.compile(r"[A-Z][A-Z0-9_]*")
ID = re.compile(r"\d{5,30}")

SECRETS = ("DORI_DISCORD_TOKEN", "BOT_BETA_TOKEN", "COC_API_PASSWORD", "HELPER_API_KEY", "HELIO_BETA_MONGO_URL")
ID_LISTS = ("DORI_DISCORD_ALLOWED", "DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS",
            "HELIO_REPORT_CHANNELS", "HELIO_TRUSTED_USERS", "HELIO_RELEASE_APPROVERS",
            "DORI_DISCORD_CONTEXT_EXCLUDED", "DORI_DISCORD_IGNORED_CHANNELS")
IDS = ("DORI_DISCORD_OWNER_ID", "HELIO_ADMIN_GUILD", "DORI_DISCORD_SCOPE_CATEGORY", "DORI_DISCORD_CONTEXT", "HELIO_NEVER_LEARN_CATEGORY",
       "HELIO_BUG_REPORT_BOT", "HELIO_BUG_REPORT_CHANNEL", "HELIO_TEST_CHANNEL", "HELIO_TEST_CATEGORY",
       "HELIO_STAFF_CHAT")
PATHS = ("HELIO_PROJECT", "HELIO_BROWSER_SKILL")
FLAGS = ("HELIO_ANSWER_FOR_OWNER", "HELIO_AUTOFIX", "HELIO_PR_CUSTODY")
CHOICES = {"HELIO_LANE_PROFILE": ("direct", "thorough")}
COUNTS = ("HELIO_OWNER_PRESENT_MINUTES", "HELIO_AUTOFIX_MAX_LINES", "HELIO_AUTOFIX_MAX_FILES", "HELIO_AUTOFIX_MAX_OPEN",
          "HELIO_PING_LIMIT_PER_HOUR", "HELIO_AUTOBLOCK_STRIKES", "HELIO_AUTOBLOCK_WINDOW_H", "HELIO_MAX_WORKERS",
          "HELIO_HIBERNATE_AFTER_MIN", "HELIO_CONVERSATION_TIMEOUT_HOURS")
# Settings that no longer do anything; an existing helio.env may still contain them and keeps loading.
RETIRED = ("HELIO_CONVERSATION_NUDGE_HOURS",)
COUNT = re.compile(r"[1-9][0-9]{0,4}")
# Repository-relative globs: no spaces, absolute paths or parent references.
GLOB = re.compile(r"(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9_.*?/\[\]-]+")
# Exported into ~/.dori/elobot/env, in this order. Everything the lead, workers,
# wrappers and prompt templates need; never the beta secrets.
RUNTIME = ("DORI_DISCORD_TOKEN", "DORI_DISCORD_OWNER_ID", "HELIO_ADMIN_GUILD", "DORI_DISCORD_SCOPE_CATEGORY", "DORI_DISCORD_ALLOWED",
           "DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS", "DORI_DISCORD_CONTEXT",
           "DORI_DISCORD_CONTEXT_EXCLUDED", "DORI_DISCORD_IGNORED_CHANNELS", "DORI_DISCORD_BUG_REPORT_SOURCE",
           "HELIO_PROJECT", "HELIO_GITHUB_REPO", "HELIO_TEST_CHANNEL", "HELIO_TEST_CATEGORY",
           "HELIO_NEVER_LEARN_CATEGORY", "HELIO_BUG_REPORT_BOT", "HELIO_BUG_REPORT_CHANNEL", "HELIO_STAFF_CHAT",
           "HELIO_LEAD_MODEL", "HELIO_LEAD_THINKING", "HELIO_WORKER_MODEL", "HELIO_MODEL_ALLOW",
           "HELIO_BROWSER_SKILL", *FLAGS, *CHOICES, *COUNTS, "HELIO_AUTOFIX_DENY")
BETA = (("BOT_BETA_TOKEN", "BOT_BETA_TOKEN"), ("COC_API_EMAIL", "COC_API_EMAIL"),
        ("COC_API_PASSWORD", "COC_API_PASSWORD"), ("MONGO_DB_URL", "HELIO_BETA_MONGO_URL"),
        ("HELPER_API_BASE_URL", "HELPER_API_BASE_URL"), ("HELPER_API_KEY", "HELPER_API_KEY"))
LISTS = (("trusted-users", "HELIO_TRUSTED_USERS"), ("report-channels", "HELIO_REPORT_CHANNELS"),
         ("release-approvers", "HELIO_RELEASE_APPROVERS"))
POLICY_KEYS: Final = tuple(key for key in RUNTIME if key not in SECRETS) + tuple(key for _, key in LISTS)
TIMING: Final = {
    "HELIO_CONVERSATION_TIMEOUT_HOURS": ("Conversation timeout", "hours", 1, 99999),
    "HELIO_PING_LIMIT_PER_HOUR": ("Ping limit", "per hour", 1, 99999),
    "HELIO_AUTOBLOCK_STRIKES": ("Automatic block threshold", "pings", 1, 99999),
    "HELIO_AUTOBLOCK_WINDOW_H": ("Automatic block window", "hours", 1, 24),
    "HELIO_MAX_WORKERS": ("Worker capacity", "workers", 1, 99999),
    "HELIO_HIBERNATE_AFTER_MIN": ("Worker hibernation", "minutes; 0 disables", 0, 99999),
}


class TimingSetting(TypedDict):
    key: str
    label: str
    unit: str
    minimum: int
    maximum: int


class PolicySnapshot(TypedDict):
    version: int
    revision: str
    values: dict[str, str]
    timing: list[TimingSetting]


class ConfigReceipt(TypedDict):
    operation: str
    revision: str
    changed_keys: list[str]
    status: str


class ConfigConflict(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def config_path(home: Path) -> Path:
    return home / ".config/helio/helio.env"


def parse(text: str, strict: bool = True) -> dict[str, str]:
    values: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        if not sep or not KEY.fullmatch(key):
            if not strict:
                continue
            raise ValueError(f"line {number}: expected KEY=value")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def defaults() -> dict[str, str]:
    return parse(EXAMPLE.read_text())


def expand(value: str, home: Path) -> str:
    if value == "~" or value.startswith("~/"):
        value = str(home) + value[1:]
    return value.replace("${HOME}", str(home)).replace("$HOME", str(home))


def resolve(values: dict[str, str], home: Path) -> dict[str, str]:
    merged = {**defaults(), **{key: value for key, value in values.items() if key not in RETIRED}}
    for key in PATHS:
        merged[key] = expand(merged[key], home)
    merged["DORI_DISCORD_BUG_REPORT_SOURCE"] = f"{merged['HELIO_BUG_REPORT_BOT']}:{merged['HELIO_BUG_REPORT_CHANNEL']}"
    return merged


def problems(values: dict[str, str], require_secrets: bool = True) -> list[str]:
    found = []
    unknown = sorted(set(values) - set(defaults()) - set(RETIRED))
    if unknown:
        found.append("unknown keys (typo?): " + ", ".join(unknown))
    merged = {**defaults(), **values}
    for key in IDS:
        if not ID.fullmatch(merged.get(key, "")):
            found.append(f"{key} must be one Discord ID")
    for key in ID_LISTS:
        items = [x for x in merged.get(key, "").split(",") if x]
        if any(not ID.fullmatch(x) for x in items):
            found.append(f"{key} must be comma-separated Discord IDs without spaces")
    for key in FLAGS:
        if merged.get(key) not in ("on", "off"):
            found.append(f"{key} must be on or off")
    for key, allowed in CHOICES.items():
        if merged.get(key) not in allowed:
            found.append(f"{key} must be one of: {', '.join(allowed)}")
    for key in COUNTS:
        if key == "HELIO_HIBERNATE_AFTER_MIN" and merged.get(key) == "0":
            continue
        if not COUNT.fullmatch(merged.get(key, "")):
            found.append(f"{key} must be a positive whole number" + (" or 0 to disable hibernation" if key == "HELIO_HIBERNATE_AFTER_MIN" else ""))
    if not all(GLOB.fullmatch(item) for item in merged.get("HELIO_AUTOFIX_DENY", "").split(",")):
        found.append("HELIO_AUTOFIX_DENY must be comma-separated repository paths or globs without spaces")
    allowed = set(merged["DORI_DISCORD_ALLOWED"].split(","))
    for key in ("DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS"):
        missing = [x for x in merged[key].split(",") if x and x not in allowed]
        if missing:
            found.append(f"{key} lists channels missing from DORI_DISCORD_ALLOWED")
    if set(merged["DORI_DISCORD_TRUSTED_CHANNELS"].split(",")) & set(merged["DORI_DISCORD_NORMAL_CHANNELS"].split(",")) - {""}:
        found.append("Trusted and normal channel lists must not overlap")
    window = merged["HELIO_AUTOBLOCK_WINDOW_H"]
    if COUNT.fullmatch(window) and int(window) > 24:
        found.append("HELIO_AUTOBLOCK_WINDOW_H cannot exceed the 24-hour strike retention window")
    if require_secrets:
        for key in SECRETS:
            if not merged.get(key):
                found.append(f"{key} is empty")
    return found


def export_line(key: str, value: str) -> str:
    return f"export {key}={shlex.quote(value)}"


def generate(values: dict[str, str], home: Path) -> dict[str, tuple[bytes, int]]:
    v = resolve(values, home)
    header = "# Generated from ~/.config/helio/helio.env by `helio update`. Do not edit.\n"
    env = [header.rstrip("\n")]
    env += [export_line(k, v[k]) for k in RUNTIME]
    env += ['export DORI_CONFIG="$HOME/.dori/elobot/config.json"', 'export DORI_STATE_DIR="$HOME/.dori/elobot/state"']
    files = {"env": (("\n".join(env) + "\n").encode(), 0o600)}
    beta = header + "".join(f"{name}={v[key]}\n" for name, key in BETA)
    files["beta.env"] = (beta.encode(), 0o600)
    files["beta-mongo.env"] = ((header + f"MONGO_DB_URL={v['HELIO_BETA_MONGO_URL']}\n").encode(), 0o600)
    for name, key in LISTS:
        files[name] = ((v[key] + "\n").encode(), 0o644)
    snapshot = policy_snapshot(values, home)
    files["policy/policy.json"] = ((json.dumps(snapshot, sort_keys=True) + "\n").encode(), 0o644)
    files["policy/lane-settings.json"] = ((json.dumps({"revision": snapshot["revision"],
        "maxWorkers": int(v["HELIO_MAX_WORKERS"]), "hibernateAfterMin": int(v["HELIO_HIBERNATE_AFTER_MIN"]),
        "prCustody": v["HELIO_PR_CUSTODY"] == "on", "laneProfile": v["HELIO_LANE_PROFILE"]}) + "\n").encode(), 0o644)
    return files


def policy_snapshot(values: Mapping[str, str], home: Path) -> PolicySnapshot:
    resolved = resolve(dict(values), home)
    public = {key: resolved[key] for key in POLICY_KEYS}
    revision = hashlib.sha256(json.dumps(public, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    timing: list[TimingSetting] = [{"key": key, "label": label, "unit": unit, "minimum": minimum, "maximum": maximum}
                                  for key, (label, unit, minimum, maximum) in TIMING.items()]
    return {"version": 1, "revision": revision, "values": public, "timing": timing}


def policy_revision(values: Mapping[str, str], home: Path) -> str:
    return policy_snapshot(values, home)["revision"]


@contextmanager
def settings_lock(home: Path) -> Iterator[None]:
    path = config_path(home).with_suffix(".lock")
    with path.open("a") as stream:
        os.chmod(path, 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def atomic(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".helio-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load(home: Path) -> dict[str, str]:
    path = config_path(home)
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"Missing {path}. Create it with: python3 scripts/helio_config.py init")
    if path.stat().st_mode & 0o077:
        raise SystemExit(f"{path} must be private: chmod 600 {path}")
    try:
        return parse(path.read_text())
    except ValueError as error:
        raise SystemExit(f"{path}: {error}") from None


def render(home: Path, apply: bool) -> int:
    if not apply:
        return render_locked(home, False)
    with settings_lock(home):
        changed = render_locked(home, True)
    notify_policy(home)
    return changed


def notify_policy(home: Path) -> None:
    """Owner CLI renders publish through the same privileged boundary as Discord edits."""
    path = Path("/run/helio-admin-service/admin.sock")
    if home.resolve() != Path(pwd.getpwuid(os.getuid()).pw_dir).resolve() or not path.exists():
        return
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(4)
            connection.connect(str(path))
            data = b'{"kind":"publish"}'
            connection.sendall(struct.pack("!I", len(data)) + data)
            received = bytearray()
            while len(received) < 4 or len(received) < 4 + struct.unpack("!I", received[:4])[0]:
                chunk = connection.recv(65536)
                if not chunk or len(received) > 100_000:
                    raise OSError("Incomplete publication receipt")
                received.extend(chunk)
            if json.loads(received[4:]).get("ok") is not True:
                raise OSError("Publication refused")
    except (OSError, ValueError):
        print("Saved; administration policy publication pending", file=sys.stderr)


def render_locked(home: Path, apply: bool) -> int:
    values = load(home)
    issues = problems(values)
    if issues:
        message = "helio.env is not ready; nothing written:\n  - " + "\n  - ".join(issues)
        if apply:
            raise SystemExit(message)
        print(message)
        return 0
    base = home / ".dori/elobot"
    changed = []
    for name, (data, mode) in generate(values, home).items():
        target = base / name
        if (name in dict(LISTS) and target.is_symlink() and os.readlink(target) == "policy/" + name and
            not (base / "policy").is_symlink() and target.is_file()):
            if target.read_bytes() != data:
                raise SystemExit("Isolated authorization is owner-published; update the owner's helio.env")
            continue
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise SystemExit(f"Unsafe generated file: {target}")
        if not target.exists() or target.read_bytes() != data or (target.stat().st_mode & 0o777) != mode:
            changed.append((name, data, mode))
    print("Generated from helio.env: " + (", ".join(n for n, _, _ in changed) if changed else "up to date"))
    if apply:
        for name, data, mode in changed:
            atomic(base / name, data, mode)
    return len(changed)


def change(home: Path, operation: str, actor: str, expected: str,
           action: str, target: str, value: str) -> ConfigReceipt:
    """Commit an owner setting once, recovering a crash between canonical and derived writes."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", operation):
        raise ConfigConflict("Invalid configuration operation")
    with settings_lock(home):
        values = load(home)
        current = policy_snapshot(values, home)
        if actor != current["values"]["DORI_DISCORD_OWNER_ID"]:
            raise ConfigConflict("Only the owner can change configuration")
        request = json.dumps([actor, expected, action, target, value], separators=(",", ":"))
        path = config_path(home).parent / "admin-config.sqlite"
        with closing(sqlite3.connect(path, timeout=5)) as db, db:
            path.chmod(0o600)
            db.execute("""CREATE TABLE IF NOT EXISTS changes (
                id TEXT PRIMARY KEY, request TEXT NOT NULL, before_revision TEXT NOT NULL,
                after_revision TEXT NOT NULL, patch TEXT NOT NULL, result TEXT NOT NULL,
                actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
                created_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0)""")
            row = db.execute("SELECT request,before_revision,after_revision,patch,result,completed FROM changes WHERE id=?",
                             (operation,)).fetchone()
            if row:
                if row[0] != request:
                    raise ConfigConflict("This operation was already used for a different change")
                if row[5]:
                    return json.loads(row[4])
                if current["revision"] not in (row[1], row[2]):
                    raise ConfigConflict("Configuration changed during this operation; refresh its preview")
                patch = json.loads(row[3])
                receipt = json.loads(row[4])
            else:
                if expected != current["revision"]:
                    raise ConfigConflict("Configuration changed; refresh its preview")
                patch = setting_patch(current["values"], action, target, value)
                candidate = {**values, **patch}
                issues = problems(candidate)
                if issues:
                    raise ConfigConflict("; ".join(issues))
                receipt: ConfigReceipt = {"operation": operation, "revision": policy_revision(candidate, home),
                                          "changed_keys": sorted(patch), "status": "saved"}
                db.execute("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?,?,0)",
                           (operation, request, current["revision"], receipt["revision"], json.dumps(patch),
                            json.dumps(receipt), actor, action, target, int(time.time())))
                db.commit()
            if current["revision"] != receipt["revision"]:
                lines = config_path(home).read_text().splitlines()
                written: set[str] = set()
                for index, line in enumerate(lines):
                    name = line.strip().removeprefix("export ").partition("=")[0]
                    if name in patch:
                        lines[index] = f"{name}={patch[name]}"
                        written.add(name)
                lines.extend(f"{name}={patch[name]}" for name in patch if name not in written)
                atomic(config_path(home), ("\n".join(lines) + "\n").encode(), 0o600)
            render_locked(home, True)
            db.execute("UPDATE changes SET completed=1 WHERE id=?", (operation,))
            return receipt


def setting_patch(values: Mapping[str, str], action: str, target: str, value: str) -> dict[str, str]:
    if action == "timeout.set":
        if target not in TIMING or not value.isascii() or not value.isdecimal():
            raise ConfigConflict("Unknown timing setting or invalid integer")
        _, _, minimum, maximum = TIMING[target]
        if not minimum <= int(value) <= maximum:
            raise ConfigConflict(f"Value must be between {minimum} and {maximum}")
        return {target: str(int(value))}
    if not ID.fullmatch(target):
        raise ConfigConflict("Expected a Discord user or channel ID")
    if action in ("trusted.add", "trusted.remove"):
        if target == values["DORI_DISCORD_OWNER_ID"]:
            raise ConfigConflict("The owner identity cannot be changed through trusted membership")
        members = set(filter(None, values["HELIO_TRUSTED_USERS"].split(",")))
        if action == "trusted.add":
            members.add(target)
        else:
            members.discard(target)
        return {"HELIO_TRUSTED_USERS": ",".join(sorted(members, key=int))}
    if action != "channels.set" or value not in ("normal", "trusted", "ignored"):
        raise ConfigConflict("Unsupported configuration change")
    if target in set(values["DORI_DISCORD_CONTEXT_EXCLUDED"].split(",")) | {values["HELIO_NEVER_LEARN_CATEGORY"]}:
        raise ConfigConflict("This channel is protected by a hard privacy exclusion")
    names = ("DORI_DISCORD_ALLOWED", "DORI_DISCORD_TRUSTED_CHANNELS",
             "DORI_DISCORD_NORMAL_CHANNELS", "DORI_DISCORD_IGNORED_CHANNELS")
    lists = {name: set(filter(None, values[name].split(","))) - {target} for name in names}
    if value == "ignored":
        lists["DORI_DISCORD_IGNORED_CHANNELS"].add(target)
    else:
        lists["DORI_DISCORD_ALLOWED"].add(target)
        lists["DORI_DISCORD_TRUSTED_CHANNELS" if value == "trusted" else "DORI_DISCORD_NORMAL_CHANNELS"].add(target)
    return {name: ",".join(sorted(items, key=int)) for name, items in lists.items()}


def from_installed(home: Path) -> dict[str, str]:
    base = home / ".dori/elobot"
    found: dict[str, str] = {}
    for name in ("env", "channel-policy.env"):
        if (base / name).is_file():
            found.update(parse((base / name).read_text(), strict=False))
    source = found.pop("DORI_DISCORD_BUG_REPORT_SOURCE", "")
    if ":" in source:
        found["HELIO_BUG_REPORT_BOT"], found["HELIO_BUG_REPORT_CHANNEL"] = source.split(":", 1)
    if (base / "beta.env").is_file():
        beta = parse((base / "beta.env").read_text())
        for name, key in BETA:
            if beta.get(name):
                found[key] = beta[name]
    if (base / "beta-mongo.env").is_file():
        url = parse((base / "beta-mongo.env").read_text()).get("MONGO_DB_URL")
        if url:
            found["HELIO_BETA_MONGO_URL"] = url
    for name, key in LISTS:
        if (base / name).is_file():
            found[key] = ",".join(x.strip() for x in (base / name).read_text().split(",") if x.strip())
    known = set(defaults())
    return {k: v for k, v in found.items() if k in known}


def init(home: Path, migrate: bool) -> None:
    path = config_path(home)
    if path.exists() or path.is_symlink():
        raise SystemExit(f"{path} already exists; edit it instead")
    values = from_installed(home) if migrate else {}
    lines = []
    for raw in EXAMPLE.read_text().splitlines():
        key = raw.partition("=")[0]
        if KEY.fullmatch(key) and "=" in raw and key in values:
            raw = f"{key}={values[key]}"
        lines.append(raw)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic(path, ("\n".join(lines) + "\n").encode(), 0o600)
    print(f"Created {path}" + (" from the installed files" if migrate else "") + ". Review it, then run: helio update")
    missing = [k for k in SECRETS if not ({**defaults(), **values}).get(k)]
    if missing:
        print("Still empty: " + ", ".join(missing))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", type=Path, default=Path.home())
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("init")
    p.add_argument("--from-installed", action="store_true", help="copy values from an existing ~/.dori/elobot")
    sub.add_parser("check")
    p = sub.add_parser("render")
    p.add_argument("--apply", action="store_true")
    sub.add_parser("change", help="read one structured owner operation from stdin")
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    if args.command == "init":
        init(home, args.from_installed)
    elif args.command == "check":
        issues = problems(load(home))
        print("helio.env OK" if not issues else "Problems:\n  - " + "\n  - ".join(issues))
        sys.exit(1 if issues else 0)
    elif args.command == "change":
        try:
            request = json.load(sys.stdin)
            if not isinstance(request, dict) or set(request) != {"operation", "actor", "expected", "action", "target", "value"} or not all(isinstance(value, str) for value in request.values()):
                raise ConfigConflict("Invalid configuration request")
            # stdout is the broker protocol; renderer diagnostics stay on stderr.
            from contextlib import redirect_stdout
            with redirect_stdout(sys.stderr):
                receipt = change(home, **request)
            print(json.dumps(receipt))
        except (ConfigConflict, json.JSONDecodeError) as error:
            print(json.dumps({"error": str(error)}))
            sys.exit(3)
    else:
        render(home, args.apply)


if __name__ == "__main__":
    main()
