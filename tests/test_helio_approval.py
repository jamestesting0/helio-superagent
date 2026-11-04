"""Natural-language approvals stay bound to sender, action, target and revision."""
import datetime
import runpy
import unittest
from pathlib import Path

A = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_approval.py"))
REPO = "jamestesting0/elo-bot"
BOT = "999000000000000001"
HEAD = "a1b2c3d4" + "e" * 32
NOW = datetime.datetime(2026, 11, 3, 12, 0, tzinfo=datetime.timezone.utc)


def message(content, minutes_ago=1, referenced=None):
    sent = (NOW - datetime.timedelta(minutes=minutes_ago)).isoformat()
    return {"content": content, "timestamp": sent, **({"referenced_message": referenced} if referenced else {})}


def helio_says(content):
    return {"content": content, "author": {"id": BOT}}


def snowflake(at):
    return str(int(at.timestamp() * 1000 - 1420070400000) << 22)


class ClickTests(unittest.TestCase):
    def click(self, prompt_text, result_text, user="42", posted=3, clicked=2):
        prompt = {"id": snowflake(NOW - datetime.timedelta(minutes=posted)), "channel_id": "5", "author": {"id": BOT}, "content": prompt_text}
        at = NOW - datetime.timedelta(minutes=clicked)
        result = {"id": snowflake(at + datetime.timedelta(seconds=1)), "channel_id": "5", "author": {"id": BOT, "bot": True},
                  "content": result_text, "interaction_metadata": {"id": snowflake(at), "type": 3, "user": {"id": user},
                                                                   "interacted_message_id": prompt["id"]}}
        return result, prompt

    def test_plan_click_is_bound_to_issue_revision_and_posting_time(self):
        result, prompt = self.click("📋 Plan for #12 (r2): shorter", "✅ <@42> approved the plan for #12 (r2)", posted=120, clicked=60)
        self.assertEqual(A["check_click"]("plan", result, prompt, BOT, 12, "2", now=NOW)[0], "42")
        for number, revision, not_before in ((13, "2", None), (12, "3", None), (12, "2", NOW - datetime.timedelta(minutes=30))):
            with self.subTest(number=number, revision=revision), self.assertRaises(A["Refused"]):
                A["check_click"]("plan", result, prompt, BOT, number, revision, now=NOW, not_before=not_before)

    def test_a_pr_prompt_stays_clickable_but_its_click_is_used_within_15_minutes(self):
        pr = ("Open PR for #4 · `a1b2c3d`?\n<@42> <https://github.com/o/r/issues/4>", "✅ <@42> confirmed PR for #4 · `a1b2c3d`")
        self.assertEqual(A["check_click"]("pr", *self.click(*pr, posted=600, clicked=2), BOT, 4, HEAD, now=NOW)[0], "42")
        merge = ("Merge #6 · `a1b2c3d`?", "✅ <@42> confirmed merge #6 · `a1b2c3d`")
        for action, texts, number, clicked in (("pr", pr, 4, 20), ("merge", merge, 6, 2)):
            with self.subTest(action=action), self.assertRaises(A["Refused"]):
                A["check_click"](action, *self.click(*texts, posted=600, clicked=clicked), BOT, number, HEAD, now=NOW)

    def test_merge_wording_must_match_exactly(self):
        good = ("Merge #6 · `a1b2c3d`?", "✅ <@42> confirmed merge #6 · `a1b2c3d`")
        self.assertEqual(A["check_click"]("merge", *self.click(*good), BOT, 6, HEAD, now=NOW)[0], "42")
        for prompt_text, result_text in (("Merge #7 · `a1b2c3d`?", good[1]), (good[0], "✅ <@43> confirmed merge #6 · `a1b2c3d`"),
                                         (good[0] + "\n⌛ Expired", good[1])):
            with self.subTest(prompt=prompt_text, result=result_text), self.assertRaises(A["Refused"]):
                A["check_click"]("merge", *self.click(prompt_text, result_text), BOT, 6, HEAD, now=NOW)


class IntentTests(unittest.TestCase):
    def accepted(self, action, msg, pr=123):
        A["check_intent"](action, msg, BOT, REPO, pr if action == "merge" else None, now=NOW)

    def refused(self, action, msg, pr=123):
        with self.assertRaises(A["Refused"]):
            self.accepted(action, msg, pr)

    def test_clear_natural_requests_are_accepted(self):
        self.accepted("merge", message("yeah merge #123 please"))
        self.accepted("merge", message("ship it", referenced={"content": "PR https://github.com/jamestesting0/elo-bot/pull/123", "author": {"id": "5"}}))
        self.accepted("merge", message("approve merge jamestesting0/elo-bot#123 " + HEAD))
        self.accepted("restart", message("ok restart the bot"))

    def test_yes_counts_only_as_a_reply_to_helios_own_question(self):
        self.accepted("merge", message("yes", referenced=helio_says("Merge jamestesting0/elo-bot#123 (head a1b2c3d)?")))
        self.accepted("restart", message("go ahead", referenced=helio_says("Restart elobot at a1b2c3d?")))
        self.refused("merge", message("yes", referenced={"content": "Merge #123?", "author": {"id": "5"}}))
        self.refused("merge", message("yes"))

    def test_unrelated_or_ambiguous_messages_are_refused(self):
        self.refused("merge", message("lol #123"))
        self.refused("restart", message("nice work"))
        self.refused("merge", message("merge it"))
        self.refused("merge", message("merge #123 and #124"))
        self.refused("merge", message("merge #124"))
        self.refused("merge", message("merge it <#1218071208197623880>"))

    def test_requests_addressed_to_another_person_are_not_approvals_for_helio(self):
        owner = "653894110884921366"
        self.refused("merge", message(f"<@{owner}> merge #123"))
        self.refused("restart", {**message("can you restart the bot"), "mentions": [{"id": owner}]})
        self.accepted("merge", message(f"<@{BOT}> merge #123, cc <@{owner}>"))
        self.accepted("merge", {**message("yes", referenced=helio_says("Merge jamestesting0/elo-bot#123?")),
                                "mentions": [{"id": owner}]})

    def test_stale_and_future_messages_are_refused(self):
        self.refused("merge", message("merge #123", minutes_ago=16))
        self.refused("merge", message("merge #123", minutes_ago=-5))

    def test_natural_pr_forms_and_conversational_confirmation(self):
        for reference in ("pr 123", "PR #123", "pull 123", "pull request 123"):
            with self.subTest(reference=reference):
                self.accepted("merge", message(f"please merge {reference}"))
        for answer in ("yes that's the one", "yep go ahead", "yes please"):
            with self.subTest(answer=answer):
                self.accepted("merge", message(answer, referenced=helio_says("Merge PR 123?")))

    def test_hedged_and_multiple_target_requests_do_nothing(self):
        for content in ("yes but not yet", "yes?", "wait, merge #123", "do not merge #123",
                        "yes " + "please " * 15, "merge pr 123 and pr 124",
                        "yes if tests pass", "merge pr 123 tomorrow"):
            with self.subTest(content=content):
                self.refused("merge", message(content, referenced=helio_says("Merge PR 123?")))


class PlanApprovalTests(unittest.TestCase):
    PLAN_SAYS = helio_says("📋 Plan for #12 (r2): Players get 8 hours. Reply **approve** to start, or tell me what to change.")

    def plan(self, msg, not_before=None):
        A["check_intent"]("plan", msg, BOT, REPO, 12, now=NOW, not_before=not_before)

    def test_replies_to_a_plan_announcement_never_approve_a_merge_or_restart(self):
        for action, content in (("merge", "ship it"), ("merge", "approve"), ("restart", "yes")):
            with self.subTest(action=action, content=content), self.assertRaises(A["Refused"]):
                A["check_intent"](action, message(content, referenced=self.PLAN_SAYS), BOT, REPO, 12, now=NOW)

    def test_plan_approval_is_a_reply_to_its_announcement_or_names_the_issue(self):
        self.plan(message("approve", referenced=self.PLAN_SAYS))
        self.plan(message("lgtm, go ahead with #12"))
        for msg in (message("approve"), message("approve #13"), message("nice", referenced=self.PLAN_SAYS),
                    message("yes", referenced=helio_says("Merge jamestesting0/elo-bot#12 (head a1b2c3d)?"))):
            with self.subTest(content=msg["content"]), self.assertRaises(A["Refused"]):
                self.plan(msg)

    def test_plan_freshness_is_bound_to_the_revision_not_fifteen_minutes(self):
        self.plan(message("approve #12", minutes_ago=120), not_before=NOW - datetime.timedelta(hours=3))
        for minutes, not_before in ((120, NOW - datetime.timedelta(hours=1)), (73 * 60, None)):
            with self.subTest(minutes=minutes), self.assertRaises(A["Refused"]):
                self.plan(message("approve #12", minutes_ago=minutes), not_before=not_before)


class RevisionTests(unittest.TestCase):
    def activity(self, after, minutes_ago):
        pushed = (NOW - datetime.timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")
        return lambda repo, branch: [{"after": after, "timestamp": pushed}]

    def test_named_sha_pins_without_network(self):
        def no_network(repo, branch):
            raise AssertionError("must not query GitHub")
        A["check_revision"](HEAD, message("merge #123 a1b2c3d"), REPO, "fix", activity=no_network)

    def test_naming_a_different_sha_is_refused_without_network(self):
        def no_network(repo, branch):
            raise AssertionError("must not query GitHub")
        with self.assertRaises(A["Refused"]):
            A["check_revision"](HEAD, message("merge #123 at deadbeef"), REPO, "fix", activity=no_network)

    def test_push_before_message_pins_the_revision(self):
        A["check_revision"](HEAD, message("merge #123", minutes_ago=1), REPO, "fix", activity=self.activity(HEAD, 5))

    def test_push_after_message_or_moved_branch_is_refused(self):
        for activity in (self.activity(HEAD, 0), self.activity("f" * 40, 5), lambda repo, branch: []):
            with self.subTest(activity=activity), self.assertRaises(A["Refused"]):
                A["check_revision"](HEAD, message("merge #123", minutes_ago=1), REPO, "fix", activity=activity)


if __name__ == "__main__":
    unittest.main()
