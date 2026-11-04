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
import os
import re
import shlex
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "helio.env.example"
KEY = re.compile(r"[A-Z][A-Z0-9_]*")
ID = re.compile(r"\d{5,30}")

SECRETS = ("DORI_DISCORD_TOKEN", "BOT_BETA_TOKEN", "COC_API_PASSWORD", "HELPER_API_KEY", "HELIO_BETA_MONGO_URL")
ID_LISTS = ("DORI_DISCORD_ALLOWED", "DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS",
            "HELIO_REPORT_CHANNELS", "HELIO_TRUSTED_USERS", "HELIO_RELEASE_APPROVERS",
            "DORI_DISCORD_CONTEXT_EXCLUDED", "DORI_DISCORD_IGNORED_CHANNELS")
IDS = ("DORI_DISCORD_OWNER_ID", "DORI_DISCORD_SCOPE_CATEGORY", "DORI_DISCORD_CONTEXT", "HELIO_NEVER_LEARN_CATEGORY",
       "HELIO_BUG_REPORT_BOT", "HELIO_BUG_REPORT_CHANNEL", "HELIO_TEST_CHANNEL", "HELIO_TEST_CATEGORY",
       "HELIO_STAFF_CHAT")
PATHS = ("HELIO_PROJECT", "HELIO_BROWSER_SKILL")
FLAGS = ("HELIO_ANSWER_FOR_OWNER", "HELIO_AUTOFIX")
COUNTS = ("HELIO_OWNER_PRESENT_MINUTES", "HELIO_AUTOFIX_MAX_LINES", "HELIO_AUTOFIX_MAX_FILES", "HELIO_AUTOFIX_MAX_OPEN")
COUNT = re.compile(r"[1-9][0-9]{0,4}")
# Repository-relative globs: no spaces, absolute paths or parent references.
GLOB = re.compile(r"(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9_.*?/\[\]-]+")
# Exported into ~/.dori/elobot/env, in this order. Everything the lead, workers,
# wrappers and prompt templates need; never the beta secrets.
RUNTIME = ("DORI_DISCORD_TOKEN", "DORI_DISCORD_OWNER_ID", "DORI_DISCORD_SCOPE_CATEGORY", "DORI_DISCORD_ALLOWED",
           "DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS", "DORI_DISCORD_CONTEXT",
           "DORI_DISCORD_CONTEXT_EXCLUDED", "DORI_DISCORD_IGNORED_CHANNELS", "DORI_DISCORD_BUG_REPORT_SOURCE",
           "HELIO_PROJECT", "HELIO_GITHUB_REPO", "HELIO_TEST_CHANNEL", "HELIO_TEST_CATEGORY",
           "HELIO_NEVER_LEARN_CATEGORY", "HELIO_BUG_REPORT_BOT", "HELIO_BUG_REPORT_CHANNEL", "HELIO_STAFF_CHAT",
           "HELIO_LEAD_MODEL", "HELIO_LEAD_THINKING", "HELIO_WORKER_MODEL", "HELIO_MODEL_ALLOW",
           "HELIO_BROWSER_SKILL", *FLAGS, *COUNTS, "HELIO_AUTOFIX_DENY")
BETA = (("BOT_BETA_TOKEN", "BOT_BETA_TOKEN"), ("COC_API_EMAIL", "COC_API_EMAIL"),
        ("COC_API_PASSWORD", "COC_API_PASSWORD"), ("MONGO_DB_URL", "HELIO_BETA_MONGO_URL"),
        ("HELPER_API_BASE_URL", "HELPER_API_BASE_URL"), ("HELPER_API_KEY", "HELPER_API_KEY"))
LISTS = (("trusted-users", "HELIO_TRUSTED_USERS"), ("report-channels", "HELIO_REPORT_CHANNELS"),
         ("release-approvers", "HELIO_RELEASE_APPROVERS"))


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
    merged = {**defaults(), **values}
    for key in PATHS:
        merged[key] = expand(merged[key], home)
    merged["DORI_DISCORD_BUG_REPORT_SOURCE"] = f"{merged['HELIO_BUG_REPORT_BOT']}:{merged['HELIO_BUG_REPORT_CHANNEL']}"
    return merged


def problems(values: dict[str, str], require_secrets: bool = True) -> list[str]:
    found = []
    unknown = sorted(set(values) - set(defaults()))
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
    for key in COUNTS:
        if not COUNT.fullmatch(merged.get(key, "")):
            found.append(f"{key} must be a positive whole number")
    if not all(GLOB.fullmatch(item) for item in merged.get("HELIO_AUTOFIX_DENY", "").split(",")):
        found.append("HELIO_AUTOFIX_DENY must be comma-separated repository paths or globs without spaces")
    allowed = set(merged["DORI_DISCORD_ALLOWED"].split(","))
    for key in ("DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS"):
        missing = [x for x in merged[key].split(",") if x and x not in allowed]
        if missing:
            found.append(f"{key} lists channels missing from DORI_DISCORD_ALLOWED")
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
    return files


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
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise SystemExit(f"Unsafe generated file: {target}")
        if not target.exists() or target.read_bytes() != data or (target.stat().st_mode & 0o777) != mode:
            changed.append((name, data, mode))
    print("Generated from helio.env: " + (", ".join(n for n, _, _ in changed) if changed else "up to date"))
    if apply:
        for name, data, mode in changed:
            atomic(base / name, data, mode)
    return len(changed)


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
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    if args.command == "init":
        init(home, args.from_installed)
    elif args.command == "check":
        issues = problems(load(home))
        print("helio.env OK" if not issues else "Problems:\n  - " + "\n  - ".join(issues))
        sys.exit(1 if issues else 0)
    else:
        render(home, args.apply)


if __name__ == "__main__":
    main()
