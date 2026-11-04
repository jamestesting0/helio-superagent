"""Weekly review persists until delivery is acknowledged and avoids empty startup noise."""
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class DigestTests(unittest.TestCase):
    def test_changes_remain_pending_until_acknowledged(self):
        module = runpy.run_path(str(ROOT / "scripts/helio_decision_upkeep.py"))
        ledger = module["LEDGER"]
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state = home / "state"
            db = ledger["connect"](state / "decisions.sqlite")
            ledger["record"](db, ledger["Decision"]("o/r", "rule", "copy-style", "project",
                              "Use plain words", "Use plain words", "1", "owner", "100", "200", "owner"))
            db.close()
            with patch("pathlib.Path.home", return_value=home), patch.dict(os.environ, {"DORI_DISCORD_OWNER_ID": "1"}):
                first = module["check"](state, "o/r")
                self.assertEqual(module["check"](state, "o/r"), first)
                db = ledger["connect"](state / "decisions.sqlite")
                data = json.loads(db.execute("SELECT data FROM decision_digest WHERE id=?", (first["id"],)).fetchone()[0])
                self.assertEqual(data["audience"], "owner")
                self.assertEqual([item["event"] for item in data["changes"]], ["recorded"])
                db.execute("UPDATE decision_digest SET handled=1 WHERE id=?", (first["id"],))
                db.commit()
                db.close()
                self.assertIsNone(module["check"](state, "o/r"))

    def test_empty_first_boot_does_not_emit_a_digest(self):
        module = runpy.run_path(str(ROOT / "scripts/helio_decision_upkeep.py"))
        with tempfile.TemporaryDirectory() as temporary, patch("pathlib.Path.home", return_value=Path(temporary)):
            self.assertIsNone(module["check"](Path(temporary) / "state", "o/r"))
