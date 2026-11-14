"""Natural-language approvals stay bound to sender, action, target and revision."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
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
    def test_linked_confirmation_binds_the_visible_target_destination_and_clicker(self):
        actor = "**[James](<https://discord.com/users/42?tab=wishlist>)**"
        target = f"[PR #6](<https://github.com/{REPO}/pull/6>)"
        prompt = f"Merge {target} · `a1b2c3d`?"
        result = f"✅ {actor} confirmed merge {target} · `a1b2c3d`"
        self.assertEqual(A["check_click"]("merge", *self.click(prompt, result), BOT, 6, HEAD, now=NOW, repo=REPO)[0], "42")
        legacy = result.replace("?tab=wishlist", "")  # results posted before profile links carried the tab
        self.assertEqual(A["check_click"]("merge", *self.click(prompt, legacy), BOT, 6, HEAD, now=NOW, repo=REPO)[0], "42")
        for changed_prompt, changed_result in (
            (prompt.replace(REPO, "other/repository"), result),
            (prompt.replace("PR #6", "PR #7"), result),
            (prompt.replace("PR #6", "Issue #6").replace("/pull/", "/issues/"), result),
            (prompt, result.replace("/users/42", "/users/43")),
            (prompt, result.replace("/pull/6", "/pull/7")),
        ):
            with self.subTest(prompt=changed_prompt, result=changed_result), self.assertRaises(A["Refused"]):
                A["check_click"]("merge", *self.click(changed_prompt, changed_result), BOT, 6, HEAD, now=NOW, repo=REPO)

    def test_linked_plan_announcement_still_authorizes_only_its_issue_and_revision(self):
        target = f"[Issue #12](<https://github.com/{REPO}/issues/12>)"
        prompt = f"📋 Plan for {target} (r2): shorter"
        result = f"✅ **[James](<https://discord.com/users/42?tab=wishlist>)** approved the plan for {target} (r2)"
        self.assertEqual(A["check_click"]("plan", *self.click(prompt, result), BOT, 12, "2", now=NOW, repo=REPO)[0], "42")
        A["check_intent"]("plan", message("yes", referenced=helio_says(prompt)), BOT, REPO, 12, now=NOW)
        with self.assertRaises(A["Refused"]):
            A["check_intent"]("merge", message("yes", referenced=helio_says(prompt)), BOT, REPO, 12, now=NOW)

    def test_used_plan_click_revalidates_proof_and_current_trust_without_spending_again(self):
        import os
        import sqlite3
        import tempfile
        from unittest.mock import patch
        checker = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/release-check.py"))
        result, prompt = self.click("📋 Plan for #12 (r2): shorter", "✅ <@42> approved the plan for #12 (r2)")
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            with sqlite3.connect(state / "discord-prompts.sqlite") as db:
                db.execute("CREATE TABLE prompts (id,kind,action,target,revision,status,result_message_id,message_id,channel_id)")
                db.execute("INSERT INTO prompts VALUES (?,?,?,?,?,?,?,?,?)",
                           ("a" * 20, "plan", "plan", REPO + "#12", "2", "used", result["id"], prompt["id"], "5"))
            responses = {f"/channels/5/messages/{result['id']}": result,
                         f"/channels/5/messages/{prompt['id']}": prompt, "/users/@me": {"id": BOT}}
            with patch.dict(os.environ, {"DORI_DISCORD_TOKEN": "synthetic", "DORI_DISCORD_OWNER_ID": "42",
                                         "DORI_DISCORD_ALLOWED": "5"}), \
                    patch.dict(checker["load_click"].__globals__, STATE=state,
                               api=lambda path, token: responses[path], location=lambda *args: (True, False)):
                value = checker["load_click"]("a" * 20, "plan", REPO + "#12", "2",
                                               now=NOW + datetime.timedelta(days=10), accepted_plan=True)
                self.assertEqual(value["clicker"], "42")
                with self.assertRaises(checker["Refused"]):
                    checker["load_click"]("a" * 20, "plan", REPO + "#12", "2", now=NOW)
                with patch.dict(checker["load_click"].__globals__, location=lambda *args: (False, False)):
                    with self.assertRaises(checker["Refused"]):
                        checker["load_click"]("a" * 20, "plan", REPO + "#12", "2", accepted_plan=True)
                result["content"] = "cancelled"
                with self.assertRaises(checker["Refused"]):
                    checker["load_click"]("a" * 20, "plan", REPO + "#12", "2", accepted_plan=True)
            with sqlite3.connect(state / "discord-prompts.sqlite") as db:
                self.assertEqual(db.execute("SELECT status FROM prompts").fetchone()[0], "used")

    def click(self, prompt_text, result_text, user="42", posted=3, clicked=2):
        prompt = {"id": snowflake(NOW - datetime.timedelta(minutes=posted)), "channel_id": "5", "author": {"id": BOT}, "content": prompt_text}
        at = NOW - datetime.timedelta(minutes=clicked)
        result = {"id": snowflake(at + datetime.timedelta(seconds=1)), "channel_id": "5", "author": {"id": BOT, "bot": True},
                  "content": result_text, "interaction_metadata": {"id": snowflake(at), "type": 3, "user": {"id": user},
                                                                   "interacted_message_id": prompt["id"]}}
        return result, prompt

    def test_a_train_click_binds_every_listed_pr_its_head_and_whether_it_restarts(self):
        line = lambda n, sha: f"[PR #{n}](<https://github.com/{REPO}/pull/{n}>) · `{sha}` Change {n}"
        prompt = "\n".join(["Merge 2 PRs and restart Elo Bot?", line(18, "2532d55"), line(20, "bc113f3"),
                            "Tested together: unit and integration tests passed."])
        result = "✅ **[James](<https://discord.com/users/42?tab=wishlist>)** approved merging #18 and #20 and restarting Elo Bot"
        self.assertEqual(A["check_click"]("train-restart", *self.click(prompt, result), BOT, None, HEAD, now=NOW, repo=REPO,
                                          expected_prompt=prompt)[0], "42")
        self.assertEqual(A["train_members"](prompt, REPO), {18: "2532d55", 20: "bc113f3"})
        for action, changed_prompt, changed_result in (
            ("train", prompt, result),                                                   # restart not asked for
            ("train-restart", prompt.replace("#20", "#21").replace("/20>", "/21>"), result),  # a different member
            ("train-restart", prompt, result.replace(" and restarting Elo Bot", "")),     # result for another prompt
        ):
            with self.subTest(action=action), self.assertRaises(A["Refused"]):
                A["check_click"](action, *self.click(changed_prompt, changed_result), BOT, None, HEAD, now=NOW, repo=REPO,
                                 expected_prompt=prompt)

    def test_a_typed_yes_to_a_train_prompt_approves_its_members_at_their_pinned_heads_only(self):
        """Gate review 2026-11-13: a yes replying to a train accepted a different head, and counted a left-out PR."""
        prompt = helio_says("\n".join([
            "Merge #18?", f"[PR #18](<https://github.com/{REPO}/pull/18>) · `a1b2c3d` Change 18",
            "Tested with current main: unit and integration tests passed.", "#20 isn't included: it conflicts with #18 in app.py."]))
        yes = message("yes", referenced=prompt)
        A["check_intent"]("merge", yes, BOT, REPO, {18}, now=NOW)
        A["check_revision"](HEAD, yes, REPO, "helio/issue-18", bot_id=BOT, pr=18)
        for revision, pr in (("f" * 40, 18), (HEAD, 20)):
            with self.subTest(revision=revision, pr=pr), self.assertRaises(A["Refused"]):
                A["check_revision"](revision, yes, REPO, "helio/issue-18", bot_id=BOT, pr=pr)

    def test_a_readiness_condition_is_an_approval_but_other_conditions_are_not(self):
        """2026-11-13: "is pr 27 ready? if so merge it and deploy" was refused as conditional and cost a second decision."""
        for text in ("is pr 27 ready? if so merge it and deploy", "merge #27 and restart if it's ready.",
                     "if ready, merge #27 and restart", "if green then please merge #27 and deploy",
                     "can you merge #27 and restart the bot?", "could you please merge #27 and deploy?",
                     "merge #27 and deploy if checks pass", "if green merge #27 and restart"):
            with self.subTest(text=text):
                A["check_intent"]("merge", message(text), BOT, REPO, 27, now=NOW)
                A["check_intent"]("restart", message(text), BOT, REPO, None, now=NOW)
        incident = message(f"<@{BOT}> is pr 27 ready? if so merge it and deploy")  # the exact 2026-11-13 request
        A["check_intent"]("merge", incident, BOT, REPO, 27, now=NOW)
        A["check_intent"]("restart", incident, BOT, REPO, None, now=NOW)
        pushed = [{"after": HEAD, "timestamp": (NOW - datetime.timedelta(hours=1)).isoformat()}]
        A["check_revision"](HEAD, incident, REPO, "helio/issue-23", activity=lambda repo, branch: pushed, bot_id=BOT, pr=27)
        with self.assertRaises(A["Refused"]):  # another person's mention is not Helio's
            A["check_intent"]("merge", message("<@123456789012345678> is pr 27 ready? if so merge it"), BOT, REPO, 27, now=NOW)
        for text in ("merge #27 if Bob agrees", "merge #27 if not busy", "should I merge #27?", "merge #27 tomorrow",
                     "merge #27 if tests pass and Bob agrees", "if ready and nobody objects merge #27",
                     "if ready, and nobody objects, merge #27 and deploy",
                     "if ready, please get Bob's approval, then merge #27 and deploy",
                     "merge #27 and deploy only with Bob's approval if ready",
                     "if ready, go ahead and get Bob's approval, then merge #27 and deploy",
                     "can you merge #27 and deploy after Bob checks?", "can you merge #27?? not sure"):
            with self.subTest(text=text), self.assertRaises(A["Refused"]):
                A["check_intent"]("merge", message(text), BOT, REPO, 27, now=NOW)

    def test_a_train_prompt_names_the_already_merged_prs_its_restart_deploys(self):
        prompt = "Merge #27 and restart Elo Bot?\n#27 · `1be01ab` x\nAlso deploys already-merged #18, #20, #22 and #26.\nTested."
        self.assertEqual(A["train_ships"](prompt, REPO), {18, 20, 22, 26})
        self.assertEqual(A["train_ships"]("Merge #27?\n#27 · `1be01ab` x", REPO), set())

    def test_train_heads_cover_ten_to_nineteen_prs(self):
        self.assertTrue(A["TRAIN_HEAD"].fullmatch("Merge 12 PRs and restart Elo Bot?"))

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
                A["check_click"](action, *self.click(*texts, posted=900, clicked=clicked), BOT, number, HEAD, now=NOW)

    def test_release_clicks_remain_valid_for_twelve_hours_at_the_same_revision(self):
        for action, number in (("merge", 6), ("restart", None)):
            texts = (A["prompt_line"](action, number, HEAD), A["result_line"](action, number, HEAD, "42"))
            with self.subTest(action=action):
                result, prompt = self.click(*texts, posted=670, clicked=660)
                self.assertEqual(A["check_click"](action, result, prompt, BOT, number, HEAD, now=NOW)[0], "42")
                with self.assertRaises(A["Refused"]):
                    A["check_click"](action, result, prompt, BOT, number, "f" * 40, now=NOW)
                with self.assertRaises(A["Refused"]):
                    A["check_click"](action, result, prompt, BOT, number, HEAD, now=NOW + datetime.timedelta(hours=2))

    def test_merge_wording_must_match_exactly(self):
        good = ("Merge #6 · `a1b2c3d`?", "✅ <@42> confirmed merge #6 · `a1b2c3d`")
        self.assertEqual(A["check_click"]("merge", *self.click(*good), BOT, 6, HEAD, now=NOW)[0], "42")
        for prompt_text, result_text in (("Merge #7 · `a1b2c3d`?", good[1]), (good[0], "✅ <@43> confirmed merge #6 · `a1b2c3d`"),
                                         (good[0] + "\n⌛ Expired", good[1])):
            with self.subTest(prompt=prompt_text, result=result_text), self.assertRaises(A["Refused"]):
                A["check_click"]("merge", *self.click(prompt_text, result_text), BOT, 6, HEAD, now=NOW)


class IntentTests(unittest.TestCase):
    def test_work_records_the_resolved_request_without_requiring_a_magic_phrase(self):
        for text in (
            "please make a separate pr to handle those errors gracefully "
            "(this is a small change do not do it with ulw)",
            "implement #12 what was the checker?",
            "implement #12, too many unnecessary checks and validation",
            "could you fix the problem we just discussed?",
        ):
            with self.subTest(content=text):
                A["check_intent"]("work", message(text), BOT, REPO, 12, now=NOW)

    def test_quoted_or_fenced_commands_never_authorize_an_action(self):
        for action, text in (("work", "implement #12"), ("merge", "merge #12"),
                             ("restart", "restart the bot"), ("plan", "approve #12")):
            for content in ("> " + text, "  > " + text, ">>>\n" + text,
                            "```\n" + text + "\n```", "```" + text + "```",
                            *(("evidence only\n> " + text,) if action != "work" else ())):
                with self.subTest(action=action, content=content), self.assertRaises(A["Refused"]):
                    A["check_intent"](action, message(content), BOT, REPO, 12, now=NOW)

    def test_quoted_targets_and_quoted_helio_context_do_not_supply_authority(self):
        for action, content in (("merge", "merge\n> #12"),
                                ("plan", "approve\n> #12")):
            with self.subTest(action=action), self.assertRaises(A["Refused"]):
                A["check_intent"](action, message(content), BOT, REPO, 12, now=NOW)
        with self.assertRaises(A["Refused"]):
            A["check_intent"]("merge", message("yes", referenced=helio_says("> Merge #12?")), BOT, REPO, 12, now=NOW)

    def test_only_authored_text_counts_alongside_quotes_forwards_and_embeds(self):
        msg = {**message("> wait, do not merge #99\nmerge #12"),
               "message_snapshots": [{"message": {"content": "restart the bot"}}],
               "embeds": [{"description": "merge #99"}]}
        A["check_intent"]("merge", msg, BOT, REPO, 12, now=NOW)
        for evidence in ({"embeds": [{"description": "merge #12"}]},
                         {"message_snapshots": [{"message": {"content": "merge #12"}}]}):
            with self.subTest(evidence=evidence), self.assertRaises(A["Refused"]):
                A["check_intent"]("merge", {**message("evidence only"), **evidence}, BOT, REPO, 12, now=NOW)
        with self.assertRaises(A["Refused"]):
            A["check_intent"]("merge", {**message(f"<@42> merge #12\n> <@{BOT}>"),
                                       "mentions": [{"id": "42"}, {"id": BOT}]}, BOT, REPO, 12, now=NOW)

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
        self.refused("merge", message("merge #123", minutes_ago=721))
        self.refused("merge", message("merge #123", minutes_ago=-5))

    def test_release_requests_are_valid_at_eleven_hours_but_not_after_twelve(self):
        for action, text in (("merge", "merge #123"), ("restart", "restart the bot")):
            with self.subTest(action=action):
                self.accepted(action, message(text, minutes_ago=660))
                self.refused(action, message(text, minutes_ago=721))

    def test_recorded_work_is_never_a_release_approval(self):
        for text in ("implement #12", "build https://github.com/jamestesting0/elo-bot/issues/12",
                     "fix issue #12", "proceed with #12", "go ahead with #12", "do it for #12"):
            with self.subTest(text=text):
                A["check_intent"]("work", message(text), BOT, REPO, 12, now=NOW)
                self.refused("merge", message(text), pr=12)
                self.refused("restart", message(text))
        A["check_intent"]("work", message("yes", referenced=helio_says("Implement issue #12?")), BOT, REPO, 12, now=NOW)
        for msg in (message("<@42> fix #12"), message("> implement #12"),
                    message("fix #12", minutes_ago=72 * 60 + 1)):
            with self.subTest(message=msg), self.assertRaises(A["Refused"]):
                A["check_intent"]("work", msg, BOT, REPO, 12, now=NOW)
        A["check_intent"]("work", {**message("fix #12", minutes_ago=8 * 24 * 60),
                                   "_helio_accepted_work": True}, BOT, REPO, 12, now=NOW)

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
                        "yes if Bob agrees", "merge pr 123 tomorrow"):
            with self.subTest(content=content):
                self.refused("merge", message(content, referenced=helio_says("Merge PR 123?")))


class PlanApprovalTests(unittest.TestCase):
    def test_resolved_plan_intent_cannot_relax_merge_or_restart_parsing(self):
        for action in ("merge", "restart"):
            with self.subTest(action=action), self.assertRaises(A["Refused"]):
                A["check_intent"](action, message(f"{action} #12 if tests pass"), BOT, REPO, 12,
                                  now=NOW, resolved_plan=True)

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
    def test_quoted_commit_cannot_pin_a_revision_pushed_after_the_approval(self):
        with self.assertRaises(A["Refused"]):
            A["check_revision"](HEAD, message("restart the bot\n> " + HEAD), REPO, "main",
                                 activity=self.activity(HEAD, 0))

    def test_quoted_merge_does_not_turn_restart_into_a_combined_approval(self):
        self.assertIsNone(A["combined_pr"](message("restart the bot\n> merge #12"), REPO, BOT))

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

    def test_eleven_hour_approval_still_refuses_a_changed_revision(self):
        with self.assertRaises(A["Refused"]):
            A["check_revision"](HEAD, message("merge #123", minutes_ago=660), REPO, "fix", activity=self.activity(HEAD, 30))


class FenceJoinTests(unittest.TestCase):
    def test_removed_code_never_joins_surrounding_words_into_an_action(self):
        with self.assertRaises(A["Refused"]):
            A["check_intent"]("restart", message("rest```evidence```art the bot"), BOT, REPO, None, now=NOW)
