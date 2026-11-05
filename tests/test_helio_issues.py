"""Real operation storage protects issue edits and resumes notification failures."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_issues.py"))
SYNC = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_issue_sync.py"))
CLI = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio-issue.py"))


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

    def test_description_change_needs_a_public_log_note(self):
        with self.assertRaisesRegex(M["Refused"], "ISSUE_NOTE_REQUIRED"):
            self.gh.update(4, {"body": "Changed scope", "adopt": M["digest"](self.body)})
        self.assertEqual(self.body, "Human request")
        self.gh.update(4, {"body": "Changed scope", "adopt": M["digest"](self.body), "note": "Loss cap is -30"})
        self.assertIn("Loss cap is -30", self.comments[0]["body"])

    def test_milestones_after_first_use_are_logged_once(self):
        events = [("pr6:opened", "PR #6 opened", 900.0), ("pr6:merged", "PR #6 merged", 1100.0)]
        self.assertEqual(self.gh.log_milestones(4, events[:1], now=1000.0), [])
        self.assertEqual(self.gh.log_milestones(4, events, now=1200.0), ["PR #6 merged"])
        self.assertEqual(self.gh.log_milestones(4, events, now=1300.0), [])
        self.assertEqual(len(self.comments), 1)
        self.assertIn("PR #6 merged", self.comments[0]["body"])


class ReviewTests(unittest.TestCase):
    def test_discussion_stays_due_until_reviewed_and_reminds_at_a_bounded_rate(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            SYNC["mark_discussed"](state, "o/r", 8, 100)
            self.assertEqual(SYNC["reminders"](state, "o/r", 200), [])
            self.assertEqual(len(SYNC["reminders"](state, "o/r", 800)), 1)
            self.assertEqual(SYNC["reminders"](state, "o/r", 900), [])
            self.assertIn("issues/8", SYNC["reminders"](state, "o/r", 2700)[0])
            SYNC["mark_reviewed"](state, "o/r", 8, 2800, "nothing new")
            self.assertEqual(SYNC["reminders"](state, "o/r", 9000), [])
            SYNC["mark_discussed"](state, "o/r", 8, 9100)
            self.assertEqual(len(SYNC["reminders"](state, "o/r", 9800)), 1)

    def test_read_path_omits_helio_comments_and_already_reviewed_discussion(self):
        info = {"comments": [
            {"author": {"login": "helio"}, "body": "**Issue updated:** log", "createdAt": "2026-11-05T10:00:00Z"},
            {"author": {"login": "jpk"}, "body": "old idea", "createdAt": "2026-11-05T09:00:00Z"},
            {"author": {"login": "jpk"}, "body": "season is two months", "createdAt": "2026-11-05T11:00:00Z"},
        ]}
        since = CLI["timestamp"]("2026-11-05T10:30:00Z")
        self.assertEqual([c["body"] for c in CLI["human_comments"](info, "helio", since)], ["season is two months"])
