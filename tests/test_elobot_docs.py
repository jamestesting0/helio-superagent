"""Content-preserving migration of installed operator runbooks."""
from pathlib import Path
import os
import runpy
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO

ROOT = Path(__file__).resolve().parent.parent
DOCS = runpy.run_path(str(ROOT / "scripts/organize-elobot-docs.py"))


class DocumentationMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / ".dori/elobot"
        self.base.mkdir(parents=True)
        for name in DOCS["RUNBOOKS"]:
            path = self.base / name
            path.write_bytes(("local operator content: " + name).encode())
            path.chmod(0o640)

    def test_preview_and_move_preserve_local_bytes_modes_and_legacy_paths(self):
        before = {name: (self.base / name).read_bytes() for name in DOCS["RUNBOOKS"]}
        with redirect_stdout(StringIO()):
            DOCS["organize"](self.base, False)
        self.assertFalse((self.base / "docs").exists())
        with redirect_stdout(StringIO()):
            DOCS["organize"](self.base, True)
            DOCS["organize"](self.base, True)
        for name, content in before.items():
            self.assertEqual((self.base / "docs" / name).read_bytes(), content)
            self.assertEqual((self.base / name).read_bytes(), content)
            self.assertEqual(os.readlink(self.base / name), f"docs/{name}")
            self.assertEqual(stat.S_IMODE((self.base / name).stat().st_mode), 0o640)

    def test_collision_refuses_every_move(self):
        docs = self.base / "docs"
        docs.mkdir()
        name = DOCS["RUNBOOKS"][-1]
        (docs / name).write_text("different local copy")
        with self.assertRaises(SystemExit):
            DOCS["organize"](self.base, True)
        self.assertEqual((docs / name).read_text(), "different local copy")
        self.assertTrue(all(not (self.base / name).is_symlink() for name in DOCS["RUNBOOKS"]))

    def test_refuses_symlinked_documentation_directory(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (self.base / "docs").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(SystemExit):
            DOCS["organize"](self.base, True)
        self.assertEqual(list(outside.iterdir()), [])

    def test_resumes_interrupted_move_without_overwriting_index(self):
        docs = self.base / "docs"
        docs.mkdir()
        name = DOCS["RUNBOOKS"][0]
        (self.base / name).rename(docs / name)
        (docs / "README.md").write_text("local navigation")
        with redirect_stdout(StringIO()):
            DOCS["organize"](self.base, True)
        self.assertEqual(os.readlink(self.base / name), f"docs/{name}")
        self.assertEqual((docs / "README.md").read_text(), "local navigation")


class OriginalDocumentationMigrationTests(unittest.TestCase):
    def test_two_runbook_install_preserves_local_content_and_adds_beta_runbook(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / ".dori/elobot"
            base.mkdir(parents=True)
            for name in ("discord-qa-workflow.md", "oracle-restart-workflow.md"):
                (base / name).write_text("local instructions for " + name)
                (base / name).chmod(0o640)
            new_runbook = b"beta maintenance runbook"
            with redirect_stdout(StringIO()):
                DOCS["organize"](base, True, {"beta-maintenance-workflow.md": new_runbook,
                                             "autofix-workflow.md": b"automatic fix runbook",
                                             "issue-plan-workflow.md": b"issue plan runbook",
                                             "decisions-workflow.md": b"decision runbook",
                                             "issue-truth-workflow.md": b"issue truth runbook",
                                             "startup-recovery-workflow.md": b"startup recovery runbook"})
            for name in ("discord-qa-workflow.md", "oracle-restart-workflow.md"):
                self.assertEqual((base / name).read_text(), "local instructions for " + name)
                self.assertEqual(os.readlink(base / name), f"docs/{name}")
                self.assertEqual(stat.S_IMODE((base / name).stat().st_mode), 0o640)
            self.assertEqual((base / "beta-maintenance-workflow.md").read_bytes(), new_runbook)
            self.assertEqual(os.readlink(base / "beta-maintenance-workflow.md"),
                             "docs/beta-maintenance-workflow.md")
            self.assertEqual((base / "docs/decisions-workflow.md").read_bytes(), b"decision runbook")
            self.assertEqual((base / "docs/issue-truth-workflow.md").read_bytes(), b"issue truth runbook")
