"""Creation identity, historical immutability and uncertain-write recovery."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
M = runpy.run_path(str(ROOT / "scripts/helio_issue_followup.py"))
ISSUES = runpy.run_path(str(ROOT / "scripts/helio_issues.py"))
CLI = runpy.run_path(str(ROOT / "scripts/helio-issue.py"))


class FollowupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.issues = {8: {"number": 8, "state": "closed", "body": "Completed scope", "user": {"login": "human"}}}
        self.posts = []
        self.uncertain = False
        self.before_post = False
        self.gh = ISSUES["Issues"]("o/r", Path(self.temp.name), self.command)
        self.request = M["Request"](8, "100", "200", "New scope", "Fix the new regression.", ("bug", "confirmed"))

    def command(self, argv, stdin=None):
        if argv[:3] == ["gh", "api", "user"]:
            return "helio"
        endpoint = next(arg for arg in argv if arg.startswith("repos/"))
        if "--slurp" in argv:
            return json.dumps([[item for item in self.issues.values() if item["user"]["login"] == "helio"]])
        if "--method" in argv:
            self.assertEqual(endpoint, "repos/o/r/issues")
            self.assertEqual(argv[argv.index("--method") + 1], "POST")
            if self.before_post:
                raise ISSUES["Refused"]("Connection unavailable; write outcome unknown")
            data = json.loads(stdin)
            number = max(self.issues) + 1
            self.issues[number] = {"number": number, "state": "open", "user": {"login": "helio"}, **data}
            self.posts.append(data)
            if self.uncertain:
                self.uncertain = False
                raise ISSUES["Refused"]("Response lost after successful creation")
            return json.dumps(self.issues[number])
        return json.dumps(self.issues[int(endpoint.rsplit("/", 1)[1])])

    def test_new_task_has_linked_history_without_mutating_or_closing_the_predecessor(self):
        old = json.loads(json.dumps(self.issues[8]))
        number, url = M["create"](self.gh, self.request)
        self.assertEqual(self.issues[8], old)
        self.assertEqual((number, url), (9, "https://github.com/o/r/issues/9"))
        created = self.issues[9]
        self.assertEqual(created["state"], "open")
        self.assertEqual(M["predecessor"](created["body"]), 8)
        self.assertIn("https://github.com/o/r/issues/8", created["body"])
        self.assertNotIn("Completed scope", created["body"])
        self.assertEqual(created["labels"], ["bug", "confirmed"])
        self.assertEqual(M["create"](self.gh, self.request), (number, url))
        self.assertEqual(len(self.posts), 1)

    def test_cli_creates_from_current_files_and_returns_the_new_issue(self):
        body = Path(self.temp.name) / "scope.md"
        body.write_text("New correction; preserve the completed history.")
        argv = ["helio issue", "followup", "--previous", "8", "--channel", "100", "--message", "200",
                "--title", "Follow-up with `literal` text", "--body-file", str(body), "--labels", "bug", "confirmed"]
        namespace = CLI["main"].__globals__
        out = io.StringIO()
        with patch("sys.argv", argv), patch.dict(namespace, REPO="o/r", STATE=Path(self.temp.name)), patch.dict(
                namespace["ISSUES"], Issues=lambda repo, state: self.gh), redirect_stdout(out):
            self.assertEqual(CLI["main"](), 0)
        self.assertIn("ISSUE_FOLLOWUP issue=9 previous=8 url=https://github.com/o/r/issues/9", out.getvalue())
        self.assertEqual(self.issues[9]["title"], "Follow-up with `literal` text")
        self.assertTrue(self.issues[9]["body"].startswith(body.read_text()))
        self.assertEqual(self.issues[8]["state"], "closed")

    def test_uncertain_success_recovers_after_human_changes_to_both_issue_states(self):
        self.uncertain = True
        with self.assertRaises(ISSUES["Refused"]):
            M["create"](self.gh, self.request)
        self.issues[9]["state"] = "closed"
        self.issues[8]["state"] = "open"
        self.assertEqual(M["create"](self.gh, self.request), (9, "https://github.com/o/r/issues/9"))
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.issues[9]["state"], "closed")
        self.assertEqual(self.issues[8]["state"], "open")

    def test_unknown_absent_write_is_not_blindly_posted_again(self):
        self.before_post = True
        with self.assertRaises(ISSUES["Refused"]):
            M["create"](self.gh, self.request)
        self.before_post = False
        with self.assertRaisesRegex(M["Refused"], "remains uncertain"):
            M["create"](self.gh, self.request)
        self.assertEqual(set(self.issues), {8})
        self.assertEqual(self.posts, [])

    def test_concurrent_producers_share_one_creation_but_new_messages_remain_distinct(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: M["create"](self.gh, self.request), range(2)))
        self.assertEqual(results, [(9, "https://github.com/o/r/issues/9")] * 2)
        next_request = M["Request"](8, "100", "201", "Another task", "A separate current scope.", ("qol",))
        self.assertEqual(M["create"](self.gh, next_request), (10, "https://github.com/o/r/issues/10"))
        self.assertEqual(len(self.posts), 2)

    def test_open_predecessor_or_changed_intent_cannot_create_another_issue(self):
        self.issues[8]["state"] = "open"
        with self.assertRaises(M["Refused"]):
            M["create"](self.gh, self.request)
        self.assertEqual(self.posts, [])
        self.issues[8]["state"] = "closed"
        M["create"](self.gh, self.request)
        changed = M["Request"](8, "100", "200", "Changed scope", "A different outcome.", ("feature",))
        with self.assertRaises(M["Refused"]):
            M["create"](self.gh, changed)
        self.assertEqual(len(self.posts), 1)

    def test_malformed_lineage_is_a_reviewable_boundary_error(self):
        for value in ("null", "3", "[]", '{"previous":8}', '{"previous":true,"request":"x"}'):
            with self.subTest(value=value), self.assertRaises(M["Refused"]):
                M["predecessor"]("<!-- helio-followup:" + value + " -->")


if __name__ == "__main__":
    unittest.main()
