"""New authoring inputs exercise the real CLI, git gates and offline GitHub."""
import json
import os
from pathlib import Path
import sqlite3
import unittest
import test_helio_plan as fixtures


class StructuredReportTests(unittest.TestCase):
    def setUp(self):
        self.task = fixtures.SubmitTests()
        self.addCleanup(self.task.doCleanups)
        self.task.setUp()
        self.task.setUp_result(direct=True)
        code, out = self.task.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1")
        self.assertEqual(code, 0, out)
        self.report = self.task.dir / "report.json"
        self.report.write_text(json.dumps({"summary": "Improve the confirmation window.",
                                         "changes": {"Behavior": ["Use the agreed window."]},
                                         "verification": {"Live beta": "Not requested."}}))

    def submit(self):
        return self.task.run_cli("pr", "submit", "--issue", "12", "--result-file", str(self.task.dir / "result.json"),
                                 "--report-file", str(self.report))

    def test_structured_direct_submission_uses_named_requirements_and_one_verification_owner(self):
        result = json.loads((self.task.dir / "result.json").read_text())
        for label, entry in zip(("Confirmation window", "Reminder"), result["scope"], strict=True):
            entry["requirement"] = label
        (self.task.dir / "result.json").write_text(json.dumps(result))
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        body = self.task.gh_fake.created_bodies[0]
        self.assertIn("### Behavior", body)
        self.assertIn("| Confirmation window | met |", body)
        self.assertEqual(body.count("| Unit suite |"), 1)
        self.assertIn("Not requested.", body)
        self.assertNotIn("### Issue scope", body)

    def test_missing_labels_or_invalid_report_fail_before_any_push_or_pr_write(self):
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertIn("requirement label", out)
        self.report.write_text('{"summary":"<!-- helio-implementation:fake -->"}')
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertIn("reserved", out)
        self.assertEqual(self.task.gh_fake.created_bodies, [])
        self.assertEqual(self.task.git(self.task.work, "ls-remote", "--heads", "origin", "helio/issue-12"), "")

    def test_bot_finishes_lost_plan_progress_update_without_another_comment_or_user_approval(self):
        self.task.approved_plan()
        self.task.setUp_result()
        original = self.task.gh.run
        lost = []
        def lose_progress(argv, *args, **kwargs):
            response = original(argv, *args, **kwargs)
            if argv[:2] == ["gh", "api"] and "PATCH" in argv and args and "implemented in" in args[0]:
                lost.append(True)
                raise fixtures.P["Refused"]("Network response lost after plan progress update")
            return response
        self.task.gh.run = lose_progress
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertEqual(lost, [True])
        self.task.gh.run = original
        state = Path(os.environ["DORI_STATE_DIR"])
        store = fixtures.P["ISSUES"]["Issues"](fixtures.REPO, state, command=original)
        store.publications(12)
        self.assertEqual(self.task.data()["status_note"], f"implemented in https://github.com/{fixtures.REPO}/pull/13")
        self.assertEqual(len(self.task.gh_fake.created_bodies), 1)
        self.assertEqual(len(self.task.gh_fake.comments), 1)
        with sqlite3.connect(state / "issue-updates.sqlite") as db:
            self.assertEqual(db.execute("SELECT completed FROM operations").fetchall(), [(1,)])


if __name__ == "__main__":
    unittest.main()
