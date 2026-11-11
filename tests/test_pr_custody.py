"""Custody is exercised through real proof, publication, checkpoints and durable state."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import subprocess
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from unittest.mock import patch

from pr_custody_fixture import C, CLI, Custody, P, S


class CustodyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = Custody(self)

    def test_unchanged_infrastructure_wait_releases_worker_and_does_not_repeat_delivery(self) -> None:
        first = self.world.poll()
        pending = self.world.poll(1)
        repeated = self.world.poll(2)
        lane = json.loads(self.world.lane_path.read_text())
        self.assertEqual(lane["status"], "hibernated")
        self.assertEqual(len(self.world.reruns), 1)
        self.assertEqual((len(first), len(pending)), (2, 1))
        self.assertEqual(repeated, [])
        restarted = C["watch"](self.world.store, self.world.run, set(), self.world.now)
        self.assertEqual(restarted, first + pending)

    def test_pending_long_retry_defers_both_probes_without_a_catch_up_burst(self) -> None:
        self.world.poll()
        self.world.poll(130)
        self.assertEqual(len(self.world.reruns), 1)
        self.world.run_status = "completed"
        self.world.poll(150)
        self.world.poll(179)
        self.assertEqual(len(self.world.reruns), 1)
        self.world.poll(180)
        self.assertEqual(self.world.reruns, [1_700_000_000.0, 1_700_000_000.0 + 180 * 60])

    def test_three_failed_reruns_exhaust_budget_without_head_or_restart_reset(self) -> None:
        self.world.poll()
        self.world.run_status = "completed"
        self.world.poll(10)
        self.world.poll(40)
        self.world.run_status = "completed"
        self.world.poll(50)
        self.world.poll(120)
        self.world.run_status = "completed"
        self.world.poll(130)
        C["watch"](self.world.store, self.world.run, set(), 1_700_000_000.0 + 500 * 60)
        self.assertEqual(self.world.reruns, [1_700_000_000.0 + value * 60 for value in (0, 40, 120)])
        wait = S["load"](self.world.store, 7)
        self.assertEqual(len(wait.data["incidents"]), 1)
        self.assertTrue(any("budget exhausted" in item["detail"] for item in wait.data["notices"]))
        progress = wait.data["last_progress"]
        self.world.poll(501)
        self.assertEqual(S["load"](self.world.store, 7).data["last_progress"], progress)

    def test_six_equivalent_dns_observations_and_twenty_four_timer_ticks_keep_one_budget(self) -> None:
        for minute in (0, 10, 40, 50, 120, 130):
            self.world.run_status = "completed"
            self.world.poll(minute)
        for opportunity in range(24):
            self.world.attempt += 1  # Independent runner attempt identities do not allocate a new incident.
            C["watch"](self.world.store, self.world.run, set(), self.world.now + (opportunity + 1) * 1800)
        wait = S["load"](self.world.store, 7)
        self.assertEqual((len(self.world.reruns), len(wait.data["incidents"])), (3, 1))
        self.assertEqual((wait.generation, wait.data["status"]), (1, "waiting"))
        self.assertNotIn(json.loads(self.world.lane_path.read_text())["status"], ("working", "closed"))

    def test_a_same_head_repair_requires_a_new_phase_goal_and_receipt(self) -> None:
        self.world.mode = "assertion"
        self.world.poll()
        wait = S["load"](self.world.store, 7)
        self.assertEqual(wait.generation, 2)
        with self.assertRaisesRegex(P["S"]["Refused"], "exact active phase goal"):
            P["start"](self.world.store, wait, self.world.run)
        args = argparse.Namespace(pr_command="phase", phase_action="check", issue=7, generation=2)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(CLI["execute"](args, self.world.store, self.world.run), 2)
        self.world.start_goal()
        wait = S["load"](self.world.store, 7)
        self.assertEqual((wait.generation, wait.data["started_session"]), (2, self.world.session))
        self.assertIsNone(wait.data["acknowledgment"])

    def test_early_repair_waits_until_authenticated_release_is_available(self) -> None:
        self.world.mode = "assertion"
        self.world.safe_release = False
        self.world.poll()
        self.assertEqual(S["load"](self.world.store, 7).generation, 1)
        self.world.safe_release = True
        self.world.poll(1)
        self.assertEqual(S["load"](self.world.store, 7).generation, 2)

    def test_closed_unmerged_pr_remains_visible_without_retry_or_false_completion(self) -> None:
        self.world.pr_state = "CLOSED"
        lines = self.world.poll()
        self.assertEqual(self.world.reruns, [])
        self.assertEqual(S["load"](self.world.store, 7).data["status"], "decision")
        self.assertTrue(any("closed without merge" in line for line in lines))
        self.assertEqual(json.loads(self.world.lane_path.read_text())["status"], "hibernated")

    def test_merged_pr_is_not_terminal_until_reserved_lane_close_is_observed(self) -> None:
        self.world.pr_state = "MERGED"
        self.world.publication.github.issue["state"] = "CLOSED"
        self.world.poll()
        pending = S["load"](self.world.store, 7)
        self.assertFalse(pending.data["terminal"])
        lane = json.loads(self.world.lane_path.read_text())
        self.assertEqual(lane["status"], "done-claimed")
        lane.update(status="closed", closedAt="2026-11-11T00:00:00Z")
        self.world.lane_path.write_text(json.dumps(lane))
        self.world.poll(10)
        self.assertTrue(S["load"](self.world.store, 7).data["terminal"])

    def test_replacement_pr_does_not_silently_take_over_custody(self) -> None:
        self.world.replacement = True
        self.world.poll()
        wait = S["load"](self.world.store, 7)
        self.assertEqual(wait.data["status"], "decision")
        self.assertEqual(wait.data["pr"], "https://github.com/o/r/pull/8")
        self.assertEqual(self.world.reruns, [])

    def test_notice_acknowledgment_survives_monitor_restart(self) -> None:
        self.world.poll()
        self.world.poll(1)  # Observe the real transition from failed CI to the accepted pending retry.
        wait = S["load"](self.world.store, 7)
        for event in wait.data["notices"]:
            args = argparse.Namespace(pr_command="phase", phase_action="ack", issue=7, event=event["id"])
            with redirect_stdout(io.StringIO()):
                self.assertEqual(CLI["execute"](args, self.world.store, self.world.run), 0)
        self.assertEqual(C["watch"](self.world.store, self.world.run, set(), self.world.now), [])

    def test_stale_controller_cannot_overwrite_a_committed_intent(self) -> None:
        first = S["load"](self.world.store, 7)
        S["save"](self.world.store, replace(first, data={**first.data, "pending": "committed observation"}))
        with self.assertRaises(S["Changed"]):
            S["save"](self.world.store, replace(first, data={**first.data, "pending": "stale"}))
        self.assertEqual(S["load"](self.world.store, 7).data["pending"], "committed observation")

    def test_existing_legacy_lane_key_alphabet_remains_usable_with_new_hooks(self) -> None:
        path = self.world.store.state / "lanes/lane_one.v1.json"
        path.write_text(json.dumps({"key": "lane_one.v1", "job": "legacy-task", "revision": 1}))
        args = argparse.Namespace(lane="lane_one.v1", effect="wake", lane_revision=1)
        self.assertEqual(CLI["authorize"](args, self.world.store, self.world.run), "PHASE_LEGACY")

    def test_assertion_failure_outranks_dns_and_never_submits_a_rerun(self) -> None:
        run = self.world.run
        def services(argv):
            if argv[:3] == ["gh", "pr", "view"]:
                pull = self.world.pull()
                pull["statusCheckRollup"].append({
                    "name": "Assertions", "status": "COMPLETED", "conclusion": "FAILURE",
                    "detailsUrl": "https://github.com/o/r/actions/runs/91/job/201"})
                return json.dumps(pull)
            if argv[:2] == ["gh", "api"] and argv[-1].endswith("/jobs/201"):
                job = self.world.job()
                job.update(id=201, name="Assertions")
                job["steps"] = [{"name": "Run unit tests", "conclusion": "failure"}]
                return json.dumps(job)
            if argv[:3] == ["gh", "run", "view"] and "201" in argv:
                return "AssertionError: incorrect result"
            return run(argv)
        C["watch"](self.world.store, services, self.world.seen, self.world.now)
        self.assertEqual(S["load"](self.world.store, 7).generation, 2)
        self.assertEqual(self.world.reruns, [])

    def test_pending_workflow_defers_rerun_and_non_actions_failure_never_becomes_ready(self) -> None:
        run = self.world.run
        extra = {"context": "External review", "state": "PENDING", "targetUrl": "https://ci.example/job/1"}
        def services(argv):
            if argv[:3] == ["gh", "pr", "view"]:
                return json.dumps({**self.world.pull(), "statusCheckRollup": [*self.world.pull()["statusCheckRollup"], extra]})
            return run(argv)
        C["watch"](self.world.store, services, self.world.seen, self.world.now)
        self.assertEqual(self.world.reruns, [])
        extra["state"] = "FAILURE"
        C["watch"](self.world.store, services, self.world.seen, self.world.now)
        self.assertEqual(S["load"](self.world.store, 7).data["status"], "diagnosis")
        self.assertEqual(self.world.reruns, [])

    def test_unknown_and_retargeted_prs_preserve_custody_without_effects(self) -> None:
        for state in ("UNKNOWN", "OPEN"):
            with self.subTest(state=state):
                self.world.pr_state = state
                run = self.world.run
                def services(argv):
                    if state == "OPEN" and argv[:3] == ["gh", "pr", "view"]:
                        return json.dumps({**self.world.pull(), "baseRefName": "other"})
                    return run(argv)
                C["watch"](self.world.store, services, self.world.seen, self.world.now)
                self.assertIn(S["load"](self.world.store, 7).data["status"], ("unknown", "decision"))
                self.assertEqual(self.world.reruns, [])

    def test_hold_spanning_deadlines_keeps_all_unspent_slots(self) -> None:
        self.world.poll()
        self.world.run_status = "completed"
        with patch.dict(C["P"], {"access": lambda *a, **k: (_ for _ in ()).throw(P["S"]["Refused"]("held"))}):
            self.world.poll(150)
        self.assertEqual(len(self.world.reruns), 1)
        self.world.poll(160)
        self.assertEqual(len(self.world.reruns), 1)  # Late completion starts the real cooldown.
        self.world.poll(190)
        self.assertEqual(len(self.world.reruns), 2)

    def test_restart_after_uncertain_rerun_reconciles_remote_acceptance(self) -> None:
        run = self.world.run
        def services(argv):
            result = run(argv)
            if argv[-1].endswith("/rerun"):
                raise RuntimeError("response lost")
            return result
        C["watch"](self.world.store, services, set(), self.world.now)
        self.world.run_status = "completed"
        self.world.poll(10)
        self.world.poll(39)
        self.assertEqual(len(self.world.reruns), 1)
        self.world.poll(40)
        self.assertEqual(len(self.world.reruns), 2)

    def test_delivered_repair_is_not_reclaimed_before_its_goal_acknowledgment(self) -> None:
        self.world.mode = "assertion"
        self.world.poll()
        self.world.poll(1)
        wait = S["load"](self.world.store, 7)
        lane = json.loads(self.world.lane_path.read_text())
        self.assertEqual((wait.generation, lane["phase"]["generation"], lane["status"]), (2, 2, "working"))
        self.assertIsNone(wait.data["started_session"])

    def test_replayed_notice_keeps_its_original_generation_after_repair_dispatch(self) -> None:
        self.world.mode = "assertion"
        self.world.poll()
        replay = C["watch"](self.world.store, self.world.run, set(), self.world.now)
        event = json.loads(replay[0].split(" ", 1)[1])
        self.assertEqual(event["generation"], 1)
        self.assertEqual(S["load"](self.world.store, 7).generation, 2)

    def test_a_positively_retired_incident_does_not_block_another_jobs_recovery(self) -> None:
        self.world.poll()
        wait = S["load"](self.world.store, 7)
        incidents = {key: {**entry, "resolved": True, "resolved_at": self.world.now + 1}
                     for key, entry in wait.data["incidents"].items()}
        wait = S["save"](self.world.store, replace(wait, data={**wait.data, "incidents": incidents}))
        self.world.run_status = "completed"
        observation = C["CI"]["Observation"]("infra", "Integration tests", "infra:5:Integration tests",
            "another-independent-job", 90, 102, 2, self.world.now + 2)
        C["A"]["retry"](self.world.store, wait, observation, self.world.run, self.world.now + 3, pending=False)
        self.assertEqual(len(self.world.reruns), 2)

    def test_closed_pr_is_rechecked_before_a_queued_repair_can_start(self) -> None:
        self.world.mode = "assertion"
        run = self.world.run
        def queued(argv):
            if argv[:2] == ["dori", "resume"]:
                (self.world.store.state / "launch-queue.json").write_text(json.dumps([{
                    "key": "issue7-regression", "phase": json.loads(argv[argv.index("--phase") + 1])}]))
                return "LAUNCH_QUEUED"
            return run(argv)
        C["watch"](self.world.store, queued, self.world.seen, self.world.now)
        self.world.pr_state = "CLOSED"
        C["watch"](self.world.store, queued, self.world.seen, self.world.now + 60)
        wait = S["load"](self.world.store, 7)
        self.assertEqual(wait.data["status"], "decision")
        lane = json.loads(self.world.lane_path.read_text())
        lane.update(status="working", phase={"owner": "helio-pr", "version": 1, "generation": 2})
        self.world.lane_path.write_text(json.dumps(lane))
        args = argparse.Namespace(lane=lane["key"], effect="wake", lane_revision=lane["revision"])
        with self.assertRaisesRegex(CLI["C"]["S"]["Refused"], "canonical PR"):
            CLI["authorize"](args, self.world.store, queued)

    def test_failed_pr_observation_releases_the_completed_phase_without_claiming_readiness(self) -> None:
        run = self.world.run
        def unavailable(argv):
            if argv[:3] == ["gh", "pr", "view"]:
                raise RuntimeError("HTTP 404: canonical PR inaccessible")
            return run(argv)
        C["watch"](self.world.store, unavailable, self.world.seen, self.world.now)
        self.assertEqual(S["load"](self.world.store, 7).data["status"], "unknown")
        self.assertEqual(json.loads(self.world.lane_path.read_text())["status"], "hibernated")

    def test_interrupted_reservation_is_reconciled_in_the_same_generation(self) -> None:
        self.world.mode = "assertion"
        run = self.world.run
        resumes, recovered = [], []
        def interrupted(argv):
            if argv[:2] == ["dori", "recover-start"]:
                recovered.append(argv)
                lane = json.loads(self.world.lane_path.read_text())
                lane.update(status="hibernated", launchState=None)
                self.world.lane_path.write_text(json.dumps(lane))
                return "STARTUP_RECOVERED"
            if argv[:2] == ["dori", "resume"]:
                resumes.append(argv)
                if len(resumes) == 1:
                    lane = json.loads(self.world.lane_path.read_text())
                    lane.update(status="working", launchState="reserved",
                                phase=json.loads(argv[argv.index("--phase") + 1]))
                    self.world.lane_path.write_text(json.dumps(lane))
                    raise RuntimeError("controller interrupted after reservation")
            return run(argv)
        for minute in (0, 5, 10):
            C["watch"](self.world.store, interrupted, self.world.seen, self.world.now + minute * 60)
        self.assertEqual((len(recovered), len(resumes)), (1, 2))
        self.assertEqual(S["load"](self.world.store, 7).generation, 2)

    def test_merge_while_repair_is_queued_reserves_completion_without_waking_the_worker(self) -> None:
        self.world.mode = "assertion"
        run = self.world.run
        def queued(argv):
            if argv[:2] == ["dori", "resume"]:
                (self.world.store.state / "launch-queue.json").write_text(json.dumps([{
                    "key": "issue7-regression", "phase": json.loads(argv[argv.index("--phase") + 1])}]))
                return "LAUNCH_QUEUED"
            return run(argv)
        C["watch"](self.world.store, queued, self.world.seen, self.world.now)
        self.world.pr_state = "MERGED"
        self.world.publication.github.issue["state"] = "CLOSED"
        C["watch"](self.world.store, queued, self.world.seen, self.world.now + 60)
        lane = json.loads(self.world.lane_path.read_text())
        wait = S["load"](self.world.store, 7)
        self.assertEqual((lane["status"], lane["phase"]["generation"]), ("done-claimed", 2))
        lane["status"] = "verified-done"
        self.world.lane_path.write_text(json.dumps(lane))
        args = argparse.Namespace(lane=lane["key"], effect="complete", lane_revision=lane["revision"])
        self.assertTrue(CLI["authorize"](args, self.world.store, queued).startswith("PHASE_AUTHORIZED"))
        self.assertEqual(wait.generation, 2)

    def test_ready_and_queued_merge_use_the_actual_native_claim_command(self) -> None:
        for queued_merge in (False, True):
            with self.subTest(queued_merge=queued_merge):
                world = self.world if not queued_merge else Custody(self)
                run = world.run
                native = []
                def services(argv):
                    if argv[:2] == ["dori", "resume"]:
                        (world.store.state / "launch-queue.json").write_text(json.dumps([{
                            "key": "issue7-regression", "phase": json.loads(argv[argv.index("--phase") + 1])}]))
                        return "LAUNCH_QUEUED"
                    if argv[:2] == ["dori", "claim-done"]:
                        script = Path(__file__).resolve().parent.parent / "vendor/dori-mode/scripts/src/cli.ts"
                        result = subprocess.run(["bun", str(script), *argv[1:]], capture_output=True, text=True)
                        native.append((result.returncode, result.stderr))
                        if result.returncode:
                            raise RuntimeError(result.stderr)
                        return result.stdout
                    return run(argv)
                if queued_merge:
                    world.mode = "assertion"
                    C["watch"](world.store, services, set(), world.now)
                    world.pr_state = "MERGED"
                    world.publication.github.issue["state"] = "CLOSED"
                else:
                    world.mode = "pass"
                C["watch"](world.store, services, set(), world.now + 60)
                self.assertEqual(native, [(0, "")])
                lane = json.loads(world.lane_path.read_text())
                self.assertEqual(lane["status"], "done-claimed")
                self.assertEqual(lane["phase"]["generation"], 2 if queued_merge else 1)
                if queued_merge:
                    self.assertEqual(json.loads((world.store.state / "launch-queue.json").read_text()), [])

    def test_interrupted_pane_creation_is_visibly_held_without_relaunch_or_generation_change(self) -> None:
        self.world.mode = "assertion"
        run = self.world.run
        resumes, reconciliations = [], []
        def interrupted(argv):
            if argv[:2] == ["dori", "recover-start"]:
                reconciliations.append(argv)
                raise RuntimeError("Startup has retained resources; inspection required")
            if argv[:2] == ["dori", "resume"]:
                resumes.append(argv)
                lane = json.loads(self.world.lane_path.read_text())
                lane.update(status="working", launchState="pane-created", pane="retained:empty", tab="retained:tab",
                            phase=json.loads(argv[argv.index("--phase") + 1]))
                self.world.lane_path.write_text(json.dumps(lane))
                raise RuntimeError("interrupted before process start")
            return run(argv)
        for minute in (0, 5, 10, 60):
            C["watch"](self.world.store, interrupted, self.world.seen, self.world.now + minute * 60)
        wait = S["load"](self.world.store, 7)
        self.assertEqual((wait.generation, wait.data["status"], len(resumes)), (2, "unknown", 1))
        self.assertGreater(len(reconciliations), 0)
        self.assertTrue(any("retained resources" in notice["detail"] for notice in wait.data["notices"]))
        self.assertEqual(json.loads(self.world.lane_path.read_text())["pane"], "retained:empty")
