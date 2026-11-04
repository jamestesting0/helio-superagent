"""Decision CLI verifies live human provenance and pages complete active guidance."""
from contextlib import redirect_stdout
from dataclasses import replace
import datetime
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class DecisionCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.module = runpy.run_path(str(ROOT / "scripts/helio-decide.py"))
        self.namespace = self.module["main"].__globals__
        self.namespace["STATE"] = self.state
        self.namespace["REPO"] = "o/r"
        content = "From now on use plain language"
        self.live = {"id": "200", "channel_id": "100", "author": {"id": "1"}, "content": content,
                     "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        self.context = {"payload": {"message_id": "200", "channel_id": "100", "author_id": "1", "content": content},
                        "live": self.live, "owner": "1", "trusted": {"2"}, "channel_ok": True, "is_dm": True, "bot_id": "9"}
        self.patch = patch.dict(self.namespace["CHECK"], {"load": lambda _: self.context})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        (self.state / "statement").write_text("Use plain language")
        (self.state / "quote").write_text(content)

    def invoke(self, *args):
        output = io.StringIO()
        with redirect_stdout(output):
            code = self.module["main"](list(args))
        return code, output.getvalue()

    def record_args(self):
        code, listed = self.invoke("list", "--active", "--scope", "project")
        self.assertEqual(code, 0)
        return ["record", "--message", "200", "--kind", "rule", "--topic", "copy-style",
                "--scope", "project", "--statement-file", str(self.state / "statement"),
                "--quote-file", str(self.state / "quote"), "--reviewed", json.loads(listed)["review_hash"]]

    def test_owner_instruction_is_sourced_and_private(self):
        self.assertEqual(self.invoke(*self.record_args())[0], 0)
        ledger = self.namespace["LEDGER"]
        db = ledger["connect"](self.state / "decisions.sqlite")
        self.addCleanup(db.close)
        rows = ledger["active"](db, "o/r")
        self.assertEqual([(item["author_id"], item["visibility"], item["quote"]) for item in rows],
                         [("1", "owner", self.live["content"])])

    def test_stranger_edited_and_for_owner_messages_are_refused(self):
        args = self.record_args()
        for variant in ("stranger", "edited", "for_owner"):
            with self.subTest(variant=variant), patch.dict(self.live, {}), patch.dict(self.context["payload"], {}):
                if variant == "stranger":
                    self.live["author"] = {"id": "3"}
                    self.context["payload"]["author_id"] = "3"
                elif variant == "edited":
                    self.live["content"] += " changed"
                else:
                    self.context["payload"]["for_owner"] = True
                self.assertEqual(self.invoke(*args)[0], 2)

    def test_paging_retrieves_every_decision_without_source_bloat(self):
        ledger = self.namespace["LEDGER"]
        db = ledger["connect"](self.state / "decisions.sqlite")
        rule = ledger["Decision"]("o/r", "rule", "t", "project", "Rule", "Rule", "1", "owner", "100", "200", "owner", source="private source")
        for number in range(20):
            ledger["record"](db, replace(rule, topic=f"t{number}", message_id=str(200 + number)))
        db.close()
        offset, content = 0, ""
        while True:
            code, output = self.invoke("list", "--active", "--offset", str(offset))
            self.assertEqual(code, 0)
            page = json.loads(output)
            content += page["content"]
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        self.assertEqual(len(json.loads(content)), 20)
        self.assertNotIn("private source", content)
