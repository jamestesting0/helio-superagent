import io
import json
import runpy
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class MonitorDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)

    def question(self):
        module = runpy.run_path(str(ROOT / "scripts/helio-questions.py"))
        namespace = module["db_connect"].__globals__
        patcher = patch.dict(namespace, {"STATE": self.state, "OWNER": "99"})
        patcher.start()
        self.addCleanup(patcher.stop)
        db = module["db_connect"]()
        self.addCleanup(db.close)
        return module, db

    def insert_question(self, db, question_id="q1", lane="lead"):
        db.execute("""INSERT INTO questions
            (id,fingerprint,lane,audience,recipient,question,status,answer_text,updated)
            VALUES (?,?,?,?,?,?,'answered',?,0)""",
            (question_id, question_id, lane, "owner", "99", "question", "answer\n" * 20_000))
        db.commit()

    def invoke(self, module, *args):
        out = io.StringIO()
        with patch("sys.argv", ["helio", *args]), redirect_stdout(out):
            code = module["main"]()
        self.assertEqual(code, 0)
        return out.getvalue()

    def test_question_events_are_bounded_and_answers_recur_until_acknowledged(self):
        module, db = self.question()
        self.insert_question(db)
        self.insert_question(db, "q2", "other")
        seen = {}
        outputs = []
        for _ in range(3):
            out = io.StringIO()
            with redirect_stdout(out):
                module["poll"](db, "lead", seen)
            outputs.append(out.getvalue().splitlines())
        self.assertEqual(len(outputs[0]), 1)
        prefix, encoded = outputs[0][0].split(" ", 1)
        self.assertEqual(prefix, "QUESTION_ANSWERED")
        self.assertLessEqual(len(outputs[0][0]), 1000)
        self.assertEqual(json.loads(encoded)["read"], "helio question show q1")
        self.assertEqual(outputs[1], ['QUESTION_PENDING count=1 status=answered read="helio question list"'])
        self.assertEqual(outputs[2], outputs[1])
        self.invoke(module, "ack", "q1")
        out = io.StringIO()
        with redirect_stdout(out):
            module["poll"](db, "lead", seen)
        self.assertEqual(out.getvalue(), "")

    def test_question_show_pages_reconstruct_the_complete_answer_and_list_pages_all_ids(self):
        module, db = self.question()
        for i in range(60):
            self.insert_question(db, f"q{i:02}")
        ids = []
        offset = 0
        while True:
            output = self.invoke(module, "list", "--offset", str(offset))
            self.assertLess(len(output.encode()), 50_000)
            page = json.loads(output)
            ids.extend(item["id"] for item in page["items"])
            if not page["next"]:
                break
            offset = int(page["next"].split()[-1])
        self.assertEqual(ids, [f"q{i:02}" for i in range(60)])
        content = ""
        offset = 0
        while True:
            output = self.invoke(module, "show", "q00", "--offset", str(offset))
            self.assertLess(len(output.encode()), 50_000)
            page = json.loads(output)
            content += page["content"]
            if not page["truncated"]:
                break
            offset = int(page["read_more"].split()[-1])
        self.assertEqual(json.loads(content)["answer_text"], "answer\n" * 20_000)

    def test_followup_announcements_are_bounded_and_recur_as_one_count_until_done(self):
        module = runpy.run_path(str(ROOT / "scripts/helio-followups.py"))
        namespace = module["connect"].__globals__
        with patch.dict(namespace, {"STATE": self.state, "REPO": "owner/repo"}):
            db = module["connect"]()
            self.addCleanup(db.close)
            for user in ("7", "8"):
                db.execute("INSERT INTO followups (repo,issue,user_id,channel_id,reply_to,kind,created_at) VALUES ('owner/repo',1,?,'100','900','bug',0)", (user,))
            db.commit()
            def news(row, head):
                return {"event": "FOLLOWUP_LIVE", "issue": row[0], "user_id": row[1],
                        "channel_id": row[2], "reply_to": row[3], "kind": row[4], "title": "\n" * 100_000}
            out = io.StringIO()
            with patch.dict(namespace, {"news": news}), redirect_stdout(out):
                self.assertEqual(module["check"](db, False), 0)
            lines = out.getvalue().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertTrue(all(len(line) <= 1000 for line in lines))
            self.assertTrue(all(json.loads(line.split(" ", 1)[1])["read"] == "helio followups show 1" for line in lines))
            for _ in range(2):
                out = io.StringIO()
                with patch.dict(namespace, {"news": lambda *_: self.fail("announced records must not fetch news again")}), redirect_stdout(out):
                    self.assertEqual(module["check"](db, False), 0)
                self.assertEqual(out.getvalue(), 'FOLLOWUP_PENDING count=2 read="helio followups list"\n')
            page = json.loads(self.invoke(module, "show", "1"))
            self.assertTrue(page["truncated"])
            self.assertLess(len(json.dumps(page).encode()), 50_000)
            content = page["content"]
            while page["truncated"]:
                page = json.loads(self.invoke(module, "show", "1", "--offset", page["read_more"].split()[-1]))
                self.assertLess(len(json.dumps(page).encode()), 50_000)
                content += page["content"]
            records = json.loads(content)
            self.assertEqual([row["announcement"]["title"] for row in records], ["\n" * 100_000] * 2)
            self.assertEqual([row["announcement"]["event"] for row in records], ["FOLLOWUP_LIVE"] * 2)
            for user in ("7", "8"):
                self.invoke(module, "done", "--issue", "1", "--user", user)
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(module["check"](db, False), 0)
            self.assertEqual(out.getvalue(), "")

    def test_followup_list_pages_without_losing_requesters(self):
        module = runpy.run_path(str(ROOT / "scripts/helio-followups.py"))
        namespace = module["connect"].__globals__
        with patch.dict(namespace, {"STATE": self.state, "REPO": "owner/repo"}):
            with sqlite3.connect(self.state / "discord-conversations.sqlite") as db:
                module["connect"]().close()
                db.executemany("INSERT INTO followups (repo,issue,user_id,channel_id,reply_to,kind,created_at) VALUES ('owner/repo',?,'7','100','900','bug',0)",
                               [(i,) for i in range(1, 1006)])
            ids = []
            offset = 0
            while True:
                output = self.invoke(module, "list", "--offset", str(offset))
                self.assertLess(len(output.encode()), 50_000)
                rows = output.splitlines()
                ids.extend(int(line.split("issue=")[1].split()[0]) for line in rows if line.startswith("FOLLOWUP "))
                next_page = next((line for line in rows if line.startswith("FOLLOWUP_PAGE ")), "")
                if not next_page:
                    break
                offset = int(next_page.rstrip('"').split()[-1])
            self.assertEqual(ids, list(range(1, 1006)))
