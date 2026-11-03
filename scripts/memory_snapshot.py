#!/usr/bin/env python3
"""Python 3.12+: inspectable, private OMO memory snapshots using only stdlib."""
# Run: python3 scripts/memory_snapshot.py export --source REPO --destination SNAPSHOT
# HEAD is preserved by default; --no-head explicitly exports only the working tree.
# Restore: python3 scripts/memory_snapshot.py restore --source SNAPSHOT --destination NEW_IDENTITY
# Destination parents must exist. Atomic directory publication supports macOS/Linux.
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Iterator


class SnapshotError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)


@dataclass(frozen=True, slots=True)
class Entry:
    path: str
    mode: int
    sha256: str | None


def safe_path(value: Path) -> Path:
    if ".." in value.parts:
        raise SnapshotError("Parent traversal is not allowed.")
    path = value.expanduser().absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise SnapshotError("Symlink paths are not allowed.")
    return path


@contextmanager
def descriptor(path: str | Path, parent: int | None = None) -> Iterator[int]:
    """Reject symlinks swapped in after inspection; never block on special files."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


def capture(root: Path, destination: Path | None = None, exclude_git: bool = False) -> tuple[Entry, ...]:
    """Capture complete regular-file data, dotfiles and empty directories included."""
    entries: list[Entry] = []

    def visit(directory: int, prefix: str) -> None:
        for name in sorted(os.listdir(directory)):
            with descriptor(name, directory) as fd:
                metadata = os.fstat(fd)
                if name == ".git":
                    if exclude_git:
                        continue
                    raise SnapshotError("Snapshots must not contain a .git working-tree entry.")
                relative = prefix + name
                target = destination / relative if destination is not None else None
                if stat.S_ISDIR(metadata.st_mode):
                    entry = Entry(relative + "/", stat.S_IMODE(metadata.st_mode) & 0o777, None)
                    if target is not None:
                        target.mkdir(mode=0o700)
                    entries.append(entry)
                    visit(fd, entry.path)
                    if target is not None:
                        target.chmod(entry.mode)
                elif stat.S_ISREG(metadata.st_mode):
                    with os.fdopen(os.dup(fd), "rb") as stream:
                        data = stream.read()
                    entry = Entry(relative, stat.S_IMODE(metadata.st_mode) & 0o777, hashlib.sha256(data).hexdigest())
                    if target is not None:
                        with target.open("xb") as output:
                            output.write(data)
                        target.chmod(entry.mode)
                    entries.append(entry)
                else:
                    raise SnapshotError("Working tree contains a special file.")

    with descriptor(root) as fd:
        visit(fd, "")
    if not entries:
        raise SnapshotError("Empty memory trees are not snapshots.")
    return tuple(entries)


def digest(path: Path) -> str:
    with descriptor(path) as fd, os.fdopen(os.dup(fd), "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(repo: Path, *arguments: str) -> bytes:
    """Use only local Git, without ambient config, optional locks or hooks."""
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", str(repo), *arguments],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={"GIT_MASTER": "1", "PATH": os.defpath, "GIT_CONFIG_NOSYSTEM": "1",
             "GIT_CONFIG_GLOBAL": os.devnull, "GIT_OPTIONAL_LOCKS": "0"},
    ).stdout


def head_bundle(source: Path, temp: Path) -> tuple[str, Path]:
    """Copy only the existing HEAD commit and current tree, never prior history."""
    for directory, directories, files in os.walk(source / ".git", followlinks=False):
        for name in (*directories, *files):
            if (Path(directory) / name).is_symlink() or name in {"alternates", "commondir", "gitdir"}:
                raise SnapshotError("Linked or alternate Git metadata is not supported.")
    names = git(temp, "config", "--no-includes", "--file", str(source / ".git/config"),
                "--name-only", "--list").decode().splitlines()
    if any(name.startswith(("include.", "includeif.", "extensions.")) for name in names):
        raise SnapshotError("Git configuration includes and extensions are not supported.")
    if git(source, "status", "--porcelain", "--untracked-files=all", "--ignored"):
        raise SnapshotError("Including HEAD requires a clean, fully committed source.")
    head = git(source, "rev-parse", "--verify", "HEAD").decode().strip()
    clone, bundle = temp / "shallow", temp / "head.bundle"
    git(temp, "clone", "--quiet", "--no-checkout", "--no-local", "--depth=1", "--template=",
        source.as_uri(), str(clone))
    if git(clone, "rev-parse", "HEAD").decode().strip() != head:
        raise SnapshotError("Source HEAD changed during export.")
    git(clone, "bundle", "create", str(bundle), "HEAD")
    return head, bundle


def check_head(repo: Path, entries: tuple[Entry, ...]) -> None:
    """Require the entire visible inventory and tracked contents to equal HEAD."""
    files = {os.fsdecode(name) for name in git(repo, "ls-tree", "-rz", "--name-only", "HEAD").split(b"\0") if name}
    directories = {str(parent) + "/" for name in files for parent in PurePosixPath(name).parents
                   if str(parent) != "."}
    if ({entry.path for entry in entries} != files | directories
            or git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored")):
        raise SnapshotError("Visible memory must exactly match committed HEAD, without noncommitted extras.")


def load_snapshot(root: Path) -> tuple[tuple[Entry, ...], str | None]:
    raw = json.loads((safe_path(root / "manifest.json")).read_bytes())
    if (type(raw) is not dict or set(raw) != {"format", "entries", "head", "bundle_sha256"}
            or raw["format"] != "helio-memory-v1" or type(raw["entries"]) is not list):
        raise SnapshotError("Invalid snapshot manifest.")
    entries: list[Entry] = []
    for item in raw["entries"]:
        if type(item) is not dict or set(item) != {"path", "mode", "sha256"}:
            raise SnapshotError("Invalid snapshot inventory.")
        path, mode, checksum = item["path"], item["mode"], item["sha256"]
        if type(path) is not str or type(mode) is not int or not 0 <= mode <= 0o777:
            raise SnapshotError("Invalid inventory path or mode.")
        parsed = PurePosixPath(path)
        if (not parsed.parts or parsed.is_absolute() or ".." in parsed.parts or ".git" in parsed.parts
                or "\\" in path or "\x00" in path or parsed.as_posix() + ("/" if checksum is None else "") != path):
            raise SnapshotError("Unsafe snapshot path.")
        entries.append(Entry(path, mode, checksum))
    if capture(safe_path(root / "repo")) != tuple(entries):
        raise SnapshotError("Snapshot inventory or content does not match.")
    head = raw["head"]
    expected = {"repo", "manifest.json"}
    if head is not None:
        if type(head) is not str or len(head) != 40 or any(c not in "0123456789abcdef" for c in head):
            raise SnapshotError("Invalid existing HEAD identity.")
        if digest(safe_path(root / "head.bundle")) != raw["bundle_sha256"]:
            raise SnapshotError("HEAD bundle checksum mismatch.")
        expected.add("head.bundle")
    elif raw["bundle_sha256"] is not None:
        raise SnapshotError("Incomplete HEAD transport metadata.")
    if set(os.listdir(root)) != expected:
        raise SnapshotError("Snapshot has unexpected or incomplete data.")
    return tuple(entries), head


def publish(staged: Path, destination: Path, replace: bool = False) -> None:
    """One atomic no-clobber rename or exchange, without following symlink pointers."""
    library = ctypes.CDLL(None, use_errno=True)
    if hasattr(library, "renamex_np"):
        result = library.renamex_np(os.fsencode(staged), os.fsencode(destination), 2 if replace else 4)
    elif hasattr(library, "renameat2"):
        result = library.renameat2(-100, os.fsencode(staged), -100, os.fsencode(destination), 2 if replace else 1)
    else:
        raise SnapshotError("Atomic directory publication requires macOS or Linux.")
    if result:
        raise OSError(ctypes.get_errno(), "Atomic publication failed.")


def export(source: Path, destination: Path, options: argparse.Namespace) -> None:
    if not (source / ".git").is_dir() or (source / ".git").is_symlink():
        raise SnapshotError("Source must contain a real .git directory.")
    lock = destination.with_name(destination.name + ".lock")
    with lock.open("x"):
        try:
            previous = options.replace_sha256
            if destination.exists():
                load_snapshot(destination)
                if previous is None or digest(destination / "manifest.json") != previous:
                    raise SnapshotError("Existing snapshot requires its exact manifest SHA-256.")
            elif previous is not None:
                raise SnapshotError("Refresh requires an existing snapshot.")
            with tempfile.TemporaryDirectory(prefix=".helio-snapshot-", dir=destination.parent) as temporary:
                temp = Path(temporary)
                staged = temp / "snapshot"
                staged.mkdir(mode=0o700)
                (staged / "repo").mkdir(mode=0o700)
                head, bundle = head_bundle(source, temp) if options.include_head else (None, None)
                entries = capture(source, staged / "repo", exclude_git=True)
                if bundle is not None:
                    bundle.rename(staged / "head.bundle")
                manifest = {"format": "helio-memory-v1", "entries": [asdict(entry) for entry in entries],
                            "head": head, "bundle_sha256": digest(staged / "head.bundle") if bundle else None}
                (staged / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
                if capture(source, exclude_git=True) != entries:
                    raise SnapshotError("Source changed during export; retry when quiescent.")
                if options.include_head:
                    if git(source, "rev-parse", "HEAD").decode().strip() != head:
                        raise SnapshotError("Source HEAD changed during export.")
                    check_head(source, entries)
                identifier = digest(staged / "manifest.json")
                load_snapshot(staged)
                if previous is not None:
                    load_snapshot(destination)
                    if digest(destination / "manifest.json") != previous:
                        raise SnapshotError("Destination changed during export.")
                publish(staged, destination, replace=previous is not None)
        finally:
            lock.unlink()
    state = "" if options.include_head else " No HEAD: unusable for OMO until a user-authorized initial commit."
    print(f"Export complete. Manifest SHA-256: {identifier}{state}")


def restore(source: Path, destination: Path) -> None:
    entries, head = load_snapshot(source)
    with tempfile.TemporaryDirectory(prefix=".helio-restore-", dir=destination.parent) as temporary:
        staged = Path(temporary) / "identity"
        repo = staged / "repo"
        staged.mkdir(mode=0o700)
        repo.mkdir(mode=0o700)
        if capture(source / "repo", repo) != entries:
            raise SnapshotError("Snapshot changed during restore.")
        git(repo, "init", "--quiet", "--template=", "--initial-branch=main")
        if head is not None:
            git(repo, "bundle", "unbundle", str(source / "head.bundle"))
            (repo / ".git/shallow").write_text(head + "\n", encoding="ascii")
            git(repo, "update-ref", "refs/heads/main", head)
            git(repo, "read-tree", "HEAD")
            check_head(repo, entries)
            git(repo, "fsck", "--full", "--no-reflogs")
        (staged / "runtime/locks").mkdir(parents=True, mode=0o700)
        publish(staged, destination)
    state = ("Existing committed HEAD restored; no new commit is needed." if head else
             "Unusable for OMO projection until a user-authorized initial commit; this snapshot has no HEAD.")
    print(f"Restore complete. No commits created. {state} OMO runtime compatibility has not been validated.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    exporting = commands.add_parser("export", help="Export an inspectable directory snapshot.")
    exporting.add_argument("--source", type=Path, default=Path.home() / ".omo/memory/agents/elobot-ec289b4c/repo")
    exporting.add_argument("--destination", type=Path, default=Path.home() / "PythonProjects/Helio/memory")
    exporting.add_argument("--replace-sha256", help="Exact prior manifest SHA-256; replace only a valid snapshot.")
    exporting.add_argument("--no-head", dest="include_head", action="store_false",
                           help="Explicitly omit HEAD; OMO then requires a user-authorized initial commit.")
    restoring = commands.add_parser("restore", help="Create a new identity; never overwrite an existing one.")
    restoring.add_argument("--source", type=Path, required=True)
    restoring.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        source, destination = safe_path(arguments.source), safe_path(arguments.destination)
        if source == destination or source in destination.parents or destination in source.parents:
            raise SnapshotError("Source and destination must not overlap.")
        if not destination.parent.is_dir():
            raise SnapshotError("Destination parent must already exist.")
        if arguments.command == "export":
            export(source, destination, arguments)
        else:
            restore(source, destination)
    except (SnapshotError, OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        message = str(error) if type(error) is SnapshotError else "Operation refused or failed; no success claimed."
        parser.exit(1, message + "\n")


if __name__ == "__main__":
    main()
