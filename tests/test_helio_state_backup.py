"""A live SQLite WAL snapshot can be restored independently of its source."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
import unittest

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_state_backup.py"))


class BackupTests(unittest.TestCase):
    def test_restore_includes_committed_wal_and_excludes_uncommitted_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "state"
            source.mkdir()
            with sqlite3.connect(source / "decisions.sqlite") as live:
                live.execute("PRAGMA journal_mode=WAL")
                live.execute("CREATE TABLE notes(value TEXT)")
                live.execute("INSERT INTO notes VALUES ('committed')")
                live.commit()
                (source / "lane.json").write_text('{"key":"task"}')
                saved = root / "saved"
                live.execute("INSERT INTO notes VALUES ('uncommitted')")
                M["snapshot"](source, saved)
                with sqlite3.connect(saved / "decisions.sqlite") as restored:
                    self.assertEqual(restored.execute("SELECT value FROM notes").fetchall(), [("committed",)])
                    self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(json.loads((saved / "lane.json").read_text()), {"key": "task"})
            self.assertFalse((saved / "decisions.sqlite-wal").exists())
            self.assertEqual(set(json.loads((saved / "manifest.json").read_text())), {"decisions.sqlite", "lane.json"})

    def test_snapshot_never_follows_a_state_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "state"
            source.mkdir()
            (root / "private").write_text("unrelated")
            (source / "link").symlink_to(root / "private")
            self.assertEqual(M["snapshot"](source, root / "saved"), {})
