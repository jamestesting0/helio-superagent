"""Red/green regression proof shared by automatic fixes and bug-report PR submission.

A changed test module must fail with assertion failures only on main and pass on the branch.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
import tempfile
from typing import Final

RUNNER: Final = """
import json, pathlib, sys, unittest
root, output, *paths = sys.argv[1:]
sys.path.insert(0, root)
loader = unittest.TestLoader()
suite = unittest.TestSuite(loader.loadTestsFromName(p[:-3].replace('/', '.')) for p in paths) if paths else loader.discover('tests')
result = unittest.TextTestRunner(verbosity=2, stream=sys.stderr).run(suite)
pathlib.Path(output).write_text(json.dumps(dict(run=result.testsRun, failures=len(result.failures),
    errors=len(result.errors), skips=len(result.skipped), unexpected=len(result.unexpectedSuccesses))))
"""


class Failed(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Counts:
    run: int
    failures: int
    errors: int
    skips: int
    unexpected: int

    def passed(self) -> bool:
        return self.run > 0 and not (self.failures or self.errors or self.skips or self.unexpected)


def _run(argv: list[str], cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or f"{argv[0]} failed")
    return result.stdout.strip()


def changed_tests(tree: Path, base: str, head: str) -> list[str]:
    paths = _run(["git", "diff", "--name-only", "--diff-filter=AM", "-z", base, head], tree).split("\0")
    return [path for path in paths if path.startswith("tests/") and path.endswith(".py")]


def proof(project: Path, head: str, tests: list[str], *, full: bool = True,
          base: str = "origin/main") -> tuple[Counts, Counts, Counts | None]:
    if not tests:
        raise Failed("change at least one Python test module under tests/")
    python = project / ".venv/bin/python"
    with tempfile.TemporaryDirectory(prefix="helio-proof-") as temporary:
        root = Path(temporary)
        trees = []
        try:
            for name, revision in (("before", base), ("after", head)):
                tree = root / name
                _run(["git", "worktree", "add", "--detach", str(tree), revision], project)
                trees.append(tree)
            for path in tests:
                destination = trees[0] / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((trees[1] / path).read_bytes())
            runs = [(trees[0], tests), (trees[1], tests)] + ([(trees[1], [])] if full else [])
            results = []
            for index, (tree, modules) in enumerate(runs):
                output = root / f"result-{index}.json"
                _run([str(python), "-I", "-c", RUNNER, str(tree), str(output), *modules], tree)
                results.append(Counts(**json.loads(output.read_text())))
            before, after = results[0], results[1]
            whole = results[2] if full else None
            if not (before.failures >= 1 and before.errors == before.skips == before.unexpected == 0):
                raise Failed(f"main must have assertion failures only: {before}")
            if not after.passed() or (whole is not None and not whole.passed()):
                raise Failed(f"branch tests must pass: changed={after}; full={whole}")
            return before, after, whole
        finally:
            for tree in reversed(trees):
                _run(["git", "worktree", "remove", "--force", str(tree)], project)
