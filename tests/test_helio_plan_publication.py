"""Plan-comment retries preserve identity and revision after uncertain writes."""
import copy
import json
import sqlite3
import datetime
import fcntl
import hashlib
import signal
import shlex
from pathlib import Path

from test_helio_plan import PlanCase, REPO, P, PLAN, POSTED


class PlanPublicationTests(PlanCase):
    def edit_when_saving(self, text="8-hour window", during_authorization=False):
        save = self.gh.save

        def raced(number, comment_id, body, authorize=None, **kwargs):
            if during_authorization:
                def checked():
                    result = authorize()
                    self.gh_fake.hand_edit(text, "HUMAN EDIT: preserve this choice")
                    return result
                return save(number, comment_id, body, checked, **kwargs)
            self.gh_fake.hand_edit(text, "HUMAN EDIT: preserve this choice")
            return save(number, comment_id, body, authorize, **kwargs)

        self.gh.save = raced

    def test_post_preserves_a_human_edit_between_review_and_save(self) -> None:
        self.assertEqual(self.post()[0], 0)
        self.edit_when_saving()
        code, output = self.post({**PLAN, "in_short": "Players get six hours.", "change_note": "Six-hour window"})
        self.assertEqual(code, 1, output)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])
        self.assertEqual(self.data()["revision"], 1)

    def test_post_rechecks_the_preimage_after_source_revalidation(self) -> None:
        self.assertEqual(self.post()[0], 0)
        self.edit_when_saving(during_authorization=True)
        code, output = self.post({**PLAN, "in_short": "Players get six hours.", "change_note": "Six-hour window"})
        self.assertEqual(code, 1, output)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])

    def test_deadline_during_source_revalidation_retains_the_prepared_operation(self) -> None:
        self.assertEqual(self.post()[0], 0)
        save = self.gh.save

        def interrupted(number, comment_id, body, authorize=None, **kwargs):
            def expired():
                signal.raise_signal(signal.SIGALRM)
            return save(number, comment_id, body, expired, **kwargs)

        self.gh.save = interrupted
        code, output = self.post({**PLAN, "in_short": "Players get six hours.", "change_note": "Six-hour window"})
        self.assertEqual(code, 2, output)
        self.assertIn("deadline", output)
        self.assertEqual(self.data()["revision"], 1)

    def test_approval_preserves_an_intervening_human_edit(self) -> None:
        self.assertEqual(self.post()[0], 0)
        self.edit_when_saving()
        later = POSTED + datetime.timedelta(hours=1)
        code, output = self.approve(later, later, content="approve plan #12")
        self.assertEqual(code, 1, output)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])

    def test_adoption_preserves_a_second_human_edit_after_review(self) -> None:
        self.assertEqual(self.post()[0], 0)
        self.gh_fake.hand_edit("8-hour window", "4-hour window")
        self.edit_when_saving("4-hour window")
        code, output = self.run_cli("adopt", "--issue", "12")
        self.assertEqual(code, 1, output)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])

    def test_drop_preserves_an_intervening_human_edit(self) -> None:
        self.assertEqual(self.post()[0], 0)
        self.edit_when_saving()
        code, output = self.run_cli("drop", "--issue", "12")
        self.assertEqual(code, 1, output)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])

    def test_cancellation_cleanup_preserves_an_intervening_human_edit(self) -> None:
        from test_helio_plan import discord
        self.assertEqual(self.post()[0], 0)
        self.edit_when_saving()

        def cancellation(message, channel=None, fingerprint=None):
            source = discord(content="cancel planning issue #12")(message, channel, fingerprint)
            return {**source, "payload": {**source["payload"], "message_id": "777"},
                    "live": {**source["live"], "id": "777"}}

        code, output = self.run_cli("request", "cancel", "--issue", "12", "--message", "555",
                                   "--channel", "1", "--from-message", "777", discord_fn=cancellation)
        self.assertEqual(code, 1, output)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])

    def test_pr_status_finalization_preserves_a_human_edit_during_authorization(self) -> None:
        self.assertEqual(self.post()[0], 0)
        change = {"issue": 12, "url": f"https://github.com/{REPO}/pull/13",
                  "plan_body": self.gh_fake.comments[0]["body"], "authority": {"kind": "plan"}}

        def permitted():
            self.gh_fake.hand_edit("8-hour window", "HUMAN EDIT: preserve this choice")

        with self.assertRaisesRegex(ValueError, "changed during source revalidation"):
            P["PUBLICATION"]["FINALIZE"]["finish"](REPO, self.gh_fake, change, {"state": "OPEN"}, permitted)
        self.assertIn("HUMAN EDIT: preserve this choice", self.gh_fake.comments[0]["body"])

    def test_pr_status_finalization_uses_the_same_per_issue_lock(self) -> None:
        self.assertEqual(self.post()[0], 0)
        change = {"issue": 12, "url": f"https://github.com/{REPO}/pull/13",
                  "plan_body": self.gh_fake.comments[0]["body"], "authority": {"kind": "plan"}}
        key = hashlib.sha256(f"{REPO}:12".encode()).hexdigest()
        with (self.dir / "state" / f"plan-{key}.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, "busy"):
                P["PUBLICATION"]["FINALIZE"]["finish"](REPO, self.gh_fake, change, {"state": "OPEN"}, lambda: None)
        self.assertNotIn("implemented in", self.gh_fake.comments[0]["body"])

    def test_observed_issue_closure_settles_the_planning_receipt(self) -> None:
        self.assertEqual(self.post()[0], 0)

        def wire(argv, stdin=None, cwd=None):
            result = self.gh_fake(argv, stdin, cwd)
            if argv[:3] == ["gh", "issue", "view"]:
                return json.dumps({**json.loads(result), "state": "CLOSED"})
            return result

        self.gh = P["GitHub"](REPO, run=wire)
        self.run_cli("show", "--issue", "12", "--json")
        with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
            state, settled = db.execute("SELECT state,settled_at FROM plan_requests").fetchone()
        self.assertEqual(state, "posted")
        self.assertIsNotNone(settled)

    def test_prepared_approval_resumes_from_its_bound_source_after_intake_acknowledgment(self) -> None:
        from test_helio_plan import discord
        self.assertEqual(self.post()[0], 0)
        later = POSTED + datetime.timedelta(hours=1)
        source = discord(content="approve plan #12", sent=later)

        def denied(argv, stdin=None, cwd=None):
            if argv[:2] == ["gh", "api"] and "PATCH" in argv:
                raise P["ISSUES"]["Refused"]("Forbidden", "comment_write", False)
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=denied)
        code, output = self.run_cli("approve", "--issue", "12", "--message", "555", now=later, discord_fn=source)
        self.assertEqual(code, 1, output)
        with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
            db.execute("UPDATE delivery SET payload=NULL")
        expected = hashlib.sha256(b"approve plan #12").hexdigest()

        def restored(message, channel=None, fingerprint=None):
            self.assertEqual((channel, fingerprint), ("1", expected))
            return source(message, channel, fingerprint)

        self.gh = P["GitHub"](REPO, run=self.gh_fake)
        code, output = self.run_cli("approve", "--issue", "12", "--message", "555", now=later, discord_fn=restored)
        self.assertEqual(code, 0, output)
        self.assertTrue(P["approved"](self.data()))

    def test_prepared_operation_is_scheduled_with_its_saved_draft_and_original_request(self) -> None:
        def interrupted(argv, stdin=None, cwd=None):
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                raise RuntimeError("fixture stops before dispatch")
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=interrupted)
        self.assertEqual(self.post()[0], 2)
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            db.execute("UPDATE plan_publications SET state='prepared' WHERE kind='comment'")
        pending = P["PLAN_PUBLICATION"]["watch"](REPO, self.gh)
        self.assertIn("cause=prepared", pending)
        command = shlex.split(json.loads(pending.split(" resume=", 1)[1]))
        self.assertEqual(command[:3], ["helio", "plan", "post"])
        self.assertIn("--request-message", command)
        self.assertEqual(self.gh_fake.comments, [])
        self.gh = P["GitHub"](REPO, run=self.gh_fake)
        code, output = self.run_cli(*command[2:])
        self.assertEqual(code, 0, output)
        self.assertEqual(self.data()["revision"], 1)

    def test_dropping_a_prepared_request_retires_its_unsent_publication(self) -> None:
        def interrupted(argv, stdin=None, cwd=None):
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                raise RuntimeError("fixture stops before dispatch")
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=interrupted)
        self.assertEqual(self.post()[0], 2)
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            db.execute("UPDATE plan_publications SET state='prepared' WHERE kind='comment'")
        code, output = self.run_cli("drop", "--issue", "12")
        self.assertEqual(code, 0, output)
        self.assertIsNone(P["PLAN_PUBLICATION"]["watch"](REPO, self.gh))
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            self.assertEqual(db.execute("SELECT state FROM plan_publications WHERE kind='comment'").fetchone()[0], "cancelled")
        self.assertEqual(self.gh_fake.comments, [])

    def test_changed_draft_safely_retires_a_definitively_unwritten_prepared_post(self) -> None:
        def denied(argv, stdin=None, cwd=None):
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                raise P["ISSUES"]["Refused"]("Forbidden", "comment_write", False)
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=denied)
        first, output = self.post()
        self.assertEqual(first, 1, output)
        self.assertEqual(self.gh_fake.comments, [])
        self.gh = P["GitHub"](REPO, run=self.gh_fake)
        replacement = {**PLAN, "in_short": "Players receive the clarified confirmation window."}
        code, output = self.post(replacement)
        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)
        self.assertEqual((self.data()["revision"], self.data()["in_short"]), (1, replacement["in_short"]))
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            self.assertEqual(sorted(row[0] for row in db.execute("SELECT state FROM plan_publications WHERE kind='comment'")),
                             ["cancelled", "confirmed"])
        self.assertIsNone(P["PLAN_PUBLICATION"]["watch"](REPO, self.gh))
        self.assertEqual(self.post(replacement)[0], 0)
        self.assertEqual(self.data()["revision"], 1)

    def test_changed_draft_never_replaces_an_uncertain_post(self) -> None:
        attempts = 0

        def uncertain(argv, stdin=None, cwd=None):
            nonlocal attempts
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                attempts += 1
                raise RuntimeError("Unknown write result")
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=uncertain)
        self.assertEqual(self.post()[0], 2)
        code, output = self.post({**PLAN, "in_short": "A changed draft must wait for the uncertain result."})
        self.assertEqual(code, 2, output)
        self.assertEqual(attempts, 1)
        self.assertEqual(self.gh_fake.comments, [])

    def test_legacy_plan_metadata_remains_intact_without_synthetic_adoption(self) -> None:
        self.assertEqual(self.post()[0], 0)
        legacy = self.data()
        legacy.pop("publication_id")
        legacy.pop("planning_request")
        body = P["render"](12, legacy)
        self.gh_fake.comments[0]["body"] = body
        code, output = self.run_cli("show", "--issue", "12", "--json")
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output), legacy)
        self.assertEqual(self.gh_fake.comments[0]["body"], body)
        code, output = self.post(request=False)
        self.assertEqual(code, 0, output)
        self.assertEqual(self.data()["revision"], 1)
        self.assertEqual(self.gh_fake.comments[0]["body"], body)

    def test_deadline_interrupts_before_dispatch_and_releases_issue_lock(self) -> None:
        expired = False

        def wire(argv, stdin=None, cwd=None):
            nonlocal expired
            if not expired and argv[:3] == ["gh", "api", "user"]:
                expired = True
                signal.raise_signal(signal.SIGALRM)
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=wire)
        code, output = self.post()
        self.assertEqual(code, 2, output)
        self.assertIn("45-second deadline", output)
        self.assertEqual(self.gh_fake.comments, [])
        self.assertEqual(self.post()[0], 0)

    def test_cancellation_after_lost_post_response_reconciles_then_drops(self) -> None:
        from test_helio_plan import discord
        lost = False

        def wire(argv, stdin=None, cwd=None):
            nonlocal lost
            result = self.gh_fake(argv, stdin, cwd)
            if not lost and argv[:2] == ["gh", "api"] and "POST" in argv:
                lost = True
                raise RuntimeError("response lost after POST")
            return result

        self.gh = P["GitHub"](REPO, run=wire)
        self.assertEqual(self.post()[0], 2)

        def cancellation(message, channel=None, fingerprint=None):
            source = discord(content="cancel planning issue #12")(message, channel, fingerprint)
            return {**source, "payload": {**source["payload"], "message_id": "777"},
                    "live": {**source["live"], "id": "777"}}

        code, output = self.run_cli("request", "cancel", "--issue", "12", "--message", "555",
                                   "--channel", "1", "--from-message", "777", discord_fn=cancellation)
        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)
        self.assertIn("Plan dropped after cancellation", self.gh_fake.comments[0]["body"])
        self.assertEqual(self.gh_fake.labels, set())
        self.assertEqual(self.post()[0], 1)

    def test_watch_attempts_one_issue_and_rotates_failed_reads(self) -> None:
        def wire(argv, stdin=None, cwd=None):
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                raise RuntimeError("unknown transport result")
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=wire)
        self.assertEqual(self.post()[0], 2)
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            db.row_factory = sqlite3.Row
            row = dict(db.execute("SELECT * FROM plan_publications WHERE kind='comment'").fetchone())
            row.update(id="other-issue", issue=13, last_checked_at=0)
            db.execute("UPDATE plan_publications SET last_checked_at=0")
            db.execute(f"INSERT INTO plan_publications ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",
                       tuple(row.values()))
        watch = P["PLAN_PUBLICATION"]["watch"]
        for attempted in (1, 2):
            self.assertIn("PLAN_PENDING", watch(REPO, self.gh))
            with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
                self.assertEqual(db.execute("SELECT count(*) FROM plan_publications WHERE last_checked_at>0").fetchone()[0],
                                 attempted)

    def test_busy_issue_returns_immediately_without_any_remote_effect(self) -> None:
        directory = self.dir / "state"
        directory.mkdir()
        key = hashlib.sha256(f"{REPO}:12".encode()).hexdigest()
        with (directory / f"plan-{key}.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, output = self.post()
        self.assertEqual(code, 2, output)
        self.assertIn("busy", output)
        self.assertEqual(self.gh_fake.comments, [])

    def test_label_response_loss_recovers_existing_comment_and_revision(self) -> None:
        lost = False

        def wire(argv, stdin=None, cwd=None):
            nonlocal lost
            result = self.gh_fake(argv, stdin, cwd)
            if not lost and argv[:3] == ["gh", "issue", "edit"]:
                lost = True
                raise RuntimeError("label applied but response lost")
            return result

        self.gh = P["GitHub"](REPO, run=wire)
        self.assertEqual(self.post()[0], 2)
        self.assertEqual(len(self.gh_fake.comments), 1)
        code, output = self.post(now=POSTED + datetime.timedelta(hours=1))
        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)
        self.assertEqual(self.data()["revision"], 1)
        self.assertEqual(self.gh_fake.labels, {12})

    def test_prepared_retry_preserves_its_original_body_and_timestamp(self) -> None:
        def wire(argv, stdin=None, cwd=None):
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                raise RuntimeError("fixture interruption")
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=wire)
        self.assertEqual(self.post()[0], 2)
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            saved = db.execute("SELECT after_body FROM plan_publications WHERE kind='comment'").fetchone()[0]
            # Model the durable prepared gap, before a dispatcher has ever sent it.
            db.execute("UPDATE plan_publications SET state='prepared' WHERE kind='comment'")
        self.gh = P["GitHub"](REPO, run=self.gh_fake)
        code, output = self.post(now=POSTED + datetime.timedelta(days=1))
        self.assertEqual(code, 0, output)
        self.assertEqual(self.gh_fake.comments[0]["body"], saved)

    def test_unreadable_write_outcome_retains_draft_and_never_sends_a_second_post(self) -> None:
        attempts = 0

        def wire(argv, stdin=None, cwd=None):
            nonlocal attempts
            if argv[:2] == ["gh", "api"] and "POST" in argv:
                attempts += 1
                raise RuntimeError("transport outcome unavailable")
            return self.gh_fake(argv, stdin, cwd)

        self.gh = P["GitHub"](REPO, run=wire)
        for _ in range(2):
            code, output = self.post()
            self.assertEqual(code, 2, output)
            self.assertIn("PLAN_PENDING", output)
        self.assertEqual(attempts, 1)
        self.assertEqual(self.gh_fake.comments, [])
        with sqlite3.connect(self.dir / "state/issue-updates.sqlite") as db:
            retained = db.execute("SELECT after_body,state FROM plan_publications WHERE kind='comment'").fetchall()
        self.assertEqual(len(retained), 1)
        self.assertIn(retained[0][1], ("writing", "uncertain"))
        self.assertEqual(P["parse"](retained[0][0])["revision"], 1)

    def test_show_and_check_do_not_adopt_human_edits(self) -> None:
        self.assertEqual(self.post()[0], 0)
        self.gh_fake.hand_edit("8-hour window", "4-hour window")
        before = copy.deepcopy(self.gh_fake.comments)
        for command in ("show", "check"):
            code, output = self.run_cli(command, "--issue", "12")
            self.assertEqual(code, 1, output)
            self.assertIn("PLAN_EDITED_OUTSIDE_HELIO", output)
        self.assertEqual(self.gh_fake.comments, before)

    def test_ambiguous_bot_owned_comments_refuse_writes(self) -> None:
        self.assertEqual(self.post()[0], 0)
        second = copy.deepcopy(self.gh_fake.comments[0])
        second["url"] = second["url"].replace("issuecomment-1", "issuecomment-2")
        self.gh_fake.comments.append(second)
        before = copy.deepcopy(self.gh_fake.comments)
        code, output = self.post()
        self.assertEqual(code, 1, output)
        self.assertIn("multiple bot-owned", output)
        self.assertEqual(self.gh_fake.comments, before)

    def test_drop_cancels_an_accepted_unpublished_request(self) -> None:
        from plan_fixture import stage_source
        from test_helio_plan import discord
        stage_source(self.dir / "state", json.dumps(discord()("555")["payload"]))
        code, output = self.run_cli("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.run_cli("drop", "--issue", "12")[0], 0)
        code, output = self.post()
        self.assertEqual(code, 1, output)
        self.assertEqual(self.gh_fake.comments, [])

    def test_repeating_the_same_plan_returns_its_existing_revision(self) -> None:
        first, output = self.post()
        self.assertEqual(first, 0, output)
        again, output = self.post()
        self.assertEqual(again, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)
        self.assertEqual(self.data()["revision"], 1)

    def test_lost_post_response_recovers_one_comment_without_incrementing_revision(self) -> None:
        lost = False

        def wire(argv: list[str], stdin: str | None = None, cwd: Path | None = None) -> str:
            nonlocal lost
            result = self.gh_fake(argv, stdin, cwd)
            if not lost and argv[:2] == ["gh", "api"] and "POST" in argv and argv[2].endswith("/comments"):
                lost = True
                raise RuntimeError("Connection lost after fixture accepted the comment")
            return result

        self.gh = P["GitHub"](REPO, run=wire)
        code, output = self.post()
        self.assertNotEqual(code, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)

        code, output = self.post()

        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)
        self.assertEqual(self.data()["revision"], 1)

    def test_lost_update_response_does_not_create_an_additional_revision_on_resume(self) -> None:
        code, output = self.post()
        self.assertEqual(code, 0, output)
        fields = copy.deepcopy(PLAN)
        fields["in_short"] = "Players get a six-hour confirmation window and one reminder."
        fields["scope"]["changes"][0]["after"] = "6-hour window"
        fields["change_note"] = "Shorten the confirmation window to six hours"
        lost = False

        def wire(argv: list[str], stdin: str | None = None, cwd: Path | None = None) -> str:
            nonlocal lost
            result = self.gh_fake(argv, stdin, cwd)
            if not lost and argv[:2] == ["gh", "api"] and "PATCH" in argv:
                lost = True
                raise RuntimeError("Connection lost after fixture accepted the revision")
            return result

        self.gh = P["GitHub"](REPO, run=wire)
        code, output = self.post(fields)
        self.assertNotEqual(code, 0, output)
        code, output = self.post(fields)
        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.gh_fake.comments), 1)
        self.assertEqual(self.data()["revision"], 2)
