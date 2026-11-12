"""Offline CLI regressions; mutable state stays inside TemporaryDirectory."""
from __future__ import annotations
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH

import hashlib
import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Final, Iterator

SCRIPT: Final = Path(__file__).resolve().parents[1] / "scripts/memory_snapshot.py"


@contextmanager
def sandbox() -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        source = root / "source"
        (source / ".git").mkdir(parents=True)
        (source / ".git/ignored").write_bytes(b"excluded history")
        (source / "system").mkdir()
        (source / "system/persona.md").write_bytes(b"current persona\n")
        (source / ".private").write_bytes(b"dotfile payload")
        (source / "notes/empty").mkdir(parents=True)
        (source / "skills").mkdir()
        (source / "skills/run.sh").write_bytes(b"#!/bin/sh\n")
        (source / "skills/run.sh").chmod(0o700)
        yield root


def cli(*arguments: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *map(str, arguments)],
        text=True, capture_output=True, check=False, timeout=30,
    )


def exported(root: Path) -> Path:
    destination = root / "snapshot"
    result = cli("export", "--no-head", "--source", root / "source", "--destination", destination)
    if result.returncode:
        raise AssertionError(result.stderr)
    return destination


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class MemorySnapshotTests(unittest.TestCase):
    def test_roundtrip_preserves_current_tree_and_initializes_unborn_git(self) -> None:
        with sandbox() as root:
            snapshot = exported(root)
            identity = root / "identity"
            result = cli("restore", "--source", snapshot, "--destination", identity)
            self.assertEqual(result.returncode, 0, result.stderr)
            repo = identity / "repo"
            actual = {p.relative_to(repo).as_posix(): p.read_bytes()
                      for p in repo.rglob("*") if p.is_file() and ".git" not in p.relative_to(repo).parts}
            self.assertEqual(actual, {".private": b"dotfile payload", "system/persona.md": b"current persona\n",
                                      "skills/run.sh": b"#!/bin/sh\n"})
            self.assertTrue((repo / "notes/empty").is_dir())
            self.assertTrue((identity / "runtime/locks").is_dir())
            self.assertTrue((repo / ".git").is_dir())
            self.assertFalse((repo / ".git/ignored").exists())
            self.assertEqual(stat.S_IMODE((repo / "skills/run.sh").stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o700)
            head = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "HEAD"],
                                  env={"GIT_MASTER": "1", "PATH": os.defpath},
                                  capture_output=True, check=False, timeout=10)
            self.assertNotEqual(head.returncode, 0)
            self.assertNotIn("current persona", result.stdout + result.stderr)

    def test_restore_never_overwrites_existing_identities(self) -> None:
        for populated in (False, True):
            with self.subTest(populated=populated), sandbox() as root:
                snapshot = exported(root)
                identity = root / "identity"
                identity.mkdir()
                if populated:
                    (identity / "keep").write_bytes(b"existing")
                result = cli("restore", "--source", snapshot, "--destination", identity)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(sorted(p.name for p in identity.iterdir()), ["keep"] if populated else [])

    def test_failed_refresh_preserves_old_snapshot_without_partial_output(self) -> None:
        for failure in ("missing_hash", "wrong_hash", "symlink", "fifo"):
            with self.subTest(failure=failure), sandbox() as root:
                snapshot = exported(root)
                previous = (snapshot / "manifest.json").read_bytes()
                arguments: list[str | Path] = ["export", "--no-head", "--source", root / "source",
                                              "--destination", snapshot]
                if failure != "missing_hash":
                    arguments.extend(["--replace-sha256",
                                      "0" * 64 if failure == "wrong_hash" else sha(snapshot / "manifest.json")])
                if failure == "symlink":
                    (root / "source/link").symlink_to(root / "source/system/persona.md")
                if failure == "fifo":
                    os.mkfifo(root / "source/pipe")
                result = cli(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((snapshot / "manifest.json").read_bytes(), previous)
                self.assertEqual((snapshot / "repo/.private").read_bytes(), b"dotfile payload")
                self.assertFalse((root / "snapshot.lock").exists())
                self.assertEqual(list(root.glob(".helio-snapshot-*")), [])

    def test_explicit_refresh_includes_new_working_tree_content(self) -> None:
        with sandbox() as root:
            snapshot = exported(root)
            previous = sha(snapshot / "manifest.json")
            (root / "source/.private").write_bytes(b"new content")
            result = cli("export", "--no-head", "--source", root / "source", "--destination", snapshot,
                         "--replace-sha256", previous)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((snapshot / "repo/.private").read_bytes(), b"new content")
            self.assertNotEqual(sha(snapshot / "manifest.json"), previous)

    def test_malformed_snapshots_never_create_an_identity(self) -> None:
        for kind in ("traversal", "absolute", "symlink", "checksum", "extra", "truncated", "missing"):
            with self.subTest(kind=kind), sandbox() as root:
                snapshot = exported(root)
                if kind == "truncated":
                    (snapshot / "manifest.json").write_bytes(b'{"format":')
                else:
                    manifest = json.loads((snapshot / "manifest.json").read_bytes())
                    target = manifest["entries"][0]
                    old_path = snapshot / "repo" / target["path"]
                    if kind in {"traversal", "absolute"}:
                        target["path"] = "../escaped" if kind == "traversal" else "/escaped"
                    if kind == "symlink":
                        old_path.unlink()
                        old_path.symlink_to(root / "source/.private")
                    if kind == "checksum":
                        old_path.write_bytes(b"corrupt payload")
                    if kind == "extra":
                        (snapshot / "unlisted").write_bytes(b"partial inventory")
                    if kind == "missing":
                        old_path.unlink()
                    (snapshot / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                identity = root / "identity"
                result = cli("restore", "--source", snapshot, "--destination", identity)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(identity.exists())
                self.assertFalse((root / "escaped").exists())
                self.assertNotIn("corrupt payload", result.stdout + result.stderr)

    def test_export_rejects_overlap_and_symlink_paths(self) -> None:
        for kind in ("inside_source", "source_symlink", "destination_symlink", "parent_symlink", "traversal"):
            with self.subTest(kind=kind), sandbox() as root:
                source, destination = root / "source", root / "refused"
                if kind == "inside_source":
                    destination = source / "snapshot"
                if kind == "source_symlink":
                    (root / "alias").symlink_to(source, target_is_directory=True)
                    source = root / "alias"
                if kind == "destination_symlink":
                    destination.symlink_to(root / "missing")
                if kind == "parent_symlink":
                    (root / "alias").symlink_to(root, target_is_directory=True)
                    destination = root / "alias/refused"
                if kind == "traversal":
                    destination = root / "source/../refused"
                result = cli("export", "--no-head", "--source", source, "--destination", destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists())

    def test_hash_cannot_authorize_replacing_arbitrary_data(self) -> None:
        with sandbox() as root:
            destination = root / "not-a-snapshot"
            destination.write_bytes(b"preserve arbitrary data")
            result = cli("export", "--no-head", "--source", root / "source", "--destination", destination,
                         "--replace-sha256", sha(destination))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(destination.read_bytes(), b"preserve arbitrary data")

    def test_source_manifest_filename_cannot_collide_with_snapshot_metadata(self) -> None:
        with sandbox() as root:
            (root / "source/manifest.json").write_bytes(b"working-tree metadata")
            snapshot = exported(root)
            result = cli("restore", "--source", snapshot, "--destination", root / "identity")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "identity/repo/manifest.json").read_bytes(), b"working-tree metadata")

    def test_invalid_git_bundle_rolls_back_only_new_identity(self) -> None:
        with sandbox() as root:
            snapshot = exported(root)
            manifest = json.loads((snapshot / "manifest.json").read_bytes())
            manifest["head"] = "a" * 40
            manifest["bundle_sha256"] = hashlib.sha256(b"invalid bundle").hexdigest()
            (snapshot / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (snapshot / "head.bundle").write_bytes(b"invalid bundle")
            identity = root / "identity"
            result = cli("restore", "--source", snapshot, "--destination", identity)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(identity.exists())
            self.assertEqual((root / "source/system/persona.md").read_bytes(), b"current persona\n")

    def test_existing_export_lock_is_not_removed_or_ignored(self) -> None:
        with sandbox() as root:
            lock = root / "snapshot.lock"
            lock.write_bytes(b"owned by another exporter")
            result = cli("export", "--no-head", "--source", root / "source", "--destination", root / "snapshot")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(lock.read_bytes(), b"owned by another exporter")
            self.assertFalse((root / "snapshot").exists())


def verify_existing_head(source: Path) -> None:
    """Optional offline integration: read existing commits, never create commits."""
    case = unittest.TestCase()
    environment = {"GIT_MASTER": "1", "PATH": os.defpath, "GIT_OPTIONAL_LOCKS": "0",
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        clone, snapshot, identity = root / "source", root / "snapshot", root / "identity"
        subprocess.run(["git", "clone", "--quiet", "--depth=2", "--no-local", "--template=",
                        source.expanduser().resolve().as_uri(), str(clone)], env=environment,
                       capture_output=True, check=True, timeout=30)
        expected_head = subprocess.run(["git", "-C", str(clone), "rev-parse", "HEAD"], env=environment,
                                       capture_output=True, check=True, timeout=10).stdout
        result = cli("export", "--source", clone, "--destination", snapshot)
        case.assertEqual(result.returncode, 0, result.stderr)
        result = cli("restore", "--source", snapshot, "--destination", identity)
        case.assertEqual(result.returncode, 0, result.stderr)
        for arguments, expected in (
            (["rev-parse", "HEAD"], expected_head),
            (["rev-list", "--count", "HEAD"], b"1\n"),
            (["status", "--porcelain", "--untracked-files=all", "--ignored"], b""),
            (["fsck", "--full", "--no-reflogs"], b""),
        ):
            check = subprocess.run(["git", "-C", str(identity / "repo"), *arguments], env=environment,
                                   capture_output=True, check=True, timeout=10)
            case.assertEqual(check.stdout, expected)
        objects = subprocess.run(["git", "-C", str(identity / "repo"), "cat-file", "--batch-all-objects",
                                  "--batch-check=%(objecttype)"], env=environment, capture_output=True,
                                 check=True, timeout=10).stdout.splitlines()
        case.assertEqual(objects.count(b"commit"), 1)
        for ignored in (False, True):
            with case.subTest(ignored=ignored):
                extra = clone / ".000-extra"
                extra.write_bytes(b"temporary noncommitted file")
                (clone / ".git/info").mkdir(exist_ok=True)
                (clone / ".git/info/exclude").write_text(".000-extra\n" if ignored else "", encoding="ascii")
                rejected = cli("export", "--source", clone, "--destination", root / "refused")
                case.assertNotEqual(rejected.returncode, 0)
                case.assertFalse((root / "refused").exists())
                extra.unlink()
        extra = snapshot / "repo/.000-extra"
        extra.write_bytes(b"temporary noncommitted file")
        extra.chmod(0o600)
        manifest = json.loads((snapshot / "manifest.json").read_bytes())
        manifest["entries"].insert(0, {"path": ".000-extra", "mode": 0o600, "sha256": sha(extra)})
        (snapshot / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        rejected = cli("restore", "--source", snapshot, "--destination", root / "refused-identity")
        case.assertNotEqual(rejected.returncode, 0)
        case.assertFalse((root / "refused-identity").exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--head-source", type=Path, help="Optional existing Git repo for offline HEAD integration.")
    options = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(MemorySnapshotTests)
    if options.head_source is not None:
        suite.addTest(unittest.FunctionTestCase(lambda: verify_existing_head(options.head_source)))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
