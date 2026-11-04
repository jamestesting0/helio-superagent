"""Automatic PR gates exercise real git and unittest against an offline GitHub boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import TypedDict
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/helio-autofix.py"
REGRESSION = """import unittest
from value import value
class Regression(unittest.TestCase):
    def test_value(self):
        self.assertEqual(value(), 2)
"""
FAKE_GH = """#!{python}
import json, os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ["FAKE_GH_ROOT"])
with (root / "calls").open("a") as output:
    output.write(json.dumps(args) + "\\n")
data = json.loads((root / "github.json").read_text())
if args[:2] == ["issue", "view"]:
    print(json.dumps(data["issue"]))
elif args[:2] == ["pr", "list"]:
    print(json.dumps(data["pulls"]))
elif args[:2] == ["label", "list"]:
    print(json.dumps(data["labels"]))
elif args[:2] == ["label", "create"]:
    data["labels"].append({{"name": args[2]}})
    (root / "github.json").write_text(json.dumps(data))
elif args[:2] == ["pr", "create"]:
    (root / "body").write_text(pathlib.Path(args[args.index("--body-file") + 1]).read_text())
    print("https://github.com/o/r/pull/8")
else:
    sys.exit(3)
"""


class Pull(TypedDict):
    url: str
    headRefName: str
    body: str
    title: str
    closingIssuesReferences: list[dict[str, int]]
    labels: list[dict[str, str]]


class AutofixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "project"
        self.git("init", "--bare", "-b", "main", str(self.root / "origin.git"), cwd=self.root)
        self.git("clone", str(self.root / "origin.git"), str(self.project), cwd=self.root)
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.write(".gitignore", ".venv/\n")
        self.write("value.py", "def value():\n    return 1\n")
        self.write("tests/__init__.py", "")
        self.write("tests/test_existing.py", "import unittest\nclass Existing(unittest.TestCase):\n    def test_existing(self): self.assertTrue(True)\n")
        self.commit()
        self.git("push", "origin", "main")
        self.git("checkout", "-b", "helio/autofix-7")
        self.write("value.py", "def value():\n    return 2\n")
        self.write("tests/test_regression.py", REGRESSION)
        self.commit()
        python = self.project / ".venv/bin/python"
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
        bins = self.root / "bin"
        bins.mkdir()
        (bins / "gh").write_text(FAKE_GH.format(python=sys.executable))
        (bins / "gh").chmod(0o755)
        self.data = {"issue": {"state": "OPEN", "labels": [{"name": "bug"}]}, "pulls": [], "labels": []}
        self.summary = self.root / "summary.md"
        self.summary.write_text("Root cause: wrong value.\nFix: return the expected value.\n`$not_a_shell`")
        self.env = {**os.environ, "PATH": f"{bins}:{os.environ['PATH']}", "FAKE_GH_ROOT": str(self.root),
                    "HELIO_PROJECT": str(self.project), "HELIO_GITHUB_REPO": "o/r", "HELIO_AUTOFIX": "on",
                    "HELIO_AUTOFIX_MAX_LINES": "40", "HELIO_AUTOFIX_MAX_FILES": "3",
                    "HELIO_AUTOFIX_MAX_OPEN": "3", "HELIO_AUTOFIX_DENY": "private/**,*.env*,**/migrations/**"}

    def git(self, *args: str, cwd: Path | None = None) -> str:
        return subprocess.run(["git", *args], cwd=cwd or self.project, check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, name: str, content: str) -> None:
        path = self.project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self) -> None:
        self.git("add", ".")
        self.git("commit", "-m", "fixture")

    def invoke(self, command: str = "check") -> subprocess.CompletedProcess[str]:
        (self.root / "github.json").write_text(json.dumps(self.data))
        argv = [sys.executable, str(SCRIPT), command, "--issue", "7"]
        if command == "submit":
            argv += ["--summary-file", str(self.summary)]
        return subprocess.run(argv, env=self.env, text=True, capture_output=True, timeout=60)

    def refused(self, gate: str) -> None:
        result = self.invoke()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(result.stdout.startswith(f"AUTOFIX_REFUSED {gate}:"), result.stdout)
        self.assertEqual(self.git("worktree", "list", "--porcelain").count("worktree "), 1)

    def pull(self, branch: str = "another") -> Pull:
        return {"url": "https://github.com/o/r/pull/8", "headRefName": branch, "body": "", "title": "",
                "closingIssuesReferences": [], "labels": [{"name": "helio-autofix"}]}

    def test_submit_pushes_proven_fix_and_creates_labelled_pr_with_evidence(self) -> None:
        result = self.invoke("submit")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "AUTOFIX_PR https://github.com/o/r/pull/8\n")
        self.assertEqual(self.git("ls-remote", "--heads", "origin", "helio/autofix-7").split()[0], self.git("rev-parse", "HEAD"))
        calls = [json.loads(line) for line in (self.root / "calls").read_text().splitlines()]
        create = next(call for call in calls if call[:2] == ["pr", "create"])
        self.assertEqual(create[create.index("--label") + 1], "helio-autofix")
        body = (self.root / "body").read_text()
        self.assertIn("Fixes #7", body)
        self.assertIn(self.summary.read_text(), body)
        self.assertIn("failures=1", body)
        self.assertIn("errors=0", body)
        self.assertEqual(self.git("worktree", "list", "--porcelain").count("worktree "), 1)

    def test_check_leaves_remote_and_github_unchanged(self) -> None:
        result = self.invoke()
        self.assertEqual((result.returncode, result.stdout), (0, "AUTOFIX_OK\n"), result.stderr)
        self.assertEqual(self.git("ls-remote", "--heads", "origin", "helio/autofix-7"), "")
        self.assertEqual(json.loads((self.root / "github.json").read_text()), self.data)

    def test_size_limits_count_removed_lines_and_non_test_files(self) -> None:
        self.env["HELIO_AUTOFIX_MAX_LINES"] = "1"
        self.refused("size")

    def test_file_limit_refuses_extra_non_test_files(self) -> None:
        self.write("another.py", "value = 1\n")
        self.commit()
        self.env["HELIO_AUTOFIX_MAX_FILES"] = "1"
        self.refused("size")

    def test_deny_globs_cross_directories_and_match_env_names(self) -> None:
        for path in ("private/deep/settings.py", "nested/.env.secret", "common/deep/migrations/change.py", "migrations/0001.py"):
            with self.subTest(path=path):
                self.write(path, "secret = 1\n")
                self.commit()
                self.refused("paths")
                self.git("rm", path)
                self.commit()

    def test_deletions_and_renames_are_refused(self) -> None:
        self.git("mv", "value.py", "renamed.py")
        self.commit()
        self.refused("size")

    def test_deletion_is_refused(self) -> None:
        self.git("rm", "tests/test_existing.py")
        self.commit()
        self.refused("size")

    def test_no_changed_test_module_is_refused(self) -> None:
        self.git("rm", "tests/test_regression.py")
        self.commit()
        self.refused("size")

    def test_import_error_is_not_failure_proof(self) -> None:
        self.write("tests/test_regression.py", REGRESSION.replace("from value import value", "from new_only import value"))
        self.write("new_only.py", "def value(): return 2\n")
        self.commit()
        self.refused("proof")

    def test_tests_already_passing_on_main_are_not_proof(self) -> None:
        self.write("tests/test_regression.py", REGRESSION.replace("self.assertEqual(value(), 2)", "self.assertGreater(value(), 0)"))
        self.commit()
        self.refused("proof")

    def test_full_suite_failure_blocks_passing_regression(self) -> None:
        self.write("tests/test_existing.py", "import unittest\nclass Existing(unittest.TestCase):\n    def test_existing(self): self.fail('unrelated regression')\n")
        self.git("add", ".")
        self.git("commit", "-m", "bad main fixture")
        self.git("push", "origin", "HEAD:main")
        self.write("tests/test_regression.py", REGRESSION.replace("value(), 2", "value(), 3"))
        self.write("value.py", "def value():\n    return 3\n")
        self.commit()
        self.refused("proof")

    def test_skipped_regression_is_refused(self) -> None:
        self.write("tests/test_regression.py", REGRESSION.replace("    def test_value", "    @unittest.skip('not proof')\n    def test_value"))
        self.commit()
        self.refused("proof")

    def test_open_autofix_cap_blocks_new_pr(self) -> None:
        self.data["pulls"] = [self.pull()]
        self.env["HELIO_AUTOFIX_MAX_OPEN"] = "1"
        self.refused("rate")

    def test_existing_branch_pr_returns_without_push_or_duplicate_creation(self) -> None:
        self.data["pulls"] = [self.pull("helio/autofix-7")]
        result = self.invoke("submit")
        self.assertEqual((result.returncode, result.stdout), (0, "AUTOFIX_PR https://github.com/o/r/pull/8\n"))
        self.assertEqual(self.git("ls-remote", "--heads", "origin", "helio/autofix-7"), "")
        self.assertFalse((self.root / "body").exists())

    def test_different_remote_head_is_never_overwritten(self) -> None:
        self.git("push", "origin", "origin/main:refs/heads/helio/autofix-7")
        result = self.invoke("submit")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(result.stdout.startswith("AUTOFIX_REFUSED remote:"), result.stdout)
        self.assertEqual(self.git("ls-remote", "--heads", "origin", "helio/autofix-7").split()[0], self.git("rev-parse", "origin/main"))

    def test_same_remote_head_can_create_missing_pr(self) -> None:
        self.git("push", "origin", "HEAD:refs/heads/helio/autofix-7")
        result = self.invoke("submit")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "body").is_file())

    def test_disabled_refuses_before_contacting_github(self) -> None:
        self.env["HELIO_AUTOFIX"] = "off"
        self.refused("disabled")
        self.assertFalse((self.root / "calls").exists())

    def test_issue_must_be_open_bug_without_overlapping_pr(self) -> None:
        for state, labels, pulls in (("CLOSED", [{"name": "bug"}], []), ("OPEN", [], []),
                                     ("OPEN", [{"name": "bug"}], [dict(self.pull(), body="Fixes #7")])):
            with self.subTest(state=state, labels=labels, pulls=pulls):
                self.data.update(issue={"state": state, "labels": labels}, pulls=pulls)
                self.refused("issue")

    def test_wrong_branch_and_dirty_tree_are_refused(self) -> None:
        self.git("checkout", "-b", "wrong")
        self.refused("branch")
        self.git("checkout", "helio/autofix-7")
        self.write("untracked", "dirty")
        self.refused("branch")

    def test_main_advancing_requires_rebase_before_proof(self) -> None:
        self.git("checkout", "main")
        self.write("new_main.py", "value = 1\n")
        self.commit()
        self.git("push", "origin", "main")
        self.git("checkout", "helio/autofix-7")
        self.refused("branch")

    def test_runner_start_failure_removes_both_worktrees(self) -> None:
        (self.project / ".venv/bin/python").unlink()
        self.refused("proof")
