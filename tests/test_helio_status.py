import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import io
import os
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class IntakeStatusTests(unittest.TestCase):
    def test_counts_distinguish_pending_claims_acceptance_and_held_conversations(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / "state"
            state.mkdir()
            with closing(sqlite3.connect(state / "discord-conversations.sqlite")) as db:
                db.executescript("""
                    CREATE TABLE working (message_id TEXT,closed_at INTEGER,claimed_at INTEGER,reacted INTEGER);
                    INSERT INTO working VALUES ('claimed',NULL,10,0),('finished',20,10,0),('window',NULL,NULL,0);
                    CREATE TABLE conversations (channel_id TEXT,user_id TEXT,opened_at INTEGER,status TEXT);
                    INSERT INTO conversations VALUES ('100','99',1,'open'),('100','77',1,'open'),
                        ('100','66',1,'on_hold'),('100','55',1,'resolved');
                    CREATE TABLE transcript (channel_id TEXT,user_id TEXT,opened_at INTEGER,author_id TEXT);
                    INSERT INTO transcript VALUES ('100','99',1,'88'),('100','99',1,'99'),
                        ('100','77',1,'77'),('100','77',1,'88'),('100','66',1,'66');
                """)
            with closing(sqlite3.connect(state / "discord-delivery.sqlite")) as db:
                db.executescript("""
                    CREATE TABLE delivery (stream TEXT,id TEXT,payload TEXT);
                    INSERT INTO delivery VALUES ('inbound','claimed','{}'),('inbound','finished','{}'),
                        ('inbound','window','{}'),('inbound','accepted','{}'),('context','context','{}');
                    CREATE TABLE acceptance (stream TEXT,id TEXT);
                    INSERT INTO acceptance VALUES ('inbound','accepted');
                """)
            output = io.StringIO()
            command = subprocess.CompletedProcess([], 1, stdout="", stderr="")
            with patch.object(Path, "home", return_value=home), patch.dict(os.environ, {"DORI_STATE_DIR": str(state)}), \
                    patch("subprocess.run", return_value=command), redirect_stdout(output):
                runpy.run_path(str(ROOT / "scripts/helio-status.py"), run_name="__main__")
            fields = dict(line.split(": ", 1) for line in output.getvalue().splitlines())
            self.assertEqual(fields["Pending inbound"], "4")
            self.assertEqual(fields["Unclaimed pending inbound"], "2")
            self.assertEqual(fields["Claims in progress"], "1")
            self.assertEqual(fields["Conversations waiting on Helio"], "1")
