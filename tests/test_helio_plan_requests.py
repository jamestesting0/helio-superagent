"""Planning acceptance survives intake cleanup without granting implementation authority."""
import datetime
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import sqlite3
from unittest.mock import patch
from urllib.parse import urlparse
from plan_fixture import stage_source

from test_helio_plan import PlanCase, POSTED, REPO, P, PLAN, discord


class PlanRequestTests(PlanCase):
    @contextmanager
    def real_source(self, changes, revoke_during_read=False, author="100", approval=None):
        home = self.dir / "source-home"
        (home / ".dori/elobot").mkdir(parents=True, exist_ok=True)
        (home / ".dori/elobot/trusted-users").write_text("200")
        policy = home / "policy"
        policy.mkdir(exist_ok=True)
        values = {"DORI_DISCORD_OWNER_ID": "100", "DORI_DISCORD_ALLOWED": "1",
                  "HELIO_TRUSTED_USERS": "200", "DORI_DISCORD_IGNORED_CHANNELS": "",
                  "DORI_DISCORD_SCOPE_CATEGORY": "400", **changes}
        policy_file = policy / "policy.json"
        policy_file.write_text(json.dumps({"version": 1, "revision": "a" * 64, "values": values}))
        calls = []

        def response(request, timeout=10):
            route = urlparse(request.full_url).path
            calls.append(route)
            if route.endswith("/users/@me"):
                body = {"id": "999"}
            elif route.endswith("/channels/1"):
                if revoke_during_read:
                    policy_file.write_text(json.dumps({"version": 1, "revision": "b" * 64,
                                                       "values": {**values, "DORI_DISCORD_ALLOWED": "999"}}))
                body = {"id": "1", "type": 0, "parent_id": "400"}
            elif route.endswith("/channels/400"):
                body = {"id": "400", "type": 4, "parent_id": None}
            elif route.endswith("/messages/555"):
                body = discord(author=author)("555")["live"]
            elif route.endswith("/messages/777"):
                original = discord(content="cancel planning issue #12")("777")["live"]
                body = approval if approval is not None else {**original, "id": "777"}
            else:
                raise AssertionError(f"Unexpected real planning request {route}")
            return io.BytesIO(json.dumps(body).encode())

        with patch.dict(os.environ, {"HOME": str(home), "DORI_POLICY_DIR": str(policy),
                                     "DORI_DISCORD_TOKEN": "offline", "DORI_DISCORD_OWNER_ID": "100",
                                     "DORI_DISCORD_ALLOWED": "1"}), \
                patch("urllib.request.urlopen", side_effect=response):
            yield P["discord_message"], calls

    def seed(self) -> None:
        reader = discord()
        payload = reader("555")["payload"]
        stage_source(Path(os.environ["DORI_STATE_DIR"]), json.dumps(payload))

    def test_recorded_plan_source_survives_acknowledgment_and_does_not_authorize_work(self) -> None:
        self.seed()
        reader = discord()
        args = ("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        code, output = self.run_cli(*args, discord_fn=reader)
        self.assertEqual(code, 0, output)
        self.assertIn("PLAN_REQUEST_RECORDED", output)
        path = Path(os.environ["DORI_STATE_DIR"]) / "discord-delivery.sqlite"
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute("SELECT id FROM acceptance").fetchall(), [("555",)])
            db.execute("UPDATE delivery SET payload=NULL WHERE stream='inbound' AND id='555'")
        resumed, output = self.run_cli(*args, discord_fn=reader, now=POSTED + datetime.timedelta(days=4))
        self.assertEqual(resumed, 0, output)
        self.assertIn("PLAN_REQUEST_RECORDED", output)
        with self.assertRaises(P["WORK"]["Refused"]):
            P["WORK"]["available"](REPO, 12, POSTED)

    def test_real_source_rejects_ignored_channels_ancestors_and_wrong_scope_before_acceptance(self) -> None:
        self.seed()
        for denied in ({"DORI_DISCORD_IGNORED_CHANNELS": "1"},
                       {"DORI_DISCORD_IGNORED_CHANNELS": "400"},
                       {"DORI_DISCORD_SCOPE_CATEGORY": "999"}):
            with self.subTest(denied=denied), self.real_source(denied) as (reader, _):
                code, output = self.run_cli("request", "record", "--issue", "12", "--message", "555",
                                           "--channel", "1", discord_fn=reader)
                self.assertEqual(code, 1, output)
                with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM plan_requests").fetchone()[0], 0)
                    self.assertEqual(db.execute("SELECT count(*) FROM acceptance").fetchone()[0], 0)

    def test_first_approval_checks_current_planning_privacy_before_reading_content(self) -> None:
        self.assertEqual(self.post()[0], 0)
        later = POSTED + datetime.timedelta(hours=1)
        source = discord(content="approve #12", sent=later)("777")
        stage_source(self.dir / "state", json.dumps({**source["payload"], "message_id": "777"}))
        live = {**source["live"], "id": "777"}
        for denied in ({"DORI_DISCORD_IGNORED_CHANNELS": "1"},
                       {"DORI_DISCORD_IGNORED_CHANNELS": "400"},
                       {"DORI_DISCORD_SCOPE_CATEGORY": "999"}):
            with self.subTest(denied=denied), self.real_source(denied, approval=live) as (reader, calls):
                before = self.gh_fake.comments[0]["body"]
                code, output = self.run_cli("approve", "--issue", "12", "--message", "777",
                                           discord_fn=reader, now=later)
                self.assertEqual(code, 1, output)
                self.assertFalse(P["approved"](self.data()))
                self.assertEqual(self.gh_fake.comments[0]["body"], before)
                self.assertFalse(any("/messages/" in route for route in calls), calls)
        with self.real_source({}, approval=live) as (reader, _):
            code, output = self.run_cli("approve", "--issue", "12", "--message", "777",
                                       discord_fn=reader, now=later)
            self.assertEqual(code, 0, output)
            self.assertTrue(P["approved"](self.data()))

    def test_real_source_accepts_current_permitted_policy_and_withholds_revoked_resume(self) -> None:
        self.seed()
        args = ("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        with self.real_source({}) as (reader, _):
            code, output = self.run_cli(*args, discord_fn=reader)
            self.assertEqual(code, 0, output)
        with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
            db.execute("UPDATE delivery SET payload=NULL")
        with self.real_source({"DORI_DISCORD_IGNORED_CHANNELS": "400"}) as (reader, _):
            code, output = self.run_cli(*args, discord_fn=reader, now=POSTED + datetime.timedelta(days=4))
            self.assertEqual(code, 1, output)

    def test_first_approval_rechecks_privacy_at_publication_dispatch(self) -> None:
        self.assertEqual(self.post()[0], 0)
        later = POSTED + datetime.timedelta(hours=1)
        source = discord(content="approve #12", sent=later)("777")
        stage_source(self.dir / "state", json.dumps({**source["payload"], "message_id": "777"}))
        with self.real_source({}, approval={**source["live"], "id": "777"}) as (reader, _):
            original = self.gh.save

            def revoke(*args, **kwargs):
                path = self.dir / "source-home/policy/policy.json"
                policy = json.loads(path.read_text())
                policy["revision"] = "b" * 64
                policy["values"]["DORI_DISCORD_SCOPE_CATEGORY"] = "999"
                path.write_text(json.dumps(policy))
                return original(*args, **kwargs)

            with patch.object(self.gh, "save", side_effect=revoke):
                code, output = self.run_cli("approve", "--issue", "12", "--message", "777",
                                           discord_fn=reader, now=later)
            self.assertEqual(code, 1, output)
            self.assertFalse(P["approved"](self.data()))

    def test_real_source_withholds_cancellation_and_dispatch_from_excluded_locations(self) -> None:
        self.seed()
        self.assertEqual(self.run_cli("request", "record", "--issue", "12", "--message", "555", "--channel", "1")[0], 0)
        stage_source(self.dir / "state", json.dumps({
            "message_id": "777", "channel_id": "1", "author_id": "100", "content": "cancel planning issue #12"}))
        draft = self.dir / "private-plan.json"
        draft.write_text(json.dumps(PLAN))
        with self.real_source({"DORI_DISCORD_SCOPE_CATEGORY": "999"}) as (reader, _):
            code, output = self.run_cli("request", "cancel", "--issue", "12", "--message", "555",
                                       "--channel", "1", "--from-message", "777", discord_fn=reader)
            self.assertEqual(code, 1, output)
            code, output = self.run_cli("post", "--issue", "12", "--request-message", "555",
                                       "--file", str(draft), "--announcement-file", str(self.dir / "announcement.txt"),
                                       discord_fn=reader)
            self.assertEqual(code, 1, output)
        self.assertEqual(self.gh_fake.comments, [])
        with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
            self.assertEqual(db.execute("SELECT state FROM plan_requests").fetchone()[0], "accepted")

    def test_real_source_rechecks_policy_after_ancestry_reads(self) -> None:
        self.seed()
        with self.real_source({}, revoke_during_read=True) as (reader, _):
            code, output = self.run_cli("request", "record", "--issue", "12", "--message", "555",
                                       "--channel", "1", discord_fn=reader)
            self.assertEqual(code, 1, output)

    def test_real_source_refuses_an_accepted_trusted_sender_after_an_owner_block(self) -> None:
        stage_source(self.dir / "state", json.dumps(discord(author="200")("555")["payload"]))
        args = ("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        with self.real_source({}, author="200") as (reader, _):
            code, output = self.run_cli(*args, discord_fn=reader)
            self.assertEqual(code, 0, output)
            with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
                db.execute("INSERT INTO blocked_users(user_id,source,reason,created_by,created_at) VALUES('200','owner','Fixture','100',0)")
                db.execute("UPDATE delivery SET payload=NULL")
            code, output = self.run_cli(*args, discord_fn=reader)
            self.assertEqual(code, 1, output)

    def test_recording_rejects_any_pending_payload_change_before_commit(self) -> None:
        self.seed()

        def changed(message, channel=None, fingerprint=None):
            with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
                raw = db.execute("SELECT payload FROM delivery WHERE id='555'").fetchone()[0]
                db.execute("UPDATE delivery SET payload=? WHERE id='555'",
                           (json.dumps({**json.loads(raw), "author": "Changed display label"}),))
            return discord()(message, channel, fingerprint)

        code, output = self.run_cli("request", "record", "--issue", "12", "--message", "555", "--channel", "1",
                                   discord_fn=changed)
        self.assertEqual(code, 1, output)
        with sqlite3.connect(self.dir / "state/discord-delivery.sqlite") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM acceptance").fetchone()[0], 0)

    def test_acknowledged_source_without_a_planning_receipt_cannot_be_reconstructed(self) -> None:
        self.seed()
        path = Path(os.environ["DORI_STATE_DIR"]) / "discord-delivery.sqlite"
        with sqlite3.connect(path) as db:
            db.execute("UPDATE delivery SET payload=NULL")
        code, output = self.run_cli("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        self.assertEqual(code, 1, output)
        self.assertIn("PLAN_REFUSED", output)

    def test_existing_receipt_rejects_an_edited_source_instead_of_replacing_its_fingerprint(self) -> None:
        self.seed()
        args = ("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        code, output = self.run_cli(*args)
        self.assertEqual(code, 0, output)
        code, output = self.run_cli(*args, discord_fn=discord(content="finalize a different scope"))
        self.assertEqual(code, 1, output)

    def test_accepted_plan_can_be_posted_after_intake_cleanup_and_elapsed_clarification(self) -> None:
        self.seed()
        code, output = self.run_cli("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        self.assertEqual(code, 0, output)
        path = Path(os.environ["DORI_STATE_DIR"]) / "discord-delivery.sqlite"
        with sqlite3.connect(path) as db:
            db.execute("UPDATE delivery SET payload=NULL")
        code, output = self.post(now=POSTED + datetime.timedelta(days=4))
        self.assertEqual(code, 0, output)
        self.assertIn("PLAN_POSTED", output)
        self.assertEqual(len(self.gh_fake.comments), 1)

    def test_concurrent_recording_reuses_the_committed_receipt_after_the_other_caller_acknowledges(self) -> None:
        self.seed()
        reader = discord()
        args = ("request", "record", "--issue", "12", "--message", "555", "--channel", "1")

        def concurrent(message, channel=None, fingerprint=None):
            code, output = self.run_cli(*args, discord_fn=reader)
            self.assertEqual(code, 0, output)
            with sqlite3.connect(Path(os.environ["DORI_STATE_DIR"]) / "discord-delivery.sqlite") as db:
                db.execute("UPDATE delivery SET payload=NULL")
            return reader(message, channel, fingerprint)

        code, output = self.run_cli(*args, discord_fn=concurrent)

        self.assertEqual(code, 0, output)
        self.assertIn("PLAN_REQUEST_RECORDED", output)

    def test_explicit_cancellation_survives_restart_and_prevents_posting(self) -> None:
        self.seed()
        args = ("request", "record", "--issue", "12", "--message", "555", "--channel", "1")
        code, output = self.run_cli(*args)
        self.assertEqual(code, 0, output)

        def cancellation(message, channel=None, fingerprint=None):
            source = discord(content="cancel planning issue #12")(message, channel, fingerprint)
            return {**source, "payload": {**source["payload"], "message_id": "777"},
                    "live": {**source["live"], "id": "777"}}

        stage_source(Path(os.environ["DORI_STATE_DIR"]), json.dumps(cancellation("777")["payload"]))
        code, output = self.run_cli("request", "cancel", "--issue", "12", "--message", "555",
                                   "--channel", "1", "--from-message", "777", discord_fn=cancellation)
        self.assertEqual(code, 0, output)
        self.assertIn("PLAN_REQUEST_CANCELLED", output)
        code, output = self.post()
        self.assertEqual(code, 1, output)
        self.assertEqual(self.gh_fake.comments, [])
