"""Offline isolation for the whole Python suite, imported first by every test module.

No test may read the owner's live Helio configuration (custody admission, policy, lane state) or reach
GitHub. HOME moves to a temporary directory, inherited Dori/Herdr/Helio variables are dropped, and a
`gh` that always fails comes first on PATH unless a test installs its own fake. Subprocesses inherit all
of it. Tests that need a setting set it themselves.
"""
from __future__ import annotations

import atexit
import os
from pathlib import Path
import shutil
import tempfile

BUN = shutil.which("bun") or str(Path.home() / ".bun/bin/bun")  # resolved before HOME moves
ROOT = Path(os.environ.get("HELIO_TEST_ROOT") or tempfile.mkdtemp(prefix="helio-tests-"))

if os.environ.get("HELIO_TEST_ROOT") != str(ROOT):
    atexit.register(shutil.rmtree, ROOT, True)
    for name in [name for name in os.environ if name.startswith(("DORI_", "HERDR_", "HELIO_"))]:
        del os.environ[name]
    (ROOT / "home").mkdir()
    (ROOT / "bin").mkdir()
    gh = ROOT / "bin/gh"
    gh.write_text('#!/bin/sh\necho "gh is blocked in offline tests: $*" >&2\nexit 97\n')
    gh.chmod(0o755)
    os.environ.update(HELIO_TEST_ROOT=str(ROOT), HOME=str(ROOT / "home"),
                      PATH=f"{ROOT / 'bin'}:{Path(BUN).parent}:{os.environ.get('PATH', '/usr/bin:/bin')}")
