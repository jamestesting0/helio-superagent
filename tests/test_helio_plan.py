"""Opt-in issue plans: structured template, GitHub-held state, approval and the PR path."""
import contextlib
import copy
import datetime
import io
import json
import os
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
P = runpy.run_path(str(ROOT / "scripts/helio-plan.py"))
RC = runpy.run_path(str(ROOT / "scripts/release-check.py"))
REPO = "jamestesting0/elo-bot"
OWNER, TRUSTED, STRANGER, BOT = "100", "200", "300", "999"
POSTED = datetime.datetime(2026, 11, 4, 12, 0, tzinfo=datetime.timezone.utc)
PLAN = {
    "title": "Shorter match confirmation window", "size": "Small", "live_beta": "Not planned",
    "in_short": "Players get 8 hours instead of 24 to confirm a match, with one reminder before it expires.",
    "why": ["Unconfirmed matches hold up ratings for a whole day (reported by Spyke and F)."],
    "scope": {"changes": [{"where": "Match confirmation", "today": "24-hour window", "after": "8-hour window"},
                          {"where": "DM reminder", "today": "None", "after": "One reminder 1 hour before expiry"}],
              "not_included": ["disputes and rating maths stay as they are"]},
    "decisions": [{"question": "Window length", "decision": "8 hours", "decided_by": "F (confirmed in Discord)"},
                  {"question": "Matches already waiting", "decision": "Keep their 24 hours", "decided_by": "Helio"}],
    "done_when": ["Matches created before the change keep their 24 hours."],
    "risks": [{"level": "Low", "what": "Players abroad may miss a shorter window.", "mitigation": "The reminder covers this."}],
    "technical_notes": "Areas: match confirmation timer, reminder DMs.",
}


class FakeGitHub:
    def __init__(self):
        self.comments, self.labels, self.label_created, self.prs, self.created_bodies = [], set(), False, {}, []

    def __call__(self, argv, stdin=None, cwd=None):
        if argv[:3] == ["gh", "issue", "view"]:
            return json.dumps({"state": "OPEN", "title": "t", "comments": self.comments})
        if argv[:3] == ["gh", "api", "user"]:
            return "helio-bot"
        if argv[:2] == ["gh", "api"]:
            body = json.loads(stdin)["body"]
            if "PATCH" in argv:
                comment = next(c for c in self.comments if c["url"].endswith(argv[2].rsplit("/", 1)[1]))
                comment["body"] = body
            else:
                comment = {"author": {"login": "helio-bot"}, "body": body,
                           "url": f"https://github.com/{REPO}/issues/12#issuecomment-{len(self.comments) + 1}"}
                self.comments.append(comment)
            return json.dumps({"html_url": comment["url"]})
        if argv[:3] == ["gh", "label", "create"]:
            self.label_created = True
            return ""
        if argv[:3] == ["gh", "issue", "edit"]:
            (self.labels.add if "--add-label" in argv else self.labels.discard)(12)
            return ""
        if argv[:3] == ["gh", "issue", "list"]:
            return json.dumps([{"number": n} for n in self.labels])
        if argv[:3] == ["gh", "pr", "list"]:
            branch = argv[argv.index("--head") + 1]
            return json.dumps([{"url": self.prs[branch]}] if branch in self.prs else [])
        if argv[:3] == ["gh", "pr", "create"]:
            self.created_bodies.append(Path(argv[argv.index("--body-file") + 1]).read_text())
            self.prs[argv[argv.index("--head") + 1]] = url = f"https://github.com/{REPO}/pull/13"
            return url
        raise AssertionError(f"unexpected gh call {argv}")

    def hand_edit(self, old, new):
        self.comments[0]["body"] = self.comments[0]["body"].replace(old, new)


def discord(author=OWNER, content="please finalize issue #12 with a plan", sent=POSTED, referenced=None, for_owner=False):
    message_id = "555"
    live = {"id": message_id, "channel_id": "1", "author": {"id": author}, "content": content,
            "timestamp": sent.isoformat(), **({"referenced_message": referenced} if referenced else {})}
    payload = {"message_id": message_id, "channel_id": "1", "author_id": author, "author": "James" if author == OWNER else "Someone",
               "content": content, **({"for_owner": True} if for_owner else {})}
    return lambda _id: {"payload": payload, "live": live, "owner": OWNER, "trusted": {TRUSTED}, "channel_ok": True,
                        "is_dm": False, "bot_id": BOT, "verify": RC["verify"], "Refused": RC["Refused"]}


def announcement_of(revision):
    return {"author": {"id": BOT}, "content": f"📋 Plan for #12 (r{revision}): Players get 8 hours. Reply **approve** to start."}


class PlanCase(unittest.TestCase):
    def setUp(self):
        self.gh_fake = FakeGitHub()
        self.gh = P["GitHub"](REPO, run=self.gh_fake)
        self.dir = Path(tempfile.mkdtemp())
        self.env = patch.dict(os.environ, {"DORI_STATE_DIR": str(self.dir / "state")})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.dir)], check=True))

    def run_cli(self, *argv, discord_fn=None, now=POSTED, suite=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = P["main"](list(argv), gh=self.gh, discord=discord_fn or discord(), now=now,
                             suite=suite or (lambda project, head: 5))
        return code, out.getvalue().strip()

    def post(self, plan=PLAN, now=POSTED, request=True, discord_fn=None):
        path = self.dir / "plan.json"
        path.write_text(json.dumps(plan))
        argv = ["post", "--issue", "12", "--file", str(path), "--announcement-file", str(self.dir / "announce.txt")]
        return self.run_cli(*argv, *(["--request-message", "555"] if request else []), discord_fn=discord_fn, now=now)

    def approve(self, now, sent, referenced=None, author=OWNER, content="approve"):
        return self.run_cli("approve", "--issue", "12", "--message", "555", now=now,
                            discord_fn=discord(author=author, content=content, sent=sent, referenced=referenced))

    def data(self):
        return P["parse"](self.gh_fake.comments[0]["body"])

    def approved_plan(self):
        self.post()
        later = POSTED + datetime.timedelta(hours=1)
        self.approve(later, later, referenced=announcement_of(1))


class TemplateTests(unittest.TestCase):
    def test_only_complete_implementation_closes_its_issue(self):
        link = P["ISSUE_LINK"]
        data = {**PLAN, "revision": 2}
        result = {"scope": [{"status": "met", "evidence": "checked"} for _ in PLAN["scope"]["changes"]],
                  "done_when": [{"status": "met", "evidence": "checked"}]}
        full = P["pr_body"](12, data, "plan-url", result, "Implemented", 100)
        self.assertTrue(full.startswith("Fixes #12"))
        link["require_link"](full, {12}, "main")
        for closing, base in [(set(), "main"), ({13}, "main"), ({12}, "other")]:
            with self.assertRaises(link["Refused"]):
                link["require_link"](full, closing, base)
        result["scope"][0]["status"] = "deviation"
        partial = P["pr_body"](12, data, "plan-url", result, "Remaining work explained", 100)
        self.assertTrue(partial.startswith("Refs #12"))
        self.assertFalse(link["parse"](partial).complete)
        link["require_link"](partial, set(), "main")
        with self.assertRaises(link["Refused"]):
            link["require_link"](partial, {12}, "main")

    def errors(self, change, revision=1):
        plan = copy.deepcopy(PLAN)
        change(plan)
        return {field for field, _ in P["validate"](plan, revision)}

    def test_a_good_plan_has_no_errors(self):
        self.assertEqual(P["validate"](PLAN, 1), [])

    def test_each_limit_names_its_field(self):
        cases = {
            "scope.changes": lambda p: p["scope"].update(changes=p["scope"]["changes"] * 4),
            "in_short": lambda p: p.update(in_short="word " * 41),
            "why[0]": lambda p: p["why"].__setitem__(0, "see helio/match.py for details"),
            "decisions[0].decision": lambda p: p["decisions"][0].update(decision="TBD"),
            "done_when[0]": lambda p: p["done_when"].__setitem__(0, "The 8-hour window works."),
            "risks[0]": lambda p: p["risks"][0].update(level="Severe"),
            "title": lambda p: p.update(title="x" * 71),
            "unknown": lambda p: p.update(extra=1),
        }
        for field, change in cases.items():
            with self.subTest(field=field):
                self.assertIn(field if field != "unknown" else "extra", self.errors(change))
        self.assertIn("change_note", self.errors(lambda p: None, revision=2))
        self.assertIn("technical_notes", self.errors(lambda p: p.update(technical_notes="```\ncode\n```")))

    def test_sections_render_in_a_fixed_order_and_empty_optional_parts_disappear(self):
        data = {"open_questions": [], **PLAN, "revision": 1, "history": [{"revision": 1, "note": "first version"}], "approval": None}
        body = P["render"](12, data)
        order = ["## 📋 Plan for #12", "**Status:** Awaiting approval", "> **In short:**", "### Why", "### Scope",
                 "**Not included:**", "### Decisions", "### Done when", "### Risks", "<details>", "Revision history: r1"]
        self.assertEqual([body.index(s) for s in order], sorted(body.index(s) for s in order))
        self.assertIn("Helio's recommendation ⚑", body)
        bare = {**data, "scope": {**PLAN["scope"], "not_included": []}, "done_when": [], "decisions": [], "risks": []}
        for absent in ("Not included", "### Done when", "### Decisions", "### Risks"):
            self.assertNotIn(absent, P["render"](12, bare))

    def test_fields_round_trip_through_the_comment_even_with_html_comment_text(self):
        data = {"open_questions": [], **PLAN, "in_short": "Arrows --> and <!-- stay plain text.", "revision": 1,
                "history": [{"revision": 1, "note": "first version"}], "approval": None}
        body = P["render"](12, data)
        self.assertEqual(P["parse"](body), data)
        self.assertTrue(P["intact"](12, body, data))


class PostTests(PlanCase):
    def test_first_plan_needs_a_trusted_request_for_a_plan(self):
        for name, fn in {"stranger": discord(author=STRANGER), "for_owner": discord(for_owner=True),
                         "unrelated": discord(content="what time is it?")}.items():
            with self.subTest(name):
                code, out = self.post(discord_fn=fn)
                self.assertEqual((code, out.split()[0]), (1, "PLAN_REFUSED"))
        self.assertEqual(self.post(request=False)[0], 1)
        self.assertEqual(self.gh_fake.comments, [])

    def test_trusted_request_posts_one_labelled_comment_and_a_short_announcement(self):
        code, out = self.post(discord_fn=discord(author=TRUSTED))
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("PLAN_POSTED issue=12 revision=1 status=Awaiting_approval"))
        self.assertTrue(self.gh_fake.label_created and self.gh_fake.labels == {12})
        text = (self.dir / "announce.txt").read_text().strip()
        self.assertLessEqual(len(text), 500)
        self.assertEqual(P["PLAN_PATTERN"].match(text).groups(), ("12", "1"))
        self.assertIn("2 changes · 2 decisions (1 ⚑ Helio's call) · Live beta: not planned", text)
        self.assertEqual(self.run_cli("check", "--issue", "12"), (1, f"PLAN_AWAITING issue=12 revision=1 url={self.gh_fake.comments[0]['url']}"))

    def test_an_open_automatic_fix_blocks_plan_mode(self):
        self.gh_fake.prs["helio/autofix-12"] = "https://github.com/x/pull/9"
        code, out = self.post()
        self.assertEqual((code, out.split()[0]), (1, "PLAN_AUTOFIX_ACTIVE"))

    def test_invalid_fields_are_reported_and_nothing_is_posted(self):
        code, out = self.post(plan={**PLAN, "in_short": "TBD"})
        self.assertEqual(code, 1)
        self.assertIn("PLAN_INVALID field=in_short", out)
        self.assertEqual(self.gh_fake.comments, [])
        long_plan = {**PLAN, "why": ["a" * 150] * 3, "scope": {"changes": [{"where": "w" * 80, "today": "t" * 80, "after": "a" * 80}] * 6}}
        self.assertIn("field=plan reason=visible part", self.post(plan=long_plan)[1])

    def test_a_revision_needs_a_change_note_and_a_content_change_resets_approval(self):
        self.post()
        later = POSTED + datetime.timedelta(hours=1)
        self.assertEqual(self.approve(later, later, referenced=announcement_of(1))[0], 0)
        self.assertIn("field=change_note", self.post(now=later)[1])
        code, out = self.post(plan={**PLAN, "in_short": "Players get 6 hours to confirm.", "change_note": "window 8 to 6 hours"}, now=later)
        self.assertEqual(code, 0, out)
        self.assertIn("PLAN_APPROVAL_RESET", out)
        self.assertTrue((self.dir / "announce.txt").read_text().startswith("📋 Plan for #12 (r2): changed: window 8 to 6 hours."))


class ApprovalTests(PlanCase):
    def test_owner_reply_to_the_announcement_approves_the_current_revision(self):
        self.post()
        sent = POSTED + datetime.timedelta(hours=1)
        code, out = self.approve(POSTED + datetime.timedelta(hours=3), sent, referenced=announcement_of(1))
        self.assertEqual(code, 0, out)
        self.assertIn("by=James", out)
        self.assertEqual(self.run_cli("check", "--issue", "12")[1].split()[0], "PLAN_APPROVED")
        self.assertIn("Approved: revision 1 by James", self.gh_fake.comments[0]["body"])

    def test_wrong_people_times_and_targets_are_refused(self):
        self.post()
        hour = datetime.timedelta(hours=1)
        cases = {
            "stranger": dict(sent=POSTED + hour, author=STRANGER, referenced=announcement_of(1)),
            "before the revision": dict(sent=POSTED - hour, referenced=announcement_of(1)),
            "older than 72 hours": dict(sent=POSTED + hour, referenced=announcement_of(1), now_offset=74),
            "a merge confirmation": dict(sent=POSTED + hour, content="yes",
                                         referenced={"author": {"id": BOT}, "content": "Merge jamestesting0/elo-bot#13 (head a1b2c3d)?"}),
            "another issue": dict(sent=POSTED + hour, content="approve plan #14"),
            "no target": dict(sent=POSTED + hour, content="looks good"),
        }
        for name, case in cases.items():
            with self.subTest(name):
                now = POSTED + datetime.timedelta(hours=case.pop("now_offset", 2))
                code, out = self.approve(now, **case)
                self.assertEqual((code, out.split()[0]), (1, "PLAN_REFUSED"), out)
        self.assertEqual(self.approve(POSTED + 2 * hour, POSTED + hour, content="approve the plan for #12")[0], 0)

    def test_an_approval_of_an_older_revision_is_refused(self):
        self.post()
        later = POSTED + datetime.timedelta(hours=1)
        self.post(plan={**PLAN, "size": "Medium", "change_note": "bigger than thought"}, now=later)
        code, out = self.approve(later + datetime.timedelta(hours=2), later + datetime.timedelta(hours=1), referenced=announcement_of(1))
        self.assertEqual(code, 1)
        self.assertIn("that approves r1; the current plan is r2 (bigger than thought)", out)

    def test_open_questions_block_approval(self):
        self.post(plan={**PLAN, "open_questions": ["Should old matches keep 24 hours?"]})
        self.assertEqual(self.run_cli("check", "--issue", "12")[1].split()[0], "PLAN_DRAFT")
        self.assertTrue((self.dir / "announce.txt").read_text().startswith("📋 Plan for #12 (r1) needs answers"))
        later = POSTED + datetime.timedelta(hours=1)
        self.assertEqual(self.approve(later, later, referenced=announcement_of(1))[0], 1)


class StateTests(PlanCase):
    def test_no_plan_means_normal_mode(self):
        self.assertEqual(self.run_cli("check", "--issue", "12"), (0, "PLAN_NONE issue=12"))

    def test_hand_edits_are_detected_and_never_approved(self):
        self.approved_plan()
        self.gh_fake.hand_edit("8-hour window", "4-hour window")
        self.assertEqual(self.run_cli("check", "--issue", "12")[1].split()[0], "PLAN_EDITED_OUTSIDE_HELIO")
        later = POSTED + datetime.timedelta(hours=2)
        self.assertEqual(self.approve(later, later, referenced=announcement_of(1))[0], 1)

    def test_only_content_fields_are_bound_by_the_approval(self):
        self.approved_plan()
        data = self.data()
        self.assertTrue(P["approved"]({**data, "technical_notes": "Different notes.", "status_note": "implemented in #13"}))
        self.assertFalse(P["approved"]({**data, "done_when": ["Old matches keep 12 hours."]}))

    def test_list_counts_plans_waiting_and_drop_returns_to_normal(self):
        self.post()
        self.assertEqual(self.run_cli("list"), (0, "PLANS_AWAITING count=1 issues=#12"))
        self.assertEqual(self.run_cli("drop", "--issue", "12")[1], "PLAN_DROPPED issue=12")
        self.assertEqual(self.gh_fake.labels, set())
        self.assertEqual(self.run_cli("check", "--issue", "12")[1], "PLAN_NONE issue=12")


class SubmitTests(PlanCase):
    def setUp(self):
        super().setUp()
        git = lambda cwd, *argv: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *argv], cwd=cwd,
                                                check=True, capture_output=True, text=True).stdout.strip()
        self.git = git
        subprocess.run(["git", "init", "--bare", "-b", "main", str(self.dir / "origin.git")], check=True, capture_output=True)
        subprocess.run(["git", "clone", str(self.dir / "origin.git"), str(self.dir / "work")], check=True, capture_output=True)
        self.work = self.dir / "work"
        (self.work / "a.txt").write_text("one\n")
        git(self.work, "add", "a.txt"); git(self.work, "commit", "-m", "base"); git(self.work, "push", "origin", "HEAD:main")
        git(self.work, "checkout", "-b", "helio/issue-12")
        (self.work / "a.txt").write_text("two\n")
        git(self.work, "commit", "-am", "change")
        os.environ["HELIO_PROJECT"] = str(self.work)
        self.addCleanup(os.environ.pop, "HELIO_PROJECT", None)
        result = {"scope": [{"status": "met", "evidence": "test_window"}, {"status": "deviation", "evidence": "reminder at 50 minutes"}],
                  "done_when": [{"status": "met", "evidence": "test_old_matches"}]}
        (self.dir / "result.json").write_text(json.dumps(result))
        (self.dir / "summary.md").write_text("Shortened the window and added the reminder.")

    def submit(self, suite=None):
        return self.run_cli("pr", "submit", "--issue", "12", "--result-file", str(self.dir / "result.json"),
                            "--summary-file", str(self.dir / "summary.md"), suite=suite)

    def test_submit_refuses_without_an_approved_unchanged_plan(self):
        self.post()
        self.assertIn("PLAN_AWAITING", self.submit()[1])
        self.assertEqual(self.gh_fake.created_bodies, [])

    def test_submit_opens_one_pr_checked_against_the_plan(self):
        self.approved_plan()
        with sqlite3.connect(self.dir / "state/issue-sync.sqlite") as db:
            db.execute("UPDATE tracked SET checked_at=123456")
        code, out = self.submit()
        self.assertEqual((code, out), (0, f"PLAN_PR https://github.com/{REPO}/pull/13"))
        body = self.gh_fake.created_bodies[0]
        self.assertIn("### Against the approved plan (r1): 2 of 3 met", body)
        self.assertIn("| ⚠️ | DM reminder: None → One reminder 1 hour before expiry | reminder at 50 minutes |", body)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"), self.git(self.work, "rev-parse", "HEAD"))
        self.assertEqual(self.run_cli("check", "--issue", "12")[1].split()[0], "PLAN_APPROVED")
        self.assertIn("Approved · implemented in https://github.com", self.gh_fake.comments[0]["body"])
        self.assertEqual(self.submit()[1], f"PLAN_PR https://github.com/{REPO}/pull/13")
        self.assertEqual(len(self.gh_fake.created_bodies), 1)
        with sqlite3.connect(self.dir / "state/issue-sync.sqlite") as db:
            self.assertEqual(db.execute("SELECT checked_at FROM tracked WHERE issue=12").fetchone()[0], 0)

    def test_submit_refuses_bad_results_branches_trees_and_suites(self):
        self.approved_plan()
        (self.dir / "result.json").write_text(json.dumps({"scope": [], "done_when": []}))
        self.assertIn("result scope needs exactly 2 entries", self.submit()[1])
        self.setUp_result()
        (self.work / "a.txt").write_text("dirty\n")
        self.assertIn("worktree must be clean", self.submit()[1])
        self.git(self.work, "checkout", "--", "a.txt")
        self.git(self.work, "checkout", "-b", "other")
        self.assertIn("check out helio/issue-12", self.submit()[1])
        self.git(self.work, "checkout", "helio/issue-12")

        def failing(project, head):
            raise P["Refused"]("full unit suite must pass: run=5, failures=1")
        self.assertIn("full unit suite must pass", self.submit(suite=failing)[1])
        self.assertEqual(self.gh_fake.created_bodies, [])

    def test_a_recorded_button_click_approves_once_and_consumes_the_prompt(self):
        self.post()
        state = self.dir / "state"
        state.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(state / "discord-prompts.sqlite")) as db, db:
            db.execute("CREATE TABLE prompts (id TEXT PRIMARY KEY, status TEXT, used_at INTEGER)")
            db.execute("INSERT INTO prompts VALUES ('p1','confirmed',NULL)")
        seen = []
        def click(prompt_id, issue, data, now):
            seen.append((prompt_id, issue, data["revision"]))
            return {"username": "James", "result_id": "901"}
        with patch.dict(P, {"click_approval": click}), patch.dict(P["approve"].__globals__, {"click_approval": click}):
            code, out = self.run_cli("approve", "--issue", "12", "--confirmation", "p1", now=POSTED + datetime.timedelta(hours=1))
        self.assertEqual(code, 0, out)
        self.assertIn("PLAN_APPROVED issue=12 revision=1 by=James", out)
        self.assertEqual(seen, [("p1", 12, 1)])
        self.assertEqual(self.data()["approval"]["message"], "901")
        with contextlib.closing(sqlite3.connect(state / "discord-prompts.sqlite")) as db:
            self.assertEqual(db.execute("SELECT status FROM prompts").fetchone()[0], "used")

    def setUp_result(self):
        result = {"scope": [{"status": "met", "evidence": "t"}] * 2, "done_when": [{"status": "met", "evidence": "t"}]}
        (self.dir / "result.json").write_text(json.dumps(result))


if __name__ == "__main__":
    unittest.main()
