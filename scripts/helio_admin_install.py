#!/usr/bin/env python3
"""Explicitly build and install the owner controller; does not register commands or start services."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import tempfile
from typing import TypedDict


class ControllerBuild(TypedDict):
    controller_sha256: str
    changed: bool
    applied: bool
    activation: str


class ControllerBuildError(RuntimeError):
    """The protected controller could not be built or safely published."""


def source_version(sources: Path) -> str:
    """Identify the installed inbound production sources and locked dependencies."""
    if not sources.is_dir():
        return ""
    files = []
    for directory, children, names in os.walk(sources):
        children[:] = sorted(name for name in children if name not in ("node_modules", "fixtures", "tests", ".git"))
        files.extend(Path(directory) / name for name in names
                     if (name.endswith(".ts") and not name.endswith(".test.ts"))
                     or name in ("package.json", "bun.lock") or name.endswith(".patch"))
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(os.fsencode(path.relative_to(sources)) + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def install_controller(sources: Path, apply: bool) -> ControllerBuild:
    """Build as the owner; publish an immutable bundle only when explicitly applied."""
    owner = pwd.getpwnam("james")
    if not (sources / "node_modules").is_dir():
        raise ControllerBuildError("Install the inbound package's locked dependencies before building the controller")
    if apply and os.geteuid() != 0:
        raise ControllerBuildError("Applying the controller installation requires root")
    source_digest = source_version(sources)
    with tempfile.TemporaryDirectory(prefix="helio-admin-build-") as temporary:
        # The owner can write the child directory, but cannot replace its parent.
        os.chmod(temporary, 0o711)
        work = Path(temporary) / "output"
        work.mkdir(mode=0o700)
        if os.geteuid() == 0:
            os.chown(work, owner.pw_uid, owner.pw_gid)
        output = work / "controller.js"
        prefix = (["setpriv", "--reuid", str(owner.pw_uid), "--regid", str(owner.pw_gid),
                   "--clear-groups", "--no-new-privs"] if os.geteuid() == 0 else [])
        subprocess.run([*prefix, str(Path(owner.pw_dir) / ".bun/bin/bun"), "build",
                        str(sources / "admin/main.ts"), "--target=bun", "--outfile=" + str(output)],
                       check=True, stdin=subprocess.DEVNULL, timeout=120, cwd=sources,
                       env={**os.environ, "HOME": owner.pw_dir})
        descriptor = os.open(output, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner.pw_uid:
                raise ControllerBuildError("Untrusted controller build output")
            content = stream.read()
    if source_version(sources) != source_digest:
        raise ControllerBuildError("Administration source changed during the build; deploy again")
    target = Path("/opt/helio-admin-service/controller.js")
    digest = hashlib.sha256(content).hexdigest()
    changed = not target.exists() or target.read_bytes() != content
    if apply:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        info = target.parent.lstat()
        if target.parent.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ControllerBuildError("Unsafe controller installation directory")
        versions = target.parent / "versions"
        versions.mkdir(mode=0o755, exist_ok=True)
        info = versions.lstat()
        if versions.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ControllerBuildError("Unsafe controller version directory")
        version = versions / f"{digest}.js"
        with tempfile.NamedTemporaryFile(dir=versions, delete=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            saved = Path(stream.name)
        saved.chmod(0o644)
        saved.replace(version)
        with tempfile.TemporaryDirectory(prefix=".controller-", dir=target.parent) as activation:
            link = Path(activation) / "current"
            link.symlink_to(version.relative_to(target.parent))
            link.replace(target)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
            stream.write(json.dumps({"controller_sha256": digest, "source_sha256": source_digest}).encode())
            stream.flush()
            os.fsync(stream.fileno())
            saved = Path(stream.name)
        saved.chmod(0o644)
        saved.replace(target.parent / "controller-source.json")
    return {"controller_sha256": digest, "changed": changed, "applied": apply,
            "activation": "Next Helio start activates the deployed controller and synchronizes commands"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(install_controller(Path(__file__).resolve().parent.parent / "discord-inbound", args.apply)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
