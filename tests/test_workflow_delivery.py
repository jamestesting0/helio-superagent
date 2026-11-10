"""Installed transport contracts: one logical completion, independent of prose."""
import base64
import json
import os
import runpy
from pathlib import Path
import selectors
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests/fixtures"


class WorkflowDeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.installation = tempfile.TemporaryDirectory(prefix="helio-workflow-install-")
        cls.installed = Path(cls.installation.name)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/install.py"),
                                 "--home", str(cls.installed), "--apply"], capture_output=True, text=True)
        if result.returncode:
            cls.installation.cleanup()
            raise RuntimeError(result.stderr)
        cls.base = cls.installed / ".dori/elobot"

    @classmethod
    def tearDownClass(cls):
        cls.installation.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="helio-workflow-case-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / ".dori/elobot").mkdir(parents=True)
        (self.home / ".dori/elobot/trusted-users").write_text("77\n")
        self.state = self.home / "state"
        self.state.mkdir()
        self.server = subprocess.Popen(["bun", str(FIXTURES / "workflow-discord.ts")],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.close_server)
        with selectors.DefaultSelector() as selector:
            selector.register(self.server.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(10), "wire fixture did not start")
            ready = self.server.stdout.readline()
        self.assertTrue(ready.startswith("READY "), ready)
        self.url = ready.removeprefix("READY ").strip()
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.home), "DORI_STATE_DIR": str(self.state),
                    "DORI_DISCORD_TOKEN": "synthetic", "DORI_DISCORD_OWNER_ID": "99",
                    "DORI_DISCORD_ALLOWED": "100,200", "DORI_DISCORD_TRUSTED_CHANNELS": "100", "WORKFLOW_FIXTURE": self.url}

    def close_server(self):
        self.server.terminate()
        self.server.communicate(timeout=5)

    def messages(self):
        with urllib.request.urlopen(self.url + "fixture/messages", timeout=5) as response:
            return json.load(response)

    def command(self, helper, text, *, channel="100", target="500", event="completion", extra=()):
        path = self.home / f"summary-{len(list(self.home.glob('summary-*')))}.txt"
        path.write_text(text)
        return ["bun", "--preload", str(FIXTURES / "workflow-preload.ts"), str(self.base / helper),
                channel, target, "--text-file", str(path), *(["--event", event] if event else []), *extra]

    def invoke(self, helper, text, **options):
        result = subprocess.run(self.command(helper, text, **options), env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def open_topic(self, channel="100"):
        # Topics open on a message Helio received; the claim records its channel and author.
        store = self.installed / ".dori/discord-inbound/conversations/conversations.ts"
        claim = (f"import {{ Conversations }} from {json.dumps(str(store))};"
                 f"const s = new Conversations({json.dumps(str(self.state / 'discord-conversations.sqlite'))});"
                 f"s.claimWorking({json.dumps(channel)}, '77', '500', Date.now()); s.dispose();")
        subprocess.run(["bun", "-e", claim], env=self.env, capture_output=True, check=True, timeout=20)
        result = subprocess.run(["bun", str(self.installed / ".dori/discord-inbound/conversation.ts"),
                                 "open", "500", "Requested change"],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def topic(self):
        with sqlite3.connect(self.state / "discord-conversations.sqlite") as db:
            db.row_factory = sqlite3.Row
            return dict(db.execute("SELECT * FROM conversations WHERE anchor_message_id='500'").fetchone())

    def test_final_evidence_settles_the_requested_topic_and_retry_does_not_post_again(self):
        self.open_topic()
        flags = ("--disposition", "final", "--job", "issue-8",
                 "--issue", "https://github.com/jamestesting0/elo-bot/issues/8")
        self.invoke("evidence.ts", "PR is prepared; checks passed.", extra=flags)
        # A final reply that links an issue subscribes the topic, so it resolves as tracked by that issue.
        self.assertEqual((self.topic()["status"], self.topic()["outcome"], self.topic()["job"]),
                         ("resolved", "issue", "issue-8"))
        self.invoke("evidence.ts", "The same completed handoff.", extra=flags)
        self.assertEqual(len(self.messages()), 1)

    def test_progress_and_questions_have_explicit_states(self):
        self.open_topic()
        self.invoke("reply.ts", "Still checking.", event="progress:1", extra=("--disposition", "progress"))
        self.assertEqual((self.topic()["status"], self.topic()["question_started_at"]), ("open", None))
        self.invoke("reply.ts", "Which server?", event="question:1",
                    extra=("--disposition", "question", "--waiting-on", "Which server?"))
        self.assertEqual(self.topic()["reply_disposition"], "question")
        self.assertIsNotNone(self.topic()["question_started_at"])
        self.assertEqual(self.topic()["waiting_on"], "Which server?")

    def test_current_channel_policy_blocks_all_installed_reply_paths(self):
        for helper in ("reply.ts", "evidence.ts"):
            for state in (True, False):
                for policy in ("ignored", "outside-allowlist"):
                    with self.subTest(helper=helper, state=state, policy=policy):
                        env = {**self.env, "DORI_DISCORD_ALLOWED": "999",
                               "DORI_DISCORD_TRUSTED_CHANNELS": "999"}
                        if policy == "ignored":
                            env["DORI_DISCORD_IGNORED_CHANNELS"] = "100"
                        if not state:
                            env.pop("DORI_STATE_DIR")
                        before = self.messages()
                        result = subprocess.run(self.command(helper, "Withheld reply", event=None),
                                                env=env, capture_output=True, text=True, timeout=20)
                        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertEqual(self.messages(), before)

    def test_partial_routed_final_keeps_topic_open_until_all_existing_routes_are_delivered(self):
        self.open_topic("200")
        with urllib.request.urlopen(self.url + "fixture/fail-next?channel=1077", timeout=5):
            pass
        flags = ("--disposition", "final", "--job", "issue-8")
        first = subprocess.run(self.command("evidence.ts", "PR handoff.", channel="200", extra=flags),
                               env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.topic()["status"], "open")
        self.invoke("evidence.ts", "PR handoff.", channel="200", extra=flags)
        self.assertEqual(self.topic()["status"], "resolved")
        self.assertEqual([row["channel_id"] for row in self.messages()], ["1099", "1077", "200"])

    def test_private_result_route_cannot_start_a_requester_question_timer(self):
        self.open_topic("200")
        result = subprocess.run(self.command("evidence.ts", "Which server?", channel="200",
                                extra=("--disposition", "question", "--waiting-on", "Which server?")),
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.messages(), [])
        self.assertEqual((self.topic()["status"], self.topic()["question_started_at"]), ("open", None))

    def test_evidence_and_lead_reply_share_completion_but_allow_later_ci_and_new_requests(self):
        image = self.home / "proof.png"
        image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII="))
        self.invoke("evidence.ts", "Removed the requested fact; tests passed.", event=None, extra=(str(image),))
        self.invoke("reply.ts", "The fact is removed and the suite passed.")
        messages = self.messages()
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["wire_files"], 1)
        self.invoke("reply.ts", "CI is green.", event="ci:abc123")
        self.invoke("evidence.ts", "Second request done.", target="501")
        self.assertEqual(len(self.messages()), 3)

    def test_two_processes_with_different_wording_publish_one_completion(self):
        commands = [self.command("evidence.ts", "Result and evidence."),
                    self.command("reply.ts", "The same result summarized differently.")]
        processes = [subprocess.Popen(command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for command in commands]
        try:
            for process in processes:
                output, error = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, output + error)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        self.assertEqual(len(self.messages()), 1)

    def test_partial_normal_channel_delivery_resumes_forward_and_note_without_repeating_owner_evidence(self):
        with urllib.request.urlopen(self.url + "fixture/fail-next?channel=1077", timeout=5) as response:
            self.assertEqual(response.status, 200)
        first = subprocess.run(self.command("evidence.ts", "Result with evidence.", channel="200"),
                               env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(first.returncode, 0)
        self.invoke("evidence.ts", "Reworded result from a retry.", channel="200")
        self.invoke("evidence.ts", "Repeated report after recovery.", channel="200")
        messages = self.messages()
        self.assertEqual([row["channel_id"] for row in messages], ["1099", "1077", "200"])
        self.assertEqual(messages[1]["message_reference"]["message_id"], messages[0]["id"])

    def test_owner_only_part_is_not_lost_or_forwarded_after_shareable_completion(self):
        self.invoke("evidence.ts", "Shareable result.", channel="200")
        self.invoke("evidence.ts", "Private detail.", channel="200", extra=("--owner-only",))
        messages = self.messages()
        self.assertEqual([row["channel_id"] for row in messages], ["1099", "1077", "200", "1099"])
        self.assertTrue(messages[-1]["content"].startswith("Private detail."))

    def test_uncertain_new_event_does_not_reuse_an_older_events_same_text_receipt(self):
        self.invoke("evidence.ts", "Checks passed.")
        with urllib.request.urlopen(self.url + "fixture/fail-next?channel=100", timeout=5) as response:
            self.assertEqual(response.status, 200)
        first = subprocess.run(self.command("evidence.ts", "Checks passed.", event="ci:abc123"),
                               env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(first.returncode, 0)
        result = self.invoke("reply.ts", "The later CI checks passed.", event="ci:abc123")
        messages = self.messages()
        self.assertEqual(len(messages), 2)
        self.assertIn("SENT " + messages[-1]["id"], result.stdout)
        retention = runpy.run_path(str(ROOT / "scripts/helio_retention.py"))
        with sqlite3.connect(self.state / "reply-sends.sqlite") as db, db:
            for rule in retention["RULES"]:
                if rule.db == "reply-sends.sqlite":
                    for statement in rule.sql:
                        db.execute(statement, retention["params"](time.time()))
        self.invoke("evidence.ts", "Repeated new milestone after housekeeping.", event="ci:abc123")
        self.assertEqual(len(self.messages()), 2)
