"""Real operation storage protects issue edits and resumes notification failures."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_issues.py"))


class IssueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.body = "Human request"
        self.comments = []
        self.fail_comment = False
        self.gh = M["Issues"]("o/r", Path(self.temp.name), self.command)

    def command(self, argv, stdin=None):
        data = json.loads(stdin) if stdin else None
        if "--slurp" in argv:
            return json.dumps([self.comments])
        if argv[2].endswith("/comments"):
            if self.fail_comment:
                raise M["Refused"]("GitHub unavailable after body write")
            self.comments.append(data)
            return "{}"
        if data is not None:
            self.body = data["body"]
            return "{}"
        return json.dumps({"body": self.body, "state": "open"})

    def test_unreviewed_manual_body_is_preserved(self):
        with self.assertRaisesRegex(M["Refused"], "ISSUE_EDITED_OUTSIDE_HELIO"):
            self.gh.update(4, {"body": "Changed scope"})
        self.assertEqual(self.body, "Human request")

    def test_adopt_is_bound_to_exact_body_read(self):
        original_hash = M["digest"](self.body)
        self.body = "Someone changed the request"
        with self.assertRaises(M["Refused"]):
            self.gh.update(4, {"body": "Changed scope", "adopt": original_hash})
        self.assertEqual(self.body, "Someone changed the request")

    def test_partial_update_resumes_without_duplicate_comments(self):
        change = {"body": "Approved scope", "adopt": M["digest"](self.body), "note": "Scope clarified"}
        self.fail_comment = True
        with self.assertRaisesRegex(M["Refused"], "after body write"):
            self.gh.update(4, change)
        self.assertEqual(M["split"](self.body)[0], "Approved scope")
        self.fail_comment = False
        self.gh.update(4, change)
        self.gh.update(4, change)
        self.assertEqual(len(self.comments), 1)

    def test_status_sync_keeps_prose_and_sends_no_comment(self):
        self.gh.update(4, {"projection": "PR #6 open"})
        self.assertEqual(M["split"](self.body)[0], "Human request")
        self.assertEqual(self.comments, [])
