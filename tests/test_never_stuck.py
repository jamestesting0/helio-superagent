"""Every way a managed lane can stop ends in recovery, one owner question, parking or termination (never-stuck plan)."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import contextlib
import types
from dataclasses import replace
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

import test_lane_lifecycle as lifecycle

S, P = lifecycle.S, lifecycle.P
C = lifecycle.fixture.C
E = C["E"]
OWNER, TRUSTED = lifecycle.OWNER, "200000000000000002"
AUTH = P["AUTH"]
REQUIREMENTS = "Confirmed requirements\n- Round to whole seconds."


def owner_message(*_):
    return {"payload": {}, "live": {}, "owner": OWNER, "trusted": [], "channel_ok": True,
            "verify_source": lambda *args: OWNER, "Refused": RuntimeError}


class NeverStuckTests(lifecycle.LifecycleCase):
    def questions(self, where: str = "1=1") -> list[sqlite3.Row]:
        path = self.custody.store.state / "discord-questions.sqlite"
        if not path.is_file():
            return []  # nothing was ever asked
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.row_factory = sqlite3.Row
            return db.execute(f"SELECT * FROM questions WHERE {where} ORDER BY rowid").fetchall()

    def set_question(self, qid: str, **fields) -> None:
        with contextlib.closing(sqlite3.connect(self.custody.store.state / "discord-questions.sqlite")) as db:
            db.execute("UPDATE questions SET " + ",".join(f"{key}=?" for key in fields) + " WHERE id=?", (*fields.values(), qid))
            db.commit()

    def tap(self, option: str) -> str:
        """The owner taps a button: an interaction id, not a human message, carries the answer."""
        qid = self.wait().data["escalation"]["question"]
        self.set_question(qid, status="answered", answer_author=OWNER, answer_text=option, answer_source="component",
                          answer_id="1300000000000000000", answer_role="OWNER")
        return qid

    def decide(self, qid: str, *extra: str, discord=None) -> tuple[int, str]:
        return self.helio("pr", "phase", "decide", "--issue", "7", "--question", qid, *extra, discord=discord)

    def handed_off(self) -> None:
        self.assertEqual(self.hand_off(self.custody.submit())[0], 0)

    def worker_round(self, generation: int) -> None:
        """The woken worker starts its exact phase goal, submits again and hands off."""
        self.custody.start_goal()
        code, line = self.hand_off(self.custody.submit(), generation)
        self.assertEqual(code, 0, line)

    # S1: requirements change after handoff

    def test_an_owner_sourced_change_after_handoff_reworks_the_same_pr_and_binds_the_new_scope(self):
        self.handed_off()
        self.answered_question("q1")
        self.edit_issue(REQUIREMENTS, "Owner answered: whole seconds.", "--question", "q1")
        self.set_question("q1", status="done")  # the lead acknowledges the applied answer
        self.custody.poll(1)
        wait = self.wait()
        self.assertEqual((wait.generation, wait.data["intent"]["kind"], bool(wait.data["rescope"])), (2, "wake", True))
        self.assertTrue(any("Requirements changed after handoff: Owner answered" in item["detail"] for item in wait.data["notices"]))
        self.worker_round(2)
        self.assertEqual((self.wait().data["scope"], self.wait().data["rescope"]),
                         (lifecycle.FORMAT["digest"](REQUIREMENTS), None))

    def test_a_trusted_users_change_asks_the_owner_and_include_reworks_the_pr(self):
        with patch.dict(os.environ, {"DORI_DISCORD_TRUSTED_IDS": TRUSTED}):
            self.handed_off()
            self.answered_question("q1", author=TRUSTED)
            self.edit_issue(REQUIREMENTS, "Staff answered: whole seconds.", "--question", "q1")
        self.custody.poll(1)
        escalation = self.wait().data["escalation"]
        self.assertEqual((escalation["kind"], self.wait().generation), ("scope-authority", 1))
        [row] = self.questions("lane='custody-issue7'")
        self.assertEqual((row["audience"], row["status"]), ("owner", "send_failed"))
        self.set_question("q1", status="done")  # the lead acknowledges the staff answer it recorded
        qid = self.tap("Include the new requirements in this PR")
        code, line = self.decide(qid)
        self.assertEqual(code, 0, line)
        self.assertEqual(self.questions("lane='custody-issue7'")[0]["status"], "done")
        self.custody.poll(2)
        self.assertEqual((self.wait().generation, bool(self.wait().data["rescope"])), (2, True))

    def test_leaving_new_requirements_for_a_related_issue_keeps_the_pr_and_grants_creation_only(self):
        self.handed_off()
        original = self.custody.store.get(7)["body"]
        self.edit_issue(REQUIREMENTS, "Someone added a requirement.")
        self.custody.poll(1)
        qid = self.tap("Leave them for a related issue")
        files = self.custody.store.state.parent
        (files / "related.md").write_text("- Round to whole seconds.")
        (files / "restored.md").write_text(lifecycle.fixture.publication.M["split"](original)[0])
        code, line = self.decide(qid, "--title", "Round waits", "--body-file", str(files / "related.md"),
                                 "--restored-body-file", str(files / "restored.md"))
        self.assertEqual(code, 0, line)
        [(number, created)] = self.custody.publication.github.created.items()
        self.assertIn("Related to https://github.com/o/r/issues/7", created["body"])
        self.assertIn("<!-- helio-related:", created["body"])
        self.assertEqual(self.custody.publication.github.issue["state"], "OPEN")
        self.custody.poll(2)
        self.assertEqual((self.wait().generation, self.wait().data["blocked"], self.wait().data["stop"]), (1, None, None))
        grant = self.plan["WORK"]["grant"](hashlib.sha256(
            json.dumps(["o/r", 7, qid, "Leave them for a related issue"]).encode()).hexdigest()[:32])
        self.assertEqual((grant["permissions"], grant["target_issue"]), (("create",), number))
        code, line = self.helio("work", "start", "--issue", str(number), "--grant", grant["id"])
        self.assertEqual(code, 1)
        self.assertIn("does not authorize implementation", line)

    # S2: the PR branch moved outside the phase

    def test_a_moved_branch_gets_one_reverify_round_bound_to_the_new_head(self):
        self.handed_off()
        self.custody.auto.write("value.py", "def value():\n    return 2  # owner tweak\n")
        self.custody.auto.commit()
        self.custody.auto.git("push", "origin", "HEAD:helio/autofix-7")
        moved = self.custody.head = self.custody.auto.git("rev-parse", "HEAD")
        self.custody.poll(1)
        wait = self.wait()
        self.assertEqual((wait.generation, wait.data["intent"]["expected_head"]), (2, moved))
        lane = json.loads(self.custody.lane_path.read_text())
        code, line = self.helio("pr", "phase", "authorize", "--lane", "issue7-regression", "--effect", "wake",
                                "--lane-revision", str(lane["revision"]))
        self.assertEqual((code, line.split()[0]), (0, "PHASE_AUTHORIZED"))
        self.worker_round(2)
        self.assertEqual(self.wait().data["head"], moved)

    # S4: repairs that do not change the observation

    def test_a_repair_that_changes_nothing_gets_one_retry_then_one_owner_question(self):
        self.handed_off()
        self.custody.mode = "assertion"
        self.custody.poll(1)
        self.assertEqual(self.wait().generation, 2)
        self.worker_round(2)
        self.custody.poll(2)
        wait = self.wait()
        self.assertEqual(wait.generation, 3)
        self.assertTrue(any("diagnose the cause first" in item["detail"] for item in wait.data["notices"]))
        self.worker_round(3)
        self.custody.poll(3)
        self.assertEqual((self.wait().generation, self.wait().data["escalation"]["kind"]), (3, "repair-exhausted"))
        self.custody.poll(4)
        self.assertEqual(len(self.questions()), 1)
        qid = self.tap("Try once more")
        self.assertEqual(self.decide(qid)[0], 0)
        self.assertEqual((self.wait().generation, self.wait().data["blocked"]), (3, None))
        self.custody.poll(5)  # the controller delivers the approved round through its own repair dispatch
        self.assertEqual((self.wait().generation, self.wait().data["intent"]["kind"]), (4, "wake"))
        self.worker_round(4)  # the one approved round also changes nothing: ask again, no fifth round
        self.custody.poll(6)
        self.assertEqual((self.wait().generation, self.wait().data["escalation"]["kind"]), (4, "repair-exhausted"))

    # S5: worker startup failures

    def test_three_failed_starts_ask_the_owner_and_try_again_resets_them(self):
        self.handed_off()
        self.custody.mode = "assertion"
        self.custody.poll(1)
        for index, minute in enumerate((10, 20, 30)):
            self.lane(status="hibernated", launchState="failed", launchError="pane creation failed",
                      revision=100 + index)
            self.custody.poll(minute)
        wait = self.wait()
        self.assertEqual((len(wait.data["startup_failures"]), wait.data["escalation"]["kind"]), (3, "startup-failed"))
        qid = self.tap("Try again")
        self.assertEqual(self.decide(qid)[0], 0)
        self.assertEqual(self.wait().data["startup_failures"], [])

    # S6: PR closed without merge

    def test_a_closed_pr_is_reopened_only_on_the_owners_answer(self):
        self.handed_off()
        self.custody.pr_state = "CLOSED"
        self.custody.poll(1)
        self.assertEqual((self.wait().data["escalation"]["kind"], self.custody.reopened), ("pr-closed", []))
        qid = self.tap("Reopen the PR and continue")
        code, line = self.decide(qid)
        self.assertEqual(code, 0, line)
        self.assertEqual((self.custody.reopened, self.wait().data["blocked"]), ([lifecycle.fixture.publication.URL], None))
        self.custody.poll(2)
        self.assertIsNone(self.wait().data.get("escalation"))

    def test_stop_this_work_abandons_the_lane_and_ends_custody(self):
        self.handed_off()
        self.custody.pr_state = "CLOSED"
        self.custody.poll(1)
        qid = self.tap("Stop this work")
        self.assertEqual(self.decide(qid)[0], 0)
        lane = json.loads(self.custody.lane_path.read_text())
        self.assertTrue(lane["receipt"]["abandoned"])
        self.custody.poll(2)
        self.assertTrue(self.wait().data["terminal"])

    # S7: issue closed, authority lost

    def test_a_closed_issue_continues_only_in_a_linked_follow_up_with_a_durable_grant(self):
        self.handed_off()
        self.custody.publication.github.issue["state"] = "CLOSED"
        self.custody.poll(1)
        self.assertEqual(self.wait().data["escalation"]["kind"], "issue-closed")
        qid = self.tap("Continue under a linked follow-up issue")
        files = self.custody.store.state.parent
        (files / "rest.md").write_text("- Finish rounding the confirmation wait.")
        launches = []
        with patch.dict(self.plan["LANE"], {"start": lambda task, project: launches.append(task) or ("issue50-x", "STARTUP_OK")}):
            code, line = self.decide(qid, "--title", "Finish rounding", "--body-file", str(files / "rest.md"), "--labels", "bug")
        self.assertEqual(code, 0, line)
        [(number, created)] = self.custody.publication.github.created.items()
        self.assertIn("<!-- helio-followup:", created["body"])
        self.assertEqual([task.issue for task in launches], [number])
        self.assertTrue(self.wait().data["terminal"])
        self.assertEqual(self.custody.publication.github.issue["state"], "CLOSED")
        grant = self.plan["WORK"]["available"]("o/r", number, datetime.datetime.now(datetime.timezone.utc), include_used=True)
        self.assertEqual(grant.channel, "grant")
        for row in self.questions():  # question cleanup and retention cannot remove the authority
            with contextlib.closing(sqlite3.connect(self.custody.store.state / "discord-questions.sqlite")) as db:
                db.execute("DELETE FROM questions WHERE id=?", (row["id"],))
                db.commit()
        AUTH["verify"]({"channel": "grant", "message": grant.message, "author": OWNER, "source_hash": grant.source_hash})

    def test_lost_authority_is_a_bounded_stop_that_reaches_the_lead_then_the_owner(self):
        self.handed_off()
        with patch.dict(os.environ, {"HELIO_AUTOFIX": "off"}):
            self.custody.poll(1)
            self.assertEqual(self.wait().data["stop"]["kind"], "authority")
            self.custody.poll(32)
            self.assertTrue(any(item["detail"].startswith("Stopped 31 min") for item in self.wait().data["notices"]))
            self.custody.poll(92)
        escalation = self.wait().data["escalation"]
        self.assertEqual((escalation["kind"], escalation["options"]), ("authority", ["Stop this work", "Park it"]))

    # S10: a worker blocked on its own question

    def test_a_worker_question_moves_to_the_custody_lane_so_the_slot_is_released_and_the_answer_wakes_it(self):
        self.lane(pane="w1:p2", launchState="started")
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        with contextlib.closing(self.questions_db()) as db:
            db.execute("INSERT INTO questions (id,fingerprint,lane,audience,recipient,question,status,updated) "
                       "VALUES ('q1','q1','issue7-regression','owner',?,'Round?','awaiting_answer',1)", (OWNER,))
            db.commit()
        calls = self.native_dori(idle_session=True)
        self.custody.poll(5, self.dori)
        self.assertEqual(self.questions("id='q1'")[0]["lane"], "custody-issue7")
        self.assertEqual(json.loads(self.custody.lane_path.read_text())["status"], "hibernated")
        self.assertEqual([argv[:2] for argv in calls], [["dori", "reclaim"], ["dori", "reclaim"]])
        self.custody.poll(96, self.dori)  # the transferred question is the custody decision; none is added
        self.assertEqual([row["id"] for row in self.questions()], ["q1"])
        self.set_question("q1", status="answered", answer_author=OWNER, answer_text="Whole seconds")
        code, line = self.decide("q1")
        self.assertEqual(code, 0, line)
        self.assertIn("transition=worker-unblock", line)
        wait = self.wait()
        self.assertEqual((wait.generation, wait.data["intent"]["kind"], wait.data["blocked"]), (2, "wake", None))

    def questions_db(self) -> sqlite3.Connection:
        questions = lifecycle.runpy.run_path(str(lifecycle.ROOT / "scripts/helio-questions.py"))
        questions["db_connect"].__globals__["STATE"] = self.custody.store.state
        return questions["db_connect"]()

    # S11: a worker that makes no progress

    def worker_quiet(self, continuations: int) -> None:
        self.lane(pane="w1:p2", launchState="started", status="working")
        with self.custody.checkpoint.open("a") as output:
            for _ in range(continuations):
                output.write(json.dumps({"type": "custom_message", "customType": "goal-continuation"}) + "\n")
        self.custody.poll(0)
        self.custody.poll(31)

    def test_a_silent_worker_reaches_the_lead_at_30_and_the_owner_at_90_minutes_whatever_its_wakes(self):
        for continuations in (0, 2):
            with self.subTest(continuations=continuations):
                self.setUp()
                self.worker_quiet(continuations)
                self.assertTrue(any("made no change for 31 min" in item["detail"] for item in self.wait().data["notices"]))
                self.custody.poll(91)
                wait = self.wait()
                self.assertEqual((wait.data["blocked"]["kind"], wait.data["escalation"]["kind"]), ("no-progress", "no-progress"))
                self.assertEqual(wait.data["escalation"]["options"][0], "Try again")
                code, line = self.helio("work", "unblock", "--issue", "7", "--lead", "--reason", "looked at it")
                self.assertEqual(code, 1)
                self.assertIn("owner was already asked", line)

    def test_a_busy_worker_is_stopped_only_by_the_owners_decision(self):
        self.custody.safe_release = False
        self.worker_quiet(0)
        self.custody.poll(91)
        escalation = self.wait().data["escalation"]
        self.assertEqual(escalation["options"][0], E["BUSY"])
        qid = self.tap(E["BUSY"])
        code, line = self.decide(qid)
        self.assertEqual(code, 0, line)
        wait = self.wait()
        self.assertEqual((json.loads(self.custody.lane_path.read_text())["status"], wait.generation, wait.data["intent"]["kind"]),
                         ("hibernated", 2, "wake"))

    def test_a_repair_after_the_lane_closed_starts_a_new_generation(self):
        """PR #27 (2026-11-13): a completed, closed lane kept intent 'complete' and every later repair silently stalled."""
        self.handed_off()
        self.custody.mode = "pass"
        self.custody.poll(1)
        self.assertEqual(self.wait().data["intent"]["kind"], "complete")
        lane = json.loads(self.custody.lane_path.read_text())
        lane.update(status="closed", closedAt="2026-11-12T09:28:03Z", revision=lane["revision"] + 1)
        self.custody.lane_path.write_text(json.dumps(lane))
        self.custody.poll(2)
        self.custody.mode = "assertion"
        self.custody.poll(3)
        self.custody.poll(4)  # a repeated tick must not start a second generation
        wait = self.wait()
        self.assertEqual((wait.generation, wait.data["intent"]["kind"]), (2, "wake"))
        self.assertEqual(json.loads(self.custody.lane_path.read_text())["status"], "working")
        self.assertNotIn("dispatch did not start", (wait.data["stop"] or {}).get("detail", ""))

    def test_a_stall_inside_helio_reports_one_incident_and_never_asks_the_owner(self):
        self.handed_off()
        wait = self.wait()
        stop = {"kind": "stalled", "detail": E["INTERNAL_STALL"] + ": dispatch did not start", "since": 1_700_000_000.0,
                "lead_at": None, "owner_at": None}
        wait = S["save"](self.custody.store, replace(wait, data={**wait.data, "stop": stop, "progress_key": E["progress_key"](wait)}))
        wait = E["clock"](self.custody.store, wait, ("stalled", stop["detail"]), 1_700_000_000.0 + 91 * 60)
        self.assertIsNone((wait.data.get("escalation") or {}).get("question"))
        self.assertEqual(self.questions(), [])
        self.assertEqual(sum(item["detail"].startswith("Owner-only incident") for item in wait.data["notices"]), 1)

    def test_the_lead_clears_a_stop_clock_stall_that_has_no_blocker(self):
        """PR #27: the stall lived in `stop`, and `--lead` only looked at `blocked`, so the documented command refused."""
        self.handed_off()
        self.custody.pr_state = "UNKNOWN"
        self.custody.poll(1)
        self.custody.poll(32)
        self.assertEqual((self.wait().data["stop"]["kind"], self.wait().data.get("blocked")), ("stalled", None))
        code, line = self.helio("work", "unblock", "--issue", "7", "--lead", "--reason", "diagnosed GitHub readiness")
        self.assertEqual(code, 0, line)
        self.assertIn("WORK_UNBLOCKED issue=7 by=lead", line)
        self.assertIsNone(self.wait().data["stop"])

    def test_a_new_request_for_a_task_in_custody_joins_it_instead_of_looping(self):
        """PR #27: `work start` refused as a different source and told the lead to rerun a command that failed the same way."""
        self.handed_off()
        code, line = self.helio("work", "start", "--issue", "7", "--from-authorization")
        self.assertEqual(code, 0, line)
        self.assertIn("WORK_IN_CUSTODY issue=7", line)
        self.assertNotIn("--from-authorization", line)

    def test_a_fresh_request_joining_custody_keeps_the_lane_binding_and_access_follows_it(self):
        """Gate review 2026-11-13: re-pointing custody's source broke the lane binding on the next tick."""
        self.handed_off()
        S, P = self.plan["PR_RECOVERY_CLI"]["S"], self.plan["PR_RECOVERY_CLI"]["P"]
        original = "discord:1500000000000000000:1400000000000000000"
        S["save"](self.custody.store, replace(self.wait(), data={**self.wait().data, "route": "work", "authority": None,
                                                                 "source": original}))
        lane = json.loads(self.custody.lane_path.read_text())
        self.custody.lane_path.write_text(json.dumps({**lane, "source": original}))
        fresh = types.SimpleNamespace(channel="1500000000000000000", message="1400000000000000001", author=OWNER,
                                      source_hash="h", holds=(), blocked=None)
        self.plan["join_custody"](self.custody.store, self.wait(), fresh, None)
        wait = self.wait()
        self.assertEqual((wait.data["source"], wait.data["request_source"]),
                         (original, "discord:1500000000000000000:1400000000000000001"))
        P["lane"](self.custody.store, wait)  # the lane keeps the source that launched it
        verified = []
        with unittest.mock.patch.dict(P["WORK"], {"available": lambda *a, **k: fresh}), \
                unittest.mock.patch.dict(P["AUTH"], {"verify": verified.append, "require_unheld": lambda *a: None}):
            P["access"](self.custody.store, wait, self.custody.run)
        self.assertEqual(verified[0]["message"], "1400000000000000001")

    def test_a_worker_clarification_is_answered_by_the_lead_and_reaches_the_worker(self):
        """Issue #28 (2026-11-13): two instructions conflicted, the worker blocked without a question, and nobody but the
        owner could clear it. A clarification is answered by the lead and wakes the worker with the answer."""
        self.handed_off()
        wait = self.wait()
        S["save"](self.custody.store, replace(wait, data={**wait.data, "acknowledgment": None}))
        code, line = self.helio("work", "block", "--issue", "7", "--kind", "clarification",
                                "--reason", "a prose-only change: which test proves it?")
        self.assertEqual(code, 0, line)
        self.assertIn("WORK_CLARIFY issue=7", line)
        self.assertEqual(self.wait().data["blocked"]["need"], "clarification")
        code, line = self.helio("work", "unblock", "--issue", "7", "--lead", "--reason", "verify the rendered output; no prose test")
        self.assertEqual(code, 0, line)
        self.assertIn("by=lead-answer", line)
        wait = self.wait()
        self.assertIsNone(wait.data["blocked"])
        # Delivered, not just recorded: a new generation whose wake brief carries the answer, even for a live worker.
        self.assertGreater(wait.generation, 1)
        self.assertIn("lead answer: verify the rendered output", wait.data["intent"]["observation"])

    def test_a_worker_decision_is_never_cleared_by_the_lead(self):
        self.handed_off()
        wait = self.wait()
        S["save"](self.custody.store, replace(wait, data={**wait.data, "acknowledgment": None}))
        code, line = self.helio("work", "block", "--issue", "7", "--kind", "decision", "--reason", "keep or drop the old command?")
        self.assertIn("next=", line)
        code, line = self.helio("work", "unblock", "--issue", "7", "--lead", "--reason", "drop it")
        self.assertEqual(code, 1, line)
        self.assertIsNotNone(self.wait().data["blocked"])

    def test_the_lead_clears_a_diagnosed_stall_but_never_a_worker_blocker(self):
        self.helio("work", "block", "--issue", "7", "--reason", "needs a product decision")
        self.custody.poll(0)
        self.custody.poll(91)
        wait = self.wait()
        self.assertNotEqual(wait.data["blocked"]["stage"], "controller")  # the worker's own blocker is kept
        self.assertEqual(wait.data["escalation"]["kind"], "worker-blocked")
        code, line = self.helio("work", "unblock", "--issue", "7", "--lead", "--reason", "diagnosed")
        self.assertEqual(code, 1)
        self.assertIn("this one needs its answer or the owner", line)
        qid = self.tap("Unblock and continue")
        self.assertEqual(self.decide(qid)[0], 0)
        self.assertIsNone(self.wait().data["blocked"])

    # S13, S15, S16

    def test_an_unknown_pr_state_reaches_the_owner_at_90_minutes(self):
        self.handed_off()
        self.custody.pr_state = "UNKNOWN"
        for minute in (1, 32, 92):
            self.custody.poll(minute)
        self.assertEqual(self.wait().data["escalation"]["kind"], "stalled")

    def test_ready_but_a_busy_lane_is_reported_after_30_minutes(self):
        self.handed_off()
        self.custody.mode, self.custody.safe_release = "pass", False
        self.custody.poll(1)
        self.custody.poll(32)
        self.assertTrue(any("ready, but the worker lane has not closed" in item["detail"] for item in self.wait().data["notices"]))

    def test_requirements_changed_after_merge_complete_the_lane_and_ask_for_a_follow_up(self):
        self.handed_off()
        self.edit_issue(REQUIREMENTS, "Clarified after merge.")
        self.custody.pr_state = "MERGED"
        self.custody.publication.github.issue["state"] = "CLOSED"
        self.custody.poll(1)
        details = [item["detail"] for item in self.wait().data["notices"]]
        self.assertTrue(any("Canonical PR merged" in detail for detail in details))
        self.assertEqual(self.wait().data["escalation"]["kind"], "follow-up")
        self.assertEqual([row["lane"] for row in self.questions()], ["custody-issue7"])

    # E3: expiry, parking (never a re-ask) and a late answer

    def test_an_unanswered_question_parks_without_asking_again_and_a_later_message_resumes(self):
        self.handed_off()
        self.custody.pr_state = "CLOSED"
        self.custody.poll(1)
        first = self.wait().data["escalation"]["question"]
        self.set_question(first, status="expired")
        self.custody.poll(2)
        self.assertTrue(self.wait().data["blocked"]["parked"])
        self.custody.poll(200)
        self.assertEqual(len(self.questions()), 1)
        code, line = self.helio("pr", "phase", "decide", "--issue", "7", "--message", "1400000000000000000", "--channel",
                                "1500000000000000000", "--option", "Reopen the PR and continue", discord=owner_message)
        self.assertEqual(code, 0, line)
        self.assertEqual(self.custody.reopened, [lifecycle.fixture.publication.URL])

    def test_an_answer_given_before_the_question_was_linked_is_applied_without_asking_again(self):
        self.handed_off()
        self.custody.pr_state = "CLOSED"
        detail = f"PR {lifecycle.fixture.publication.URL} was closed without merge. Nothing is reopened without your answer."
        options = list(E["OPTIONS"]["pr-closed"])
        wait = self.wait()
        qid, _ = E["ask"](self.custody.store, 7, E["wording"](wait, detail, options), options)
        self.set_question(qid, status="answered", answer_author=OWNER, answer_text=options[0], answer_source="component")
        S["save"](self.custody.store, replace(wait, data={**wait.data, "escalation": {
            "kind": "pr-closed", "at": 1.0, "question": None, "options": options, "detail": detail}, "blocked": {
            "reason": detail, "at": 1.0, "stage": "controller", "kind": "pr-closed", "question": None}}))
        self.custody.poll(1)
        self.assertEqual(self.wait().data["escalation"]["question"], qid)
        self.assertEqual(len(self.questions()), 1)
        self.assertTrue(any(item["detail"].startswith(f"Owner answered {qid}") for item in self.wait().data["notices"]))

    def test_an_owner_question_cannot_be_closed_by_a_bare_ack(self):
        self.handed_off()
        self.custody.pr_state = "CLOSED"
        self.custody.poll(1)
        qid = self.tap("Stop this work")
        questions = lifecycle.runpy.run_path(str(lifecycle.ROOT / "scripts/helio-questions.py"))
        with patch("sys.argv", ["helio-questions.py", "ack", qid]), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "helio pr phase decide --issue 7"):
                questions["main"]()
        self.assertEqual(self.questions()[0]["status"], "answered")


    # Gate review fixes

    def stalled_unknown(self) -> None:
        self.handed_off()
        self.custody.pr_state = "UNKNOWN"
        for minute in (1, 32, 92):
            self.custody.poll(minute)

    def test_a_button_answer_cannot_be_overridden_by_option(self):
        self.handed_off()
        self.custody.pr_state = "CLOSED"
        self.custody.poll(1)
        qid = self.tap("Stop this work")
        code, line = self.decide(qid, "--option", "Reopen the PR and continue")
        self.assertEqual((code, self.custody.reopened, self.questions()[0]["status"]), (1, [], "answered"))
        self.assertIn("button answer is applied as given", line)

    def test_a_creation_grant_needs_the_current_owner(self):
        grant = self.plan["WORK"]["create_grant"]("o/r", 7, "q9", "Create the follow-up issue", ("create",), OWNER, "0" * 64,
                                                  datetime.datetime.now(datetime.timezone.utc))
        body = self.custody.store.state.parent / "new.md"
        body.write_text("- Something new.")
        with patch.dict(os.environ, {"DORI_DISCORD_OWNER_ID": TRUSTED}):
            code, line = self.issue_command("followup", "--previous", "7", "--grant", grant, "--related", "--title", "New",
                                            "--body-file", str(body), "--labels", "bug")
        self.assertNotEqual(code, 0, line)
        self.assertEqual(self.custody.publication.github.created, {})

    def test_a_parked_decision_keeps_its_stop_history_is_listed_for_the_owner_and_a_later_message_resumes_it(self):
        self.stalled_unknown()
        qid = self.tap("I'll take it over")
        self.assertEqual(self.decide(qid)[0], 0)
        wait = self.wait()
        self.assertTrue(wait.data["blocked"]["parked"])
        self.assertGreaterEqual(wait.data["stops"][-1]["until"] - wait.data["stops"][-1]["since"], 90 * 60)
        upkeep = lifecycle.runpy.run_path(str(lifecycle.ROOT / "scripts/helio_decision_upkeep.py"))
        [item] = upkeep["waiting_on_owner"](self.custody.store.state)
        self.assertEqual((item["issue"], item["decision"], item["parked"]), (7, "stalled", True))
        self.custody.poll(300)
        self.assertEqual(len(self.questions()), 1)
        code, line = self.helio("pr", "phase", "decide", "--issue", "7", "--message", "1400000000000000000", "--channel",
                                "1500000000000000000", "--option", "Try again", discord=owner_message)
        self.assertEqual(code, 0, line)
        self.assertEqual((self.wait().generation, self.wait().data["intent"]["kind"]), (2, "wake"))

    def test_a_requester_hold_is_a_legitimate_wait_never_an_owner_question(self):
        self.handed_off()
        held = lambda *a, **k: (_ for _ in ()).throw(AUTH["Refused"]("Held by the requester (no-pr)"))
        with patch.dict(C["P"], {"access": held}):
            for minute in (1, 32, 92):
                self.custody.poll(minute)
        self.assertEqual((self.wait().data["status"], self.wait().data.get("escalation"), self.questions()), ("held", None, []))

    def test_an_unfinished_phase_without_an_active_worker_reaches_the_lead(self):
        self.custody.start_goal()
        self.lane(status="hibernated", pane=None)
        self.custody.poll(0)
        self.custody.poll(31)
        self.assertTrue(any("no active worker" in item["detail"] for item in self.wait().data["notices"]))

    def test_an_unreadable_custody_record_reaches_the_lead_then_the_owner(self):
        with self.custody.store.operations() as db:
            db.execute("UPDATE pr_waits SET data='null' WHERE issue=7")
        lines = []
        for minute in (0, 31, 91):
            lines += C["watch"](self.custody.store, self.custody.run, set(), self.custody.now + minute * 60)
        self.assertTrue(any("unreadable for 31 min" in line for line in lines))
        self.assertTrue(any("asked owner" in line for line in lines))
        self.assertEqual([row["lane"] for row in self.questions()], ["custody-issue7"])


    # Re-review fixes

    def test_try_once_more_with_a_busy_worker_waits_for_a_safe_release(self):
        self.handed_off()
        self.custody.mode = "assertion"
        self.custody.poll(1)
        self.worker_round(2)
        self.custody.poll(2)
        self.worker_round(3)
        self.custody.poll(3)
        self.custody.safe_release = False
        self.lane(status="working", pane="w1:p2", launchState="started")  # the worker is still busy in its session
        qid = self.tap("Try once more")
        code, line = self.decide(qid)
        self.assertEqual(code, 0, line)
        self.custody.poll(4)
        self.assertEqual((self.wait().generation, self.wait().data["blocked"], self.wait().data.get("escalation")), (3, None, None))
        self.custody.poll(35)  # the approved round waits on a busy worker: a bounded stop, not a silent retry
        self.assertTrue(any("approved repair is waiting" in item["detail"] for item in self.wait().data["notices"]))
        self.custody.poll(95)
        self.assertEqual(self.wait().data["escalation"]["options"][0], E["BUSY"])
        qid = self.tap(E["BUSY"])
        code, line = self.decide(qid)
        self.assertEqual(code, 0, line)
        wait = self.wait()
        self.assertEqual((wait.generation, wait.data["intent"]["observation"]), (4, wait.data["pending"]))
        self.custody.safe_release = True
        self.custody.poll(96)  # the controller delivers the resumed wake
        self.worker_round(4)  # the resumed round also changes nothing: ask again, no fifth round
        self.custody.poll(97)
        self.assertEqual((self.wait().generation, self.wait().data["escalation"]["kind"]), (4, "repair-exhausted"))

    def test_a_follow_up_answer_settles_the_merged_change_and_is_not_asked_again(self):
        for option in ("No follow-up", "Create the follow-up issue"):
            with self.subTest(option=option):
                self.setUp()
                self.handed_off()
                self.edit_issue(REQUIREMENTS, "Clarified after merge.")
                self.custody.pr_state = "MERGED"
                self.custody.publication.github.issue["state"] = "CLOSED"
                self.custody.poll(1)
                qid = self.tap(option)
                body = self.custody.store.state.parent / "followup.md"
                body.write_text("- Round to whole seconds.")
                code, line = self.decide(qid, "--title", "Round waits", "--body-file", str(body))
                self.assertEqual(code, 0, line)
                self.lane(closedAt="2026-11-12T00:00:00Z", status="closed")  # Dori closes the completed lane
                for minute in (3, 34, 94):
                    self.custody.poll(minute)
                self.assertEqual((len(self.questions()), self.wait().data["blocked"], self.wait().data["terminal"]), (1, None, True))

    def test_a_requester_identity_failure_is_not_a_hold_and_reaches_the_owner(self):
        self.handed_off()
        refused = lambda *a, **k: (_ for _ in ()).throw(AUTH["Refused"]("Work requester identity differs from the saved publication."))
        with patch.dict(C["P"], {"access": refused}):
            for minute in (1, 32, 92):
                self.custody.poll(minute)
        self.assertEqual(self.wait().data["escalation"]["kind"], "authority")

    def test_a_record_with_a_malformed_blocker_reaches_the_damage_ladder(self):
        with self.custody.store.operations() as db:
            db.execute("UPDATE pr_waits SET data=json_set(data,'$.blocked',json('[\"invalid blocker\"]')) WHERE issue=7")
        lines = C["watch"](self.custody.store, self.custody.run, set(), self.custody.now)
        self.assertTrue(any(line.startswith("FOLLOWUP_WARN issue=7") for line in lines))

    def test_a_busy_worker_with_an_undelivered_question_gets_the_owners_stop_decision(self):
        self.custody.safe_release = False
        self.lane(pane="w1:p2", launchState="started", status="working")
        self.helio("work", "block", "--issue", "7", "--reason", "awaiting answer", "--question", "q1")
        with contextlib.closing(self.questions_db()) as db:
            db.execute("INSERT INTO questions (id,fingerprint,lane,audience,recipient,question,status,updated) "
                       "VALUES ('q1','q1','issue7-regression','staff','1','Round?','send_failed',1)")
            db.commit()
        for minute in (0, 31, 91):
            self.custody.poll(minute)
        escalation = self.wait().data["escalation"]
        self.assertEqual((escalation["kind"], escalation["options"][0]), ("worker-blocked", E["BUSY"]))
        qid = self.tap(E["BUSY"])
        code, line = self.decide(qid)
        self.assertEqual(code, 0, line)
        wait = self.wait()
        self.assertEqual((json.loads(self.custody.lane_path.read_text())["status"], self.questions("id='q1'")[0]["lane"],
                          wait.data["escalation"]["question"], wait.data["blocked"]["transferred"]),
                         ("hibernated", "custody-issue7", "q1", "custody-issue7"))


    def test_an_unanswered_follow_up_keeps_its_lifecycle_after_the_merged_lane_closes(self):
        self.handed_off()
        self.edit_issue(REQUIREMENTS, "Clarified after merge.")
        self.custody.pr_state = "MERGED"
        self.custody.publication.github.issue["state"] = "CLOSED"
        self.custody.poll(1)
        first = self.wait().data["escalation"]["question"]
        self.lane(closedAt="2026-11-12T00:00:00Z", status="closed")
        self.custody.poll(2)
        self.assertFalse(self.wait().data["terminal"])
        upkeep = lifecycle.runpy.run_path(str(lifecycle.ROOT / "scripts/helio_decision_upkeep.py"))
        self.assertEqual([item["decision"] for item in upkeep["waiting_on_owner"](self.custody.store.state)], ["follow-up"])
        self.set_question(first, status="expired")
        self.custody.poll(3)
        self.assertTrue(self.wait().data["blocked"]["parked"])  # never asked again; a later owner message decides
        self.assertEqual(len(self.questions()), 1)
        code, line = self.helio("pr", "phase", "decide", "--issue", "7", "--message", "1400000000000000000", "--channel",
                                "1500000000000000000", "--option", "No follow-up", discord=owner_message)
        self.assertEqual(code, 0, line)
        self.custody.poll(4)
        self.assertTrue(self.wait().data["terminal"])


    def test_a_rework_waiting_on_a_busy_worker_never_completes_on_the_old_verification(self):
        self.handed_off()
        self.answered_question("q1")
        self.edit_issue(REQUIREMENTS, "Owner answered: whole seconds.", "--question", "q1")
        self.set_question("q1", status="done")
        self.custody.safe_release = False
        self.lane(status="working", pane="w1:p2", launchState="started")
        self.custody.mode = "pass"
        for minute in (1, 2, 3):
            self.custody.poll(minute)
        wait = self.wait()
        self.assertEqual((wait.generation, bool(wait.data["rescope"])), (1, True))
        self.assertNotIn(wait.data["status"], ("ready", "settled"))
        self.assertFalse(json.loads(self.custody.lane_path.read_text()).get("acknowledged"))
        self.custody.safe_release = True
        self.custody.poll(4)
        self.assertEqual((self.wait().generation, self.wait().data["intent"]["kind"]), (2, "wake"))


    def test_a_merge_before_a_pending_rework_starts_keeps_the_new_requirements_as_a_follow_up_decision(self):
        self.handed_off()
        self.answered_question("q1")
        self.edit_issue(REQUIREMENTS, "Owner answered: whole seconds.", "--question", "q1")
        self.set_question("q1", status="done")
        self.custody.safe_release = False
        self.lane(status="working", pane="w1:p2", launchState="started")
        self.custody.poll(1)
        self.assertTrue(self.wait().data["rescope"])
        self.custody.pr_state = "MERGED"
        self.custody.publication.github.issue["state"] = "CLOSED"
        self.custody.poll(2)
        wait = self.wait()
        self.assertEqual((wait.data["escalation"]["kind"], wait.data["terminal"]), ("follow-up", False))


if __name__ == "__main__":
    unittest.main()
