"""The triage helper surfaces existing issues, pull requests, lanes and unmerged branches."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json
import os
import io
import runpy
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/helio-triage.py"
FAKE_GH = """#!{python}
import json, os, sys
from urllib.parse import urlparse, parse_qs
args = sys.argv[1:]
route = urlparse(args[1]) if args[0] == "api" else None
if route and route.path == "/search/issues":
    query = parse_qs(route.query)["q"][0]
    items = [] if "is:pr" in query else [
        {{"number": 2, "title": "Reveal opponent shows raw mention", "state": "open", "closed_at": None, "html_url": "https://github.com/o/r/issues/2"}},
        {{"number": 1, "title": "Old fixed bug", "state": "closed", "closed_at": "2020-01-01T00:00:00Z", "html_url": "https://github.com/o/r/issues/1"}},
    ]
    print(json.dumps({{"items": items, "total_count": len(items), "incomplete_results": bool(os.environ.get("TRIAGE_INCOMPLETE"))}}))
elif route and route.path == "/repos/o/r/pulls":
    print(json.dumps([{{"number": 7, "title": "Fix DM mentions", "head": {{"ref": "fix-dm"}}, "html_url": "u7"}}]))
elif route and route.path == "/repos/o/r/pulls/7/files":
    print(json.dumps([{{"filename": "cogs/final_commands.py"}}]))
elif route and route.path == "/repos/o/r/pulls/7":
    print(json.dumps({{"changed_files": 1}}))
else:
    sys.exit(3)
"""


class TriageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        bins = root / "bin"
        bins.mkdir()
        (bins / "gh").write_text(FAKE_GH.format(python=sys.executable))
        (bins / "gh").chmod(0o755)
        origin, project = root / "origin.git", root / "project"
        git = lambda *a, cwd=None: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)
        git("init", "--bare", "-b", "main", str(origin))
        git("clone", str(origin), str(project))
        for key, value in (("user.email", "t@example.invalid"), ("user.name", "T")):
            git("config", key, value, cwd=project)
        (project / "cogs").mkdir()
        (project / "cogs/final_commands.py").write_text("v1\n")
        git("add", ".", cwd=project); git("commit", "-m", "base", cwd=project); git("push", "origin", "main", cwd=project)
        git("checkout", "-b", "local-fix", cwd=project)
        (project / "cogs/final_commands.py").write_text("v2\n")
        git("commit", "-am", "fix reveal opponent", cwd=project)
        git("checkout", "main", cwd=project)
        self.running = git("rev-parse", "HEAD", cwd=project).stdout.decode().strip()
        (project / "cogs/final_commands.py").write_text("v3\n")
        git("commit", "-am", "guard mentions in DMs", cwd=project); git("push", "origin", "main", cwd=project)
        tip = git("rev-parse", "HEAD", cwd=project).stdout.decode().strip()
        (bins / "helio").write_text(f"#!/bin/sh\n[ \"$*\" = \"release inspect\" ] || exit 3\n"
                                    f"echo '{{\"head\": \"{self.running}\", \"tip\": \"{tip}\", \"active\": true}}'\n")
        (bins / "helio").chmod(0o755)
        lanes = root / "state/lanes"
        lanes.mkdir(parents=True)
        (lanes / "dm-mention.json").write_text(json.dumps({"status": "working", "title": "DM mention fix", "thread": "discord:1"}))
        (lanes / "old.json").write_text(json.dumps({"status": "closed", "title": "old"}))
        self.env = {**os.environ, "PATH": f"{bins}:{os.environ['PATH']}", "HELIO_GITHUB_REPO": "o/r",
                    "HELIO_PROJECT": str(project), "DORI_STATE_DIR": str(root / "state")}

    def test_reports_existing_work_from_every_source(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "reveal", "opponent", "--path", "cogs/final_commands.py"],
                                capture_output=True, text=True, env=self.env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        out = result.stdout
        self.assertIn("#2 [open] Reveal opponent shows raw mention", out)
        self.assertNotIn("Old fixed bug", out)
        self.assertIn("#7 Fix DM mentions (fix-dm) u7 [touches cogs/final_commands.py]", out)
        self.assertIn("dm-mention [working] DM mention fix", out)
        self.assertNotIn("old [closed]", out)
        self.assertIn("local-fix: 1 commit(s) not on main", out)
        self.assertRegex(out, r"== origin/main\n[0-9a-f]{40} ")
        self.assertIn(f"running {self.running} (service active)", out)
        self.assertIn("origin/main has 1 newer commit(s) touching those paths; they go live at the next restart", out)
        self.assertIn("guard mentions in DMs", out)
        self.assertIn("complete: true", out)

    def test_an_unavailable_source_is_reported_not_hidden(self):
        env = dict(self.env, HELIO_PROJECT=str(Path(self.tmp.name) / "missing"))
        result = subprocess.run([sys.executable, str(SCRIPT), "anything"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("UNAVAILABLE", result.stdout)
        self.assertIn("#2 [open]", result.stdout)
        self.assertIn("complete: false", result.stdout)

    def test_server_truncation_prints_incomplete_even_when_matches_exist(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "anything"], capture_output=True, text=True,
                                env=dict(self.env, TRIAGE_INCOMPLETE="1"), timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("complete: false", result.stdout)
        self.assertIn("#2 [open]", result.stdout)
        self.assertIn("do not assume no overlap", result.stdout)


class PaginationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = runpy.run_path(str(SCRIPT))

    def test_issue_search_reaches_later_pages_and_reports_server_truncation(self) -> None:
        import datetime
        from urllib.parse import parse_qs, urlparse

        def fake(argv, **kwargs):
            page = int(parse_qs(urlparse(argv[2]).query)["page"][0])
            items = [{"number": number, "title": "match", "state": "open",
                      "closed_at": None, "html_url": "url"} for number in
                     (range(1, 101) if page == 1 else [101])]
            return json.dumps({"items": items, "total_count": 101, "incomplete_results": page == 2})

        with patch.dict(self.module["issues"].__globals__, run=fake):
            rows, complete = self.module["issues"]("o/r", "terms", datetime.datetime.now(datetime.timezone.utc))
        self.assertEqual(len(rows), 101)
        self.assertTrue(rows[-1].startswith("#101 "))
        self.assertFalse(complete)

    def test_overlap_reaches_later_pull_and_file_pages(self) -> None:
        from urllib.parse import parse_qs, urlparse

        def fake(argv, **kwargs):
            route = urlparse(argv[2])
            page = int(parse_qs(route.query).get("page", ["1"])[0])
            if route.path == "/search/issues":
                return json.dumps({"items": [], "total_count": 0, "incomplete_results": False})
            if route.path.endswith("/pulls"):
                numbers = range(1, 101) if page == 1 else [101]
                return json.dumps([{"number": n, "title": "fix", "head": {"ref": "branch"},
                                    "html_url": "url"} for n in numbers])
            if route.path.endswith("/files"):
                if "/101/" in route.path:
                    files = [{"filename": f"other-{n}"} for n in range(100)] if page == 1 else [{"filename": "target.py"}]
                    return json.dumps(files)
                return "[]"
            return json.dumps({"changed_files": 101 if route.path.endswith("/101") else 0})

        with patch.dict(self.module["pulls"].__globals__, run=fake):
            rows, complete = self.module["pulls"]("o/r", "terms", ["target.py"])
        self.assertEqual(len(rows), 1)
        self.assertIn("#101 ", rows[0])
        self.assertTrue(complete)

    def test_sections_bound_large_backlogs_and_print_omitted_count(self) -> None:
        stream = io.StringIO()
        with redirect_stdout(stream):
            self.module["section"]("lanes", ["x" * 100_000] * 100)
        self.assertLess(len(stream.getvalue()), 20_000)
        self.assertIn("100 total", stream.getvalue())
        self.assertIn("75 omitted", stream.getvalue())

    def test_search_cap_is_incomplete_even_when_every_page_is_full(self) -> None:
        import datetime

        def fake(argv, **kwargs):
            return json.dumps({"items": [{"number": n, "title": "match", "state": "open",
                                         "closed_at": None, "html_url": "url"} for n in range(100)],
                               "total_count": 1001, "incomplete_results": False})

        with patch.dict(self.module["issues"].__globals__, run=fake):
            rows, complete = self.module["issues"]("o/r", "terms", datetime.datetime.now(datetime.timezone.utc))
        self.assertEqual(len(rows), 1000)
        self.assertFalse(complete)

    def test_file_listing_shorter_than_pull_detail_is_incomplete(self) -> None:
        def fake(argv, **kwargs):
            route = argv[2]
            if route.startswith("/search/issues"):
                return json.dumps({"items": [], "total_count": 0, "incomplete_results": False})
            if "/files?" in route:
                return json.dumps([{"filename": "target.py"}])
            if "/pulls?" in route:
                return json.dumps([{"number": 1, "title": "fix", "head": {"ref": "branch"}, "html_url": "url"}])
            return json.dumps({"changed_files": 2})

        with patch.dict(self.module["pulls"].__globals__, run=fake):
            rows, complete = self.module["pulls"]("o/r", "terms", ["target.py"])
        self.assertEqual(len(rows), 1)
        self.assertFalse(complete)


if __name__ == "__main__":
    unittest.main()
