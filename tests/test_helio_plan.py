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
        self.issue_body = "Use an 8-hour window and send one reminder."

    def __call__(self, argv, stdin=None, cwd=None):
        if argv[:3] == ["gh", "issue", "view"]:
            return json.dumps({"state": "OPEN", "title": "t", "body": self.issue_body, "comments": self.comments})
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
        if argv[:3] == ["gh", "pr", "edit"]:
            self.created_bodies[-1] = Path(argv[argv.index("--body-file") + 1]).read_text()
            return ""
        if argv[:3] == ["gh", "pr", "view"]:
            project = Path(os.environ["HELIO_PROJECT"])
            branch = next(key for key, url in self.prs.items() if url == argv[3])
            remote = subprocess.run(["git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}"],
                                    cwd=project, check=True, capture_output=True, text=True).stdout.split()[0]
            return json.dumps({"state": "OPEN", "headRefOid": remote, "headRefName": branch, "baseRefName": "main",
                               "isCrossRepository": False, "body": self.created_bodies[-1]})
        raise AssertionError(f"unexpected gh call {argv}")

    def hand_edit(self, old, new):
        self.comments[0]["body"] = self.comments[0]["body"].replace(old, new)


def discord(author=OWNER, content="please finalize issue #12 with a plan", sent=POSTED, referenced=None, for_owner=False):
    message_id = "555"
    live = {"id": message_id, "channel_id": "1", "author": {"id": author}, "content": content,
            "timestamp": sent.isoformat(), **({"referenced_message": referenced} if referenced else {})}
    payload = {"message_id": message_id, "channel_id": "1", "author_id": author, "author": "James" if author == OWNER else "Someone",
               "content": content, **({"for_owner": True} if for_owner else {})}
    return lambda _id, channel=None, fingerprint=None: {
        "payload": {**payload, **({"discord_origin": {"content_sha256": fingerprint}} if fingerprint else {})},
        "live": live, "owner": OWNER, "trusted": {TRUSTED}, "channel_ok": True,
        "is_dm": False, "bot_id": BOT, "verify": RC["verify"], "verify_source": RC["verify_source"], "Refused": RC["Refused"]}


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
        self.work_message = None
        self.approval_message = None

    def run_cli(self, *argv, discord_fn=None, now=POSTED, suite=None):
        if argv[:2] == ("work", "authorize") and discord_fn is not None:
            self.work_message = discord_fn
        reader = discord_fn
        if reader is None and argv[:2] == ("pr", "submit"):
            plan = self.data() if self.gh_fake.comments else None
            reader = self.approval_message if plan and P["approved"](plan) else self.work_message
        reader = reader or discord()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = P["main"](list(argv), gh=self.gh, discord=reader, now=now,
                             suite=suite or (lambda project, head: 5))
        return code, out.getvalue().strip()

    def post(self, plan=PLAN, now=POSTED, request=True, discord_fn=None, from_message=None):
        path = self.dir / "plan.json"
        path.write_text(json.dumps(plan))
        argv = ["post", "--issue", "12", "--file", str(path), "--announcement-file", str(self.dir / "announce.txt")]
        return self.run_cli(*argv, *(["--request-message", "555"] if request else []),
                            *(["--from-message", from_message] if from_message else []), discord_fn=discord_fn, now=now)

    def approve(self, now, sent, referenced=None, author=OWNER, content="approve"):
        source = discord(author=author, content=content, sent=sent, referenced=referenced)
        result = self.run_cli("approve", "--issue", "12", "--message", "555", now=now, discord_fn=source)
        if result[0] == 0:
            self.approval_message = source
        return result

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
    def test_long_plan_details_reach_the_real_confirmation_consumer(self):
        javascript = """
        const posts = [];
        globalThis.fetch = async (input, init) => {
          const path = new URL(String(input)).pathname.replace("/api/v10", "");
          if (path === "/channels/5" && init.method === "GET") return Response.json({id: "5", type: 0});
          if (path === "/users/@me") return Response.json({id: "88"});
          if (path === "/channels/5/messages" && init.method === "POST") {
            posts.push(JSON.parse(String(init.body)));
            return Response.json({id: "501"});
          }
          throw new Error("Unexpected synthetic Discord request: " + path);
        };
        const {main} = await import(process.env.CLI_MODULE);
        const {PromptStore} = await import(process.env.STORE_MODULE);
        const code = await main(JSON.parse(process.env.CLI_ARGS));
        const store = new PromptStore(process.env.DORI_STATE_DIR + "/discord-prompts.sqlite");
        try {
          console.log("BOUNDARY " + JSON.stringify({code, posts, row: store.get(posts[0]?.nonce)}));
        } finally { store.close(); }
        """
        cases = [
            ("live_beta", "Requested by James: " + "Verify match confirmation and reminder behavior. " * 45, 1),
            ("open_questions", ["Which behavior? " + "\U0001f4cb" * 500] * 4, 1),
            ("change_note", "Scope clarified in detail. " * 100, 2),
        ]
        for field, value, revision in cases:
            with self.subTest(field=field):
                self.gh_fake.comments.clear()
                if revision == 2:
                    self.assertEqual(self.post()[0], 0)
                code, out = self.post(plan={**PLAN, field: value})
                self.assertEqual(code, 0, out)
                data = self.data()
                self.assertEqual(data["history"][0]["note"] if field == "change_note" else data[field], value)
                state = self.dir / field
                state.mkdir()
                environment = {"PATH": os.environ["PATH"], "HOME": str(self.dir), "DORI_STATE_DIR": str(state),
                               "DORI_DISCORD_TOKEN": "synthetic", "DORI_DISCORD_ALLOWED": "5", "HELIO_GITHUB_REPO": REPO,
                               "CLI_MODULE": str(ROOT / "discord-inbound/interactive/cli.ts"),
                               "STORE_MODULE": str(ROOT / "discord-inbound/interactive/store.ts"),
                               "CLI_ARGS": json.dumps(["plan", "--issue", "12", "--revision", str(revision),
                                                       "--text-file", str(self.dir / "announce.txt"), "--channel", "5"])}
                result = subprocess.run(["bun", "-e", javascript], cwd=self.dir, env=environment,
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                observed = json.loads(next(line.removeprefix("BOUNDARY ") for line in result.stdout.splitlines()
                                           if line.startswith("BOUNDARY ")))
                self.assertEqual(observed["code"], 0)
                self.assertEqual(observed["row"]["status"], "open")
                self.assertEqual(observed["row"]["revision"], str(revision))
                self.assertEqual(len(observed["posts"]), 1)
                self.assertIn(self.gh_fake.comments[0]["url"], observed["posts"][0]["content"])
                self.assertLessEqual(len(observed["posts"][0]["content"]), 500)

    def test_useful_long_summary_and_code_references_do_not_block_a_plan(self):
        plan = {**PLAN, "in_short": " ".join(["word"] * 41),
                "why": ["Fix the behavior in common/match.py."]}
        code, out = self.post(plan=plan)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.data()["in_short"], plan["in_short"])
        self.assertLessEqual(len((self.dir / "announce.txt").read_text().strip()), 500)

    def test_quoted_plan_request_does_not_start_plan_mode(self):
        code, out = self.post(discord_fn=discord(content="> finalize #12 with a plan"))
        self.assertEqual(code, 1, out)
        self.assertEqual(self.gh_fake.comments, [])

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
        self.assertTrue(text.startswith(f"📋 Plan for [Issue #12](<https://github.com/{REPO}/issues/12>) (r1)"))
        self.assertIn("2 changes · 2 decisions (1 ⚑ Helio's call) · Live beta: not planned", text)
        self.assertEqual(self.run_cli("check", "--issue", "12"), (1, f"PLAN_AWAITING issue=12 revision=1 url={self.gh_fake.comments[0]['url']}"))

    def test_an_open_automatic_fix_blocks_plan_mode(self):
        self.gh_fake.prs["helio/autofix-12"] = "https://github.com/x/pull/9"
        code, out = self.post()
        self.assertEqual((code, out.split()[0]), (1, "PLAN_AUTOFIX_ACTIVE"))

    def test_invalid_fields_are_reported_and_nothing_is_posted(self):
        code, out = self.post(plan={**PLAN, "in_short": ""})
        self.assertEqual(code, 1)
        self.assertIn("PLAN_INVALID field=in_short", out)
        self.assertEqual(self.gh_fake.comments, [])
        long_plan = {**PLAN, "why": ["a" * 150] * 3, "scope": {"changes": [{"where": "w" * 80, "today": "t" * 80, "after": "a" * 80}] * 6}}
        code, out = self.post(plan=long_plan)
        self.assertEqual(code, 0, out)
        self.assertIn("PLAN_ADVICE field=plan", out)
        self.assertEqual(self.data()["why"], long_plan["why"])

    def test_actual_comment_overflow_is_refused_without_a_github_write(self):
        code, out = self.post(plan={**PLAN, "technical_notes": "x" * 65536})
        self.assertEqual(code, 1, out)
        self.assertIn("65536", out)
        self.assertEqual(self.gh_fake.comments, [])

    def test_a_revision_needs_a_change_note_and_a_content_change_resets_approval(self):
        self.post()
        later = POSTED + datetime.timedelta(hours=1)
        self.assertEqual(self.approve(later, later, referenced=announcement_of(1))[0], 0)
        self.assertIn("field=change_note", self.post(now=later)[1])
        code, out = self.post(plan={**PLAN, "in_short": "Players get 6 hours to confirm.", "change_note": "window 8 to 6 hours"}, now=later)
        self.assertEqual(code, 0, out)
        self.assertIn("PLAN_APPROVAL_RESET", out)
        self.assertTrue((self.dir / "announce.txt").read_text().startswith(f"📋 Plan for [Issue #12](<https://github.com/{REPO}/issues/12>) (r2): changed: window 8 to 6 hours."))


class ApprovalTests(PlanCase):
    def test_resolved_approval_with_side_question_keeps_source_and_revision_checks(self):
        self.post()
        later = POSTED + datetime.timedelta(hours=1)
        source = discord(content="Looks good, go ahead with #12. Why was that checker necessary?",
                         sent=later, referenced=announcement_of(1))
        code, out = self.run_cli("approve", "--issue", "12", "--message", "555", "--resolved-approval",
                                 now=later, discord_fn=source)
        self.assertEqual(code, 0, out)
        self.assertTrue(P["approved"](self.data()))
        for reader in (discord(author=STRANGER, content="approve #12", sent=later),
                       discord(content="approve #13", sent=later),
                       discord(content="> approve #12", sent=later),
                       discord(content="<@300> approve #12", sent=later),
                       discord(content="approve #12", sent=POSTED - datetime.timedelta(hours=1))):
            with self.subTest(reader=reader):
                self.assertEqual(self.run_cli("approve", "--issue", "12", "--message", "555",
                                             "--resolved-approval", now=later, discord_fn=reader)[0], 1)

    def test_feedback_approval_cannot_be_reused_after_a_different_revision(self):
        self.post()
        sent = POSTED + datetime.timedelta(minutes=5)
        source = discord(content="Change to six hours and proceed with #12", sent=sent, referenced=announcement_of(1))
        self.post(plan={**PLAN, "in_short": "Players get 6 hours.", "change_note": "six hours"},
                  now=sent + datetime.timedelta(minutes=5), from_message="555", discord_fn=source)
        for minute in (6, 7):
            code, out = self.run_cli("approve", "--issue", "12", "--message", "555", discord_fn=source,
                                     now=sent + datetime.timedelta(minutes=minute))
            self.assertEqual(code, 0, out)
        for revision, from_message in ((3, "555"), (4, None), (5, "555")):
            with self.subTest(revision=revision):
                self.post(plan={**PLAN, "in_short": f"Players get {revision} hours.", "change_note": "different window"},
                          now=sent + datetime.timedelta(minutes=revision + 10), from_message=from_message, discord_fn=source)
                code, out = self.run_cli("approve", "--issue", "12", "--message", "555", discord_fn=source,
                                         now=sent + datetime.timedelta(minutes=revision + 11))
                self.assertEqual(code, 1, out)
                self.assertFalse(P["approved"](self.data()))

    def test_revision_source_with_go_ahead_approves_even_before_the_revision(self):
        self.post()
        sent = POSTED + datetime.timedelta(minutes=5)
        source = discord(content="Change to six hours and proceed with #12", sent=sent, referenced=announcement_of(1))
        code, out = self.post(plan={**PLAN, "in_short": "Players get 6 hours.", "change_note": "six hours"},
                              now=sent + datetime.timedelta(minutes=5), from_message="555", discord_fn=source)
        self.assertEqual(code, 0, out)
        code, out = self.run_cli("approve", "--issue", "12", "--message", "555", discord_fn=source,
                                 now=sent + datetime.timedelta(minutes=6))
        self.assertEqual(code, 0, out)
        self.assertTrue(P["approved"](self.data()))

    def test_suggestion_source_does_not_approve_and_unrecorded_go_ahead_is_old(self):
        for content, recorded in (("Change to six hours for #12", True), ("Proceed with #12", False)):
            with self.subTest(content=content):
                self.gh_fake.comments.clear()
                self.post()
                sent = POSTED + datetime.timedelta(minutes=5)
                source = discord(content=content, sent=sent, referenced=announcement_of(1))
                self.post(plan={**PLAN, "size": "Medium", "change_note": "larger"}, now=sent + datetime.timedelta(minutes=5),
                          from_message="555" if recorded else None, discord_fn=source)
                code, out = self.run_cli("approve", "--issue", "12", "--message", "555", discord_fn=source,
                                         now=sent + datetime.timedelta(minutes=6))
                self.assertEqual(code, 1, out)
                self.assertFalse(P["approved"](self.data()))

    def test_owner_reply_to_the_announcement_approves_the_current_revision(self):
        self.post()
        sent = POSTED + datetime.timedelta(hours=1)
        code, out = self.approve(POSTED + datetime.timedelta(hours=3), sent,
                                 referenced={"author": {"id": BOT}, "content": (self.dir / "announce.txt").read_text()})
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
        self.assertTrue((self.dir / "announce.txt").read_text().startswith(f"📋 Plan for [Issue #12](<https://github.com/{REPO}/issues/12>) (r1) needs answers"))
        later = POSTED + datetime.timedelta(hours=1)
        self.assertEqual(self.approve(later, later, referenced=announcement_of(1))[0], 1)


class StateTests(PlanCase):
    def test_adopting_removed_questions_allows_approval_of_the_new_revision(self):
        self.post(plan={**PLAN, "open_questions": ["Keep the old deadline?"]})
        self.gh_fake.hand_edit("### ❓ Needs your answer\n- Keep the old deadline?\n\n", "")
        self.run_cli("check", "--issue", "12", now=POSTED + datetime.timedelta(hours=1))
        code, out = self.approve(POSTED + datetime.timedelta(hours=2), POSTED + datetime.timedelta(hours=2),
                                 content="approve #12")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.data()["open_questions"], [])

    def test_no_plan_means_normal_mode(self):
        self.assertEqual(self.run_cli("check", "--issue", "12"), (0, "PLAN_NONE issue=12"))

    def test_hand_edits_are_adopted_into_an_unapproved_revision(self):
        self.approved_plan()
        self.gh_fake.hand_edit("8-hour window", "4-hour window")
        code, out = self.run_cli("check", "--issue", "12", now=POSTED + datetime.timedelta(hours=2))
        self.assertEqual(code, 1, out)
        self.assertIn("PLAN_ADOPTED issue=12 revision=2", out)
        self.assertEqual(self.data()["scope"]["changes"][0]["after"], "4-hour window")
        self.assertFalse(P["approved"](self.data()))
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
    def test_followup_pr_preserves_its_predecessor_hold_until_explicitly_lifted(self):
        ledger = runpy.run_path(str(ROOT / "scripts/helio_decisions.py"))
        self.gh_fake.issue_body = (f"Current scope.\nRelated history: https://github.com/{REPO}/issues/8\n"
                                   '<!-- helio-followup:{"previous":8,"request":"' + "f" * 64 + '"} -->')
        original = self.gh.issue
        self.gh.issue = lambda number: {"state": "CLOSED"} if number == 8 else original(number)
        private = "Private hold details must stay in the decision ledger."
        for planned in (False, True):
            with self.subTest(approved_plan=planned):
                if planned:
                    self.approved_plan()
                else:
                    self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                                 discord_fn=discord(content="implement the new follow-up"))
                self.setUp_result(direct=not planned)
                code, out = self.submit()
                self.assertEqual(code, 0, out)
                body = self.gh_fake.created_bodies[-1]
                P["ISSUE_LINK"]["require_link"](body, {12}, "main")
                self.assertNotIn(private, body)
                state = self.dir / "state"
                with contextlib.closing(ledger["connect"](state / "decisions.sqlite")) as db:
                    identity = ledger["record"](db, ledger["Decision"](
                        REPO, "hold", "production merge", "issue#8", private, private,
                        OWNER, "owner", "1", f"hold-{planned}", "owner"))
                    with patch.dict(RC["require_no_holds"].__globals__, {"STATE": state, "REPO": REPO}):
                        with self.assertRaisesRegex(RC["Refused"], "Active issue hold"):
                            RC["require_no_holds"]("merge", {"body": body, "closingIssuesReferences": [{"number": 12}]})
                        ledger["revoke"](db, identity, OWNER, OWNER, f"lift-{planned}")
                        RC["require_no_holds"]("merge", {"body": body, "closingIssuesReferences": [{"number": 12}]})

    def test_followup_adopts_only_an_existing_pr_bound_to_its_predecessor(self):
        self.setUp_result(direct=True)
        self.git(self.work, "branch", "-m", "helio/issue-8")
        self.git(self.work, "push", "origin", "HEAD:helio/issue-8")
        self.gh_fake.issue_body = ('New scope\n<!-- helio-followup:{"previous":8,"request":"' + "f" * 64 + '"} -->')
        original = self.gh.issue

        def issue(number):
            return {"state": "CLOSED", "title": "Old task", "body": "Completed"} if number == 8 else original(number)

        self.gh.issue = issue
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement the new follow-up"))
        for unrelated in (False, True):
            with self.subTest(unrelated_pr=unrelated):
                before = []
                if unrelated:
                    self.gh_fake.prs["helio/issue-8"] = f"https://github.com/{REPO}/pull/13"
                    before = ["Fixes #99\n" + P["ISSUE_LINK"]["marker"](99, 1, True)]
                    self.gh_fake.created_bodies[:] = before
                code, out = self.run_cli("pr", "submit", "--issue", "12", "--worktree", str(self.work),
                                         "--result-file", str(self.dir / "result.json"),
                                         "--summary-file", str(self.dir / "summary.md"))
                self.assertEqual(code, 1, out)
                self.assertEqual(self.gh_fake.created_bodies, before)

    def test_linked_followup_retargets_its_open_predecessor_pr_only_with_current_authority(self):
        self.setUp_result(direct=True)
        self.git(self.work, "branch", "-m", "helio/issue-8")
        self.git(self.work, "push", "origin", "HEAD:helio/issue-8")
        self.gh_fake.prs["helio/issue-8"] = f"https://github.com/{REPO}/pull/13"
        self.gh_fake.created_bodies.append("Fixes #8\n" + P["ISSUE_LINK"]["marker"](8, 1, True))
        self.gh_fake.issue_body = ("Current full PR scope.\nRelated history: https://github.com/" + REPO +
                                  '/issues/8\n<!-- helio-followup:{"previous":8,"request":"' + "f" * 64 + '"} -->')
        original = self.gh.issue

        def issue(number):
            return {"state": "CLOSED", "body": "Completed scope", "title": "Old work"} if number == 8 else original(number)

        self.gh.issue = issue
        previous = Path.cwd()
        os.chdir(self.work)
        self.addCleanup(os.chdir, previous)
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertIn("no recorded work request", out)
        self.assertTrue(self.gh_fake.created_bodies[0].startswith("Fixes #8"))
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement the current correction to PR #13"))
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.gh_fake.created_bodies), 1)
        self.assertTrue(self.gh_fake.created_bodies[0].startswith("Fixes #12"))
        self.assertEqual(P["ISSUE_LINK"]["parse"](self.gh_fake.created_bodies[0]).issue, 12)
        self.assertIn(f"https://github.com/{REPO}/issues/8", self.gh_fake.created_bodies[0])
        self.assertEqual(self.submit()[0], 0)
        self.assertEqual(len(self.gh_fake.created_bodies), 1)

    def test_explicit_named_lane_submits_without_an_issue_number_in_its_branch(self):
        self.approved_plan()
        branch = "helio/balance-facts-tips-current"
        self.git(self.work, "branch", "-m", branch)
        head = self.git(self.work, "rev-parse", "HEAD")
        code, out = self.run_cli("pr", "submit", "--issue", "12", "--worktree", str(self.work),
                                 "--result-file", str(self.dir / "result.json"),
                                 "--summary-file", str(self.dir / "summary.md"))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", branch), head)
        self.assertEqual(self.git(self.work, "branch", "--show-current"), branch)

    def test_current_named_lane_wins_over_an_old_issue_numbered_tree(self):
        self.approved_plan()
        old_head = self.git(self.work, "rev-parse", "HEAD")
        task = self.dir / "balance-facts-tips"
        branch = "helio/balance-facts-tips-current"
        self.git(self.work, "worktree", "add", "-b", branch, str(task))
        (task / "balance.txt").write_text("new follow-up work\n")
        self.git(task, "add", "balance.txt")
        self.git(task, "commit", "-m", "balance the facts")
        head = self.git(task, "rev-parse", "HEAD")
        previous = Path.cwd()
        try:
            os.chdir(task)
            code, out = self.submit()
        finally:
            os.chdir(previous)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.work, "ls-remote", "--heads", "origin", f"refs/heads/{branch}"),
                         f"{head}\trefs/heads/{branch}")
        self.assertEqual(self.git(self.work, "rev-parse", "HEAD"), old_head)
        self.assertEqual(self.git(self.work, "ls-remote", "--heads", "origin", "refs/heads/helio/issue-12"), "")

    def test_explicit_task_selection_rejects_protected_autofix_and_wrong_issue_branches(self):
        self.approved_plan()
        for branch in ("shared-work", "helio/autofix-12", "helio/issue-13"):
            with self.subTest(branch=branch):
                self.git(self.work, "branch", "-m", branch)
                code, out = self.run_cli("pr", "submit", "--issue", "12", "--worktree", str(self.work),
                                         "--result-file", str(self.dir / "result.json"),
                                         "--summary-file", str(self.dir / "summary.md"))
                self.assertEqual(code, 1, out)
                self.assertEqual(self.git(self.work, "ls-remote", "--heads", "origin", f"refs/heads/{branch}"), "")
                self.assertEqual(self.gh_fake.created_bodies, [])

    def test_discovery_preserves_non_ascii_worktree_paths(self):
        self.approved_plan()
        self.git(self.work, "branch", "-m", "shared-work")
        task = self.dir / "lane-\u00e9"
        self.git(self.work, "worktree", "add", "-b", "helio/issue12-window", str(task))
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue12-window"),
                         self.git(task, "rev-parse", "HEAD"))

    def test_legacy_message_approval_uses_recorded_location_after_delivery_ack(self):
        self.approved_plan()
        data = self.data()
        for key in ("author", "channel", "source_hash"):
            data["approval"].pop(key)
        self.gh_fake.comments[0]["body"] = P["render"](12, data)
        with sqlite3.connect(self.dir / "state/discord-conversations.sqlite") as db:
            db.execute("CREATE TABLE working (message_id TEXT,channel_id TEXT)")
            db.execute("INSERT INTO working VALUES ('555','1')")
        original = self.approval_message

        def accepted_source(message, channel=None, fingerprint=None):
            if channel != "1":
                raise P["Refused"]("delivery already acknowledged; source location required")
            return original(message, channel, fingerprint)

        self.approval_message = accepted_source
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"),
                         self.git(self.work, "rev-parse", "HEAD"))

    def test_ambiguous_issue_trees_require_selection_without_switching_either(self):
        self.approved_plan()
        other = self.dir / "alternate"
        self.git(self.work, "worktree", "add", "-b", "helio/issue12-alternate", str(other))
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertIn("2 matching trees", out)
        code, out = self.run_cli("pr", "submit", "--issue", "12", "--worktree", str(self.work),
                                 "--result-file", str(self.dir / "result.json"),
                                 "--summary-file", str(self.dir / "summary.md"))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(other, "branch", "--show-current"), "helio/issue12-alternate")

    def test_existing_pr_wrong_base_cannot_receive_another_push(self):
        self.approved_plan()
        self.assertEqual(self.submit()[0], 0)
        previous = self.git(self.work, "rev-parse", "HEAD")
        (self.work / "b.txt").write_text("follow-up\n")
        self.git(self.work, "add", "b.txt")
        self.git(self.work, "commit", "-m", "follow-up")
        original = self.gh.run

        def wrong_base(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[:3] == ["gh", "pr", "view"]:
                return json.dumps({**json.loads(result), "baseRefName": "other"})
            return result

        self.gh.run = wrong_base
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"), previous)

    def test_submission_uses_the_recorded_issue_lane_branch(self):
        self.approved_plan()
        self.git(self.work, "branch", "-m", "helio/issue12-window")
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue12-window"),
                         self.git(self.work, "rev-parse", "HEAD"))

    def test_task_change_during_suite_cannot_be_pushed_as_verified(self):
        self.approved_plan()

        def suite(project, head):
            (self.work / "a.txt").write_text("unverified edit\n")
            return 5

        code, out = self.submit(suite=suite)
        self.assertEqual(code, 1, out)
        self.assertEqual(self.git(self.work, "ls-remote", "--heads", "origin", "refs/heads/helio/issue-12"), "")
        self.assertEqual(self.gh_fake.created_bodies, [])

    def test_shared_interpreter_verifies_committed_tests_without_task_venv(self):
        import sys
        self.approved_plan()
        (self.work / "tests").mkdir()
        (self.work / "tests/test_task.py").write_text(
            "import unittest\nfrom pathlib import Path\n"
            "class Task(unittest.TestCase):\n"
            "    def test_committed_content(self):\n"
            "        self.assertEqual(Path('a.txt').read_text(), 'two\\n')\n")
        self.git(self.work, "add", "tests")
        self.git(self.work, "commit", "-m", "task regression")
        shared = self.dir / "shared"
        self.git(self.work, "worktree", "add", str(shared), "main")
        (shared / ".venv/bin").mkdir(parents=True)
        (shared / ".venv/bin/python").symlink_to(sys.executable)
        with patch.dict(os.environ, {"HELIO_PROJECT": str(shared)}):
            code, out = self.submit(suite=P["full_suite"])
        self.assertEqual(code, 0, out)
        self.assertIn("Full unit suite: 1 tests passed", self.gh_fake.created_bodies[0])
        self.assertFalse((self.work / ".venv").exists())

    def test_submission_finds_the_task_tree_without_touching_dirty_shared_main(self):
        self.approved_plan()
        shared = self.dir / "shared"
        self.git(self.work, "worktree", "add", str(shared), "main")
        (shared / "unrelated.txt").write_text("keep this\n")
        with patch.dict(os.environ, {"HELIO_PROJECT": str(shared)}):
            code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual((shared / "unrelated.txt").read_text(), "keep this\n")
        self.assertEqual(self.git(shared, "branch", "--show-current"), "main")
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"),
                         self.git(self.work, "rev-parse", "HEAD"))

    def test_new_commits_update_the_existing_pr_and_actual_remote_head(self):
        self.setUp_result(direct=True)
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement #12"))
        self.assertEqual(self.submit()[0], 0)
        (self.work / "b.txt").write_text("follow-up\n")
        self.git(self.work, "add", "b.txt")
        self.git(self.work, "commit", "-m", "follow-up")
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"),
                         self.git(self.work, "rev-parse", "HEAD"))
        self.assertEqual(len(self.gh_fake.created_bodies), 1)

    def test_existing_pr_update_rechecks_revoked_source_before_pushing(self):
        self.setUp_result(direct=True)
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement #12"))
        self.assertEqual(self.submit()[0], 0)
        previous = self.git(self.work, "rev-parse", "HEAD")
        (self.work / "b.txt").write_text("follow-up\n")
        self.git(self.work, "add", "b.txt")
        self.git(self.work, "commit", "-m", "follow-up")
        self.work_message = discord(author=STRANGER, content="implement #12")
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"), previous)

    def test_remote_ancestor_is_updated_without_force(self):
        self.approved_plan()
        self.git(self.work, "push", "origin", "HEAD:helio/issue-12")
        (self.work / "b.txt").write_text("follow-up\n")
        self.git(self.work, "add", "b.txt")
        self.git(self.work, "commit", "-m", "follow-up")
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"),
                         self.git(self.work, "rev-parse", "HEAD"))

    def test_advancing_main_is_merged_in_the_owned_tree_before_verification(self):
        self.approved_plan()
        shared = self.dir / "shared"
        self.git(self.work, "worktree", "add", str(shared), "main")
        (shared / "base.txt").write_text("new main\n")
        self.git(shared, "add", "base.txt")
        self.git(shared, "commit", "-m", "advance main")
        self.git(shared, "push", "origin", "main")
        checked = []
        code, out = self.submit(suite=lambda project, head: checked.append(head) or 5)
        self.assertEqual(code, 0, out)
        self.assertEqual((self.work / "base.txt").read_text(), "new main\n")
        self.assertEqual(checked, [self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12")])

    def test_main_push_during_verification_requires_verifying_the_updated_tree(self):
        self.approved_plan()
        shared = self.dir / "shared"
        self.git(self.work, "worktree", "add", str(shared), "main")

        def advance(project, head):
            (shared / "base.txt").write_text("owner update\n")
            self.git(shared, "add", "base.txt")
            self.git(shared, "commit", "-m", "owner update")
            self.git(shared, "push", "origin", "main")
            return 5

        code, out = self.submit(suite=advance)
        self.assertEqual(code, 1, out)
        self.assertEqual(self.gh_fake.created_bodies, [])
        self.assertEqual(self.git(self.work, "ls-remote", "--heads", "origin", "helio/issue-12"), "")
        checked = []
        code, out = self.submit(suite=lambda project, head: checked.append(head) or 5)
        self.assertEqual(code, 0, out)
        self.assertEqual((self.work / "base.txt").read_text(), "owner update\n")
        self.assertEqual(checked, [self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12")])

    def test_main_push_during_pr_creation_is_not_reported_as_verified_delivery(self):
        self.approved_plan()
        shared = self.dir / "shared"
        self.git(self.work, "worktree", "add", str(shared), "main")
        original = self.gh.run

        def create_with_new_main(argv, stdin=None, **kwargs):
            result = original(argv, stdin, **kwargs)
            if argv[:3] == ["gh", "pr", "create"]:
                (shared / "base.txt").write_text("new main during publication\n")
                self.git(shared, "add", "base.txt")
                self.git(shared, "commit", "-m", "owner update")
                self.git(shared, "push", "origin", "main")
            return result

        self.gh.run = create_with_new_main
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertNotIn("PLAN_PR ", out)
        self.gh.run = original
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.gh_fake.created_bodies), 1)
        self.assertEqual((self.work / "base.txt").read_text(), "new main during publication\n")

    def test_conflicting_main_preserves_both_sides_until_owned_resolution(self):
        self.approved_plan()
        shared = self.dir / "shared"
        self.git(self.work, "worktree", "add", str(shared), "main")
        (shared / "a.txt").write_text("owner intent\n")
        self.git(shared, "add", "a.txt")
        self.git(shared, "commit", "-m", "owner change")
        self.git(shared, "push", "origin", "main")
        owner_head = self.git(shared, "rev-parse", "HEAD")
        code, out = self.submit()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.git(self.work, "show", ":2:a.txt"), "two")
        self.assertEqual(self.git(self.work, "show", ":3:a.txt"), "owner intent")
        self.assertEqual(self.gh_fake.created_bodies, [])
        (self.work / "a.txt").write_text("owner intent\ntwo\n")
        self.git(self.work, "add", "a.txt")
        self.git(self.work, "commit", "-m", "preserve owner and task changes")
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        head = self.git(self.work, "rev-parse", "HEAD")
        self.assertEqual(self.git(self.work, "merge-base", owner_head, head), owner_head)
        self.assertEqual(self.git(shared, "rev-parse", "HEAD"), owner_head)

    def test_wrong_repository_explicit_tree_is_rejected(self):
        self.approved_plan()
        other = self.dir / "other"
        self.git(self.work, "clone", str(self.dir / "origin.git"), str(other))
        self.git(other, "checkout", "-b", "helio/issue-12")
        code, out = self.run_cli("pr", "submit", "--issue", "12", "--worktree", str(other),
                                 "--result-file", str(self.dir / "result.json"),
                                 "--summary-file", str(self.dir / "summary.md"))
        self.assertEqual(code, 1, out)
        self.assertEqual(self.gh_fake.created_bodies, [])

    def test_remote_divergence_is_preserved_and_never_reported_as_success(self):
        self.approved_plan()
        self.git(self.work, "push", "origin", "HEAD:helio/issue-12")
        other = self.dir / "other"
        self.git(self.work, "clone", str(self.dir / "origin.git"), str(other))
        self.git(other, "checkout", "helio/issue-12")
        (other / "remote.txt").write_text("someone else's work\n")
        self.git(other, "add", "remote.txt")
        self.git(other, "commit", "-m", "remote work")
        remote = self.git(other, "rev-parse", "HEAD")

        def concurrent_update(project, head):
            self.git(other, "push", "origin", "helio/issue-12")
            return 5

        code, out = self.submit(suite=concurrent_update)
        self.assertEqual(code, 1, out)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"), remote)
        self.assertEqual(self.gh_fake.created_bodies, [])

    def test_uncertain_successful_creation_is_read_back_without_a_duplicate(self):
        self.setUp_result(direct=True)
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement #12"))
        original = self.gh.run

        def lost_response(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[:3] == ["gh", "pr", "create"]:
                raise P["Refused"]("response lost after GitHub created the PR")
            return result

        self.gh.run = lost_response
        self.assertEqual(self.submit()[0], 1)
        self.gh.run = original
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.gh_fake.created_bodies), 1)
        self.assertEqual(self.git(self.dir / "origin.git", "rev-parse", "helio/issue-12"),
                         self.git(self.work, "rev-parse", "HEAD"))

    def test_clear_work_request_does_not_need_an_issue_number_that_was_created_afterward(self):
        self.setUp_result(direct=True)
        code, out = self.run_cli(
            "work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
            discord_fn=discord(content="please make a separate pr for those errors (do not do it with ulw)"))
        self.assertEqual(code, 0, out)
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.gh_fake.created_bodies), 1)

    def test_repeating_direct_submission_returns_the_existing_pr_without_new_authorization(self):
        self.setUp_result(direct=True)
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement #12"))
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        code, out = self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                                 discord_fn=discord(content="implement #12"))
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("WORK_AUTHORIZED"), out)
        self.assertIn("creation=used", out)
        self.assertEqual(self.submit(), (0, f"PLAN_PR https://github.com/{REPO}/pull/13"))
        self.assertEqual(len(self.gh_fake.created_bodies), 1)

    def test_failed_pr_creation_does_not_spend_the_work_request(self):
        self.setUp_result(direct=True)
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement #12"))
        original = self.gh.run

        def fail_create(argv, **kwargs):
            if argv[:3] == ["gh", "pr", "create"]:
                raise P["Refused"]("GitHub unavailable before creation")
            return original(argv, **kwargs)

        self.gh.run = fail_create
        self.assertEqual(self.submit()[0], 1)
        self.gh.run = original
        code, out = self.submit()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.gh_fake.created_bodies), 1)

    def setUp(self):
        super().setUp()
        git = lambda cwd, *argv: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *argv], cwd=cwd,
                                                check=True, capture_output=True, text=True).stdout.strip()
        self.git = git
        subprocess.run(["git", "init", "--bare", "-b", "main", str(self.dir / "origin.git")], check=True, capture_output=True)
        subprocess.run(["git", "clone", str(self.dir / "origin.git"), str(self.dir / "work")], check=True, capture_output=True)
        self.work = self.dir / "work"
        git(self.work, "config", "user.name", "t")
        git(self.work, "config", "user.email", "t@t")
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

    def test_quoted_work_request_never_authorizes_a_pull_request(self):
        code, out = self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                                 discord_fn=discord(content="> implement #12"))
        self.assertEqual(code, 1, out)
        (self.dir / "result.json").write_text(json.dumps({"scope": [{"status": "met", "evidence": "window tested"}], "done_when": []}))
        self.assertEqual(self.submit()[0], 1)
        self.assertEqual(self.gh_fake.created_bodies, [])

    def test_work_authorization_cannot_bypass_draft_awaiting_or_adopted_plans(self):
        for name, expected in (("draft", "PLAN_DRAFT"), ("awaiting", "PLAN_AWAITING"), ("adopted", "PLAN_AWAITING")):
            with self.subTest(state=name), patch.dict(os.environ, {"DORI_STATE_DIR": str(self.dir / name)}):
                self.gh_fake.comments.clear()
                self.gh_fake.prs.clear()
                self.gh_fake.created_bodies.clear()
                self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                             discord_fn=discord(content="implement #12"))
                if name == "adopted":
                    self.approved_plan()
                    self.gh_fake.hand_edit("8-hour window", "4-hour window")
                else:
                    self.post(plan={**PLAN, "open_questions": ["Which deadline?"] if name == "draft" else []})
                (self.dir / "result.json").write_text(json.dumps({"scope": [{"status": "met", "evidence": "window tested"}], "done_when": []}))
                code, out = self.submit()
                self.assertEqual(code, 1, out)
                self.assertIn(expected, out)
                self.assertEqual(self.gh_fake.created_bodies, [])
                self.run_cli("drop", "--issue", "12")
                code, out = self.submit()
                self.assertEqual(code, 0, out)

    def test_no_plan_results_render_each_requirement_and_keep_partial_issues_open(self):
        for complete in (False, True):
            with self.subTest(complete=complete), patch.dict(os.environ, {"DORI_STATE_DIR": str(self.dir / str(complete))}):
                self.gh_fake.prs.clear()
                self.gh_fake.created_bodies.clear()
                self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                             discord_fn=discord(content="implement #12"))
                result = {"scope": [{"status": "met", "evidence": "window verified"},
                                    {"status": "met" if complete else "deviation", "evidence": "reminder proof or remaining work"}],
                          "done_when": []}
                (self.dir / "result.json").write_text(json.dumps(result))
                code, out = self.submit()
                self.assertEqual(code, 0, out)
                body = self.gh_fake.created_bodies[0]
                self.assertIn("window verified", body)
                self.assertIn("reminder proof or remaining work", body)
                self.assertTrue(body.startswith(("Fixes" if complete else "Refs") + " #12"), body)
                self.assertEqual(P["ISSUE_LINK"]["parse"](body).complete, complete)

    def test_no_plan_results_reject_empty_scope_and_malformed_later_requirement(self):
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(content="implement #12"))
        for rows in ([], [{"status": "met", "evidence": "window verified"}, {"status": "met", "evidence": ""}]):
            with self.subTest(rows=rows):
                (self.dir / "result.json").write_text(json.dumps({"scope": rows, "done_when": []}))
                code, out = self.submit()
                self.assertEqual(code, 1, out)
                self.assertEqual(self.gh_fake.created_bodies, [])

    def test_recorded_work_uses_current_issue_scope_and_partial_metadata(self):
        code, out = self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                                 discord_fn=discord(content="implement issue #12"))
        self.assertEqual(code, 0, out)
        self.assertIn("WORK_AUTHORIZED issue=12 message=555 channel=1", out)
        self.gh_fake.issue_body = "Use a 6-hour window and send one reminder."
        (self.dir / "result.json").write_text(json.dumps({"scope": [{"status": "deviation", "evidence": "reminder pending"}], "done_when": []}))
        code, out = self.run_cli("pr", "submit", "--issue", "12", "--result-file", str(self.dir / "result.json"),
                                 "--summary-file", str(self.dir / "summary.md"), now=POSTED + datetime.timedelta(days=6))
        self.assertEqual(code, 0, out)
        body = self.gh_fake.created_bodies[0]
        self.assertIn("Use a 6-hour window and send one reminder.", body)
        self.assertIn("Refs #12", body)
        self.assertIn('"complete": false', body)
        self.assertIn('"plan_revision": null', body)
        self.assertEqual(self.gh_fake.labels, set())
        self.gh_fake.prs.clear()
        self.assertEqual(self.submit()[0], 1)

    def test_recorded_work_survives_elapsed_time_and_closes_a_complete_issue(self):
        self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                     discord_fn=discord(author=TRUSTED, content="fix #12"))
        (self.dir / "result.json").write_text(json.dumps({"scope": [{"status": "met", "evidence": "window and reminder tested"}], "done_when": []}))
        code, out = self.run_cli("pr", "submit", "--issue", "12", "--result-file", str(self.dir / "result.json"),
                                 "--summary-file", str(self.dir / "summary.md"), now=POSTED + datetime.timedelta(days=8))
        self.assertEqual(code, 0, out)
        self.assertIn("Fixes #12", self.gh_fake.created_bodies[0])
        self.assertIn('"complete": true', self.gh_fake.created_bodies[0])

    def test_work_recording_rechecks_identity_location_and_is_idempotent(self):
        for fn, channel in ((discord(author=STRANGER, content="fix #12"), "1"),
                            (discord(content="<@300> fix #12"), "1"),
                            (discord(content="fix #12", sent=POSTED - datetime.timedelta(hours=73)), "1"),
                            (discord(content="fix #12"), "2")):
            with self.subTest(channel=channel):
                code, out = self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", channel, discord_fn=fn)
                self.assertEqual(code, 1, out)
        self.assertEqual(self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                                     discord_fn=discord(content="fix #12"))[0], 0)
        code, out = self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                                 discord_fn=discord(content="fix #12"))
        self.assertEqual(code, 0, out)

    def test_changed_or_revoked_work_source_cannot_create_a_pr(self):
        for reader in (discord(content="cancel this work"), discord(author=STRANGER, content="implement #12")):
            with self.subTest(reader=reader):
                self.run_cli("work", "authorize", "--issue", "12", "--message", "555", "--channel", "1",
                             discord_fn=discord(content="implement #12"))
                self.work_message = reader
                self.setUp_result(direct=True)
                code, out = self.submit()
                self.assertEqual(code, 1, out)
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

    def setUp_result(self, direct=False):
        result = {"scope": [{"status": "met", "evidence": "t"}] * 2,
                  "done_when": [] if direct else [{"status": "met", "evidence": "t"}]}
        (self.dir / "result.json").write_text(json.dumps(result))


if __name__ == "__main__":
    unittest.main()
