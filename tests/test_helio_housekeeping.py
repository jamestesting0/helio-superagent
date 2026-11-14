import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import gzip
import json
import os
import runpy
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from state_fixture import build_state  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HK = runpy.run_path(str(ROOT / "scripts/helio_housekeeping.py"))
RETENTION = runpy.run_path(str(ROOT / "scripts/helio_retention.py"))
NOW = 1_800_000_000.0
DAY = 86_400
EPOCH_MS = 1420070400000


def snowflake(seconds: float) -> str:
    return str((int(seconds * 1000) - EPOCH_MS) << 22)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.state = self.home / ".dori/elobot/state"
        build_state(self.state)
        self.dori = Path(self.tmp.name) / "dori"
        self.dori.write_text("#!/bin/sh\necho '[]'\n")
        self.dori.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def db(self, name):
        return closing(sqlite3.connect(self.state / name))

    def housekeeping(self, approve=False, preview=False):
        return HK["run"](self.state, self.home, NOW, [str(self.dori)], approve=approve, preview=preview)

    def snapshot(self):
        files = {}
        for path in sorted(self.home.rglob("*")):
            # SQLite creates its -wal/-shm coordination files for any reader, read-only ones included; they hold no data.
            if path.is_file() and path.name != "housekeeping-last.json" and not path.name.endswith(("-wal", "-shm")):
                files[str(path.relative_to(self.home))] = (path.stat().st_size, path.read_bytes())
        return files


class RetentionCoverage(Fixture):
    def test_every_table_the_code_creates_has_a_retention_rule(self):
        self.assertEqual(RETENTION["uncovered"](self.state), [])

    def test_a_table_without_a_rule_is_reported_and_left_untouched(self):
        with self.db("discord-delivery.sqlite") as db, db:
            db.execute("CREATE TABLE mystery (x)")
            db.execute("INSERT INTO mystery VALUES (1)")
        result = self.housekeeping(approve=True)
        self.assertEqual(result["uncovered"], ["discord-delivery.sqlite:mystery"])
        with self.db("discord-delivery.sqlite") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM mystery").fetchone()[0], 1)


class RetentionRules(Fixture):
    def test_custody_preserves_active_and_unacknowledged_state_and_bound_proof(self):
        with self.db("issue-updates.sqlite") as db, db:
            for issue, terminal, acknowledged in ((10, False, True), (11, True, False), (12, True, True)):
                data = json.dumps({"terminal": terminal, "notices": [{"acknowledged": acknowledged}]})
                db.execute("INSERT INTO pr_waits VALUES ('o/r',?,'job',1,1,?,?)",
                           (issue, data, NOW - 200 * DAY))
                db.execute("""INSERT INTO pr_verifications
                    (id,repo,issue,head,base,branch,record,status,created_at,published_at)
                    VALUES (?,'o/r',?,'head','base','branch','{}','published',?,?)""",
                           (str(issue), issue, NOW - 200 * DAY, NOW - 200 * DAY))
        HK["retention"](self.state, NOW, apply=True)
        with self.db("issue-updates.sqlite") as db:
            self.assertEqual(db.execute("SELECT issue FROM pr_waits ORDER BY issue").fetchall(), [(10,), (11,)])
            self.assertEqual(db.execute("SELECT issue FROM pr_verifications ORDER BY issue").fetchall(), [(10,), (11,)])

    def test_planning_sources_retain_active_consent_and_expire_only_settled_receipts(self):
        with self.db("discord-delivery.sqlite") as db, db:
            for message, state, settled in (("1", "accepted", False), ("2", "posted", False),
                                             ("3", "cancelled", True)):
                db.execute("""INSERT INTO plan_requests
                    (repo,issue,message,channel,author,author_name,source_hash,accepted_at,state,settled_at)
                    VALUES('o/r',1,?,'100','99','Owner','fingerprint',datetime(?,'unixepoch'),?,
                           CASE WHEN ? THEN datetime(?,'unixepoch') END)""",
                           (message, NOW - 200 * DAY, state, settled, NOW - 200 * DAY))
        HK["retention"](self.state, NOW, apply=True)
        with self.db("discord-delivery.sqlite") as db:
            self.assertEqual(db.execute("SELECT message,state FROM plan_requests ORDER BY message").fetchall(),
                             [("1", "accepted"), ("2", "posted")])

    def test_plan_effects_keep_unresolved_bodies_and_erase_settled_content_before_receipts(self):
        with self.db("issue-updates.sqlite") as db, db:
            for identity, state, age in (("uncertain", "uncertain", 200), ("prepared", "prepared", 200),
                                         ("settled", "confirmed", 40), ("expired", "confirmed", 200)):
                db.execute("""INSERT INTO plan_publications
                    (id,repo,issue,kind,before_body,after_body,before_hash,after_hash,request_binding,
                     state,created_at,last_checked_at,completed_at)
                    VALUES (?,'o/r',1,'comment','private preimage','published body','before','after','{}',?,?,?,?)""",
                           (identity, state, NOW - age * DAY, NOW - age * DAY,
                            NOW - age * DAY if state == "confirmed" else None))
        HK["retention"](self.state, NOW, apply=True)
        with self.db("issue-updates.sqlite") as db:
            rows = db.execute("SELECT id,before_body,after_body FROM plan_publications ORDER BY id").fetchall()
        self.assertEqual(rows, [("prepared", "private preimage", "published body"), ("settled", "", ""),
                                ("uncertain", "private preimage", "published body")])

    def test_shared_context_snapshot_survives_while_any_input_references_it(self):
        with self.db("discord-delivery.sqlite") as db, db:
            for identity in ("active", "settled"):
                db.execute("INSERT INTO turn_context_snapshots VALUES (?,'100','[]',?)", (identity, NOW - 40 * DAY))
            db.execute("INSERT INTO delivery VALUES ('inbound','400',?)",
                       (json.dumps({"conversation": {"context_snapshot": "active"}}),))
        HK["retention"](self.state, NOW, apply=True)
        with self.db("discord-delivery.sqlite") as db, db:
            self.assertEqual(db.execute("SELECT id FROM turn_context_snapshots").fetchall(), [("active",)])
            db.execute("UPDATE delivery SET payload=NULL WHERE id='400'")
        HK["retention"](self.state, NOW, apply=True)
        with self.db("discord-delivery.sqlite") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM turn_context_snapshots").fetchone()[0], 0)

    def test_completed_and_uncertain_followup_receipts_survive_retention(self):
        with self.db("issue-updates.sqlite") as db, db:
            db.execute("""INSERT INTO followup_creations
                SELECT key || '-uncertain',repo,previous,channel,message || '3',fingerprint,1,NULL
                FROM followup_creations""")
            before = db.execute("SELECT * FROM followup_creations ORDER BY key").fetchall()
        HK["retention"](self.state, NOW + 400 * DAY, apply=True)
        with self.db("issue-updates.sqlite") as db:
            self.assertEqual(db.execute("SELECT * FROM followup_creations ORDER BY key").fetchall(), before)

    def test_ignored_receipts_keep_unfinished_cleanup_and_pending_payloads(self):
        with self.db("discord-delivery.sqlite") as db, db:
            for ident, cleaned, payload in [("1", 1, None), ("2", 0, None), ("3", 1, "pending")]:
                db.execute("INSERT INTO delivery VALUES ('inbound',?,?)", (ident, payload))
                db.execute("INSERT INTO ignored(stream,id,source_digest,ignored_at,reason,attachments_cleaned) "
                           "VALUES ('inbound',?,'digest',datetime(?,'unixepoch'),'system-event',?)",
                           (ident, NOW - 200 * DAY, cleaned))
        self.housekeeping(approve=True)
        with self.db("discord-delivery.sqlite") as db:
            self.assertEqual(db.execute("SELECT id FROM ignored ORDER BY id").fetchall(), [("2",), ("3",)])

    def seed(self):
        old, recent = NOW - 200 * DAY, NOW - DAY
        with self.db("discord-delivery.sqlite") as db, db:
            for stream, ident, payload in [("context", snowflake(NOW - 40 * DAY), "old context"),
                                           ("context", snowflake(recent), "new context"),
                                           ("inbound", snowflake(old), "accepted old work"),
                                           ("inbound", snowflake(old), None)]:
                db.execute("INSERT OR REPLACE INTO delivery VALUES (?,?,?)", (stream, ident if payload else snowflake(old - 1), payload))
            db.execute("INSERT INTO acceptance(stream,id) VALUES ('inbound',?)", (snowflake(old),))
            db.execute("INSERT INTO handling(stream,id,disposition,reason) VALUES ('inbound',?,'done',NULL)", (snowflake(old - 1),))
            db.execute("INSERT INTO strikes (message_id,user_id,channel_id,at) VALUES ('9','u','c',?)", (int((NOW - 2 * DAY) * 1000),))
            db.execute("CREATE TABLE context_quarantine (id TEXT PRIMARY KEY, payload TEXT NOT NULL, quarantined_at TEXT NOT NULL)")
            db.execute("INSERT INTO context_quarantine VALUES ('1','private','2026-01-01 00:00:00')")
        with self.db("discord-questions.sqlite") as db, db:
            db.execute("DELETE FROM questions")
            for ident, status in [("q-done", "done"), ("q-open", "awaiting_answer")]:
                db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,updated) VALUES (?,?,?,?,?,?,?,?)",
                           (ident, ident, "l", "owner", "1", "text", status, int((NOW - 60 * DAY) * 1000)))
        with self.db("discord-prompts.sqlite") as db, db:
            for ident, status, used in [("p-done", "approved", 1), ("p-unused", "confirmed", None)]:
                db.execute("INSERT INTO prompts(id,kind,action,target,revision,content,channel_id,status,created_at,expires_at,used_at) "
                           "VALUES (?,'confirm','merge','t','r','c','1',?,?,?,?)", (ident, status, int((NOW - 60 * DAY) * 1000), 0, used))

    def counts(self):
        with self.db("discord-delivery.sqlite") as db:
            pending = {row[0] for row in db.execute("SELECT payload FROM delivery WHERE payload IS NOT NULL")}
            receipts = db.execute("SELECT count(*) FROM delivery WHERE payload IS NULL").fetchone()[0]
            strikes = db.execute("SELECT count(*) FROM strikes").fetchone()[0]
            quarantine = db.execute("SELECT count(*) FROM context_quarantine").fetchone()[0]
        with self.db("discord-questions.sqlite") as db:
            questions = {row[0] for row in db.execute("SELECT id FROM questions")}
        with self.db("discord-prompts.sqlite") as db:
            prompts = {row[0] for row in db.execute("SELECT id FROM prompts")}
        return pending, receipts, strikes, quarantine, questions, prompts

    def test_first_run_only_reports_until_the_owner_approves(self):
        self.seed()
        before = self.counts()
        result = self.housekeeping()
        self.assertEqual(result["mode"], "dry-run")
        self.assertGreater(sum(result["rows"].values()), 0)
        self.assertEqual(self.counts(), before)
        self.assertIn('approve="helio housekeeping --approve-first-run"', HK["summary"](result))

    def test_approved_run_erases_settled_chat_and_keeps_unresolved_work(self):
        self.seed()
        self.housekeeping(approve=True)
        pending, receipts, strikes, quarantine, questions, prompts = self.counts()
        self.assertEqual(pending, {"new context", "accepted old work"})
        self.assertEqual((receipts, strikes, quarantine), (1, 0, 0))
        self.assertEqual(questions, {"q-open"})
        self.assertEqual(prompts, {"p-unused"})


    def test_derived_history_loses_its_body_at_30_days_and_its_metadata_at_180(self):
        iso = lambda days: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(NOW - days * DAY))
        with self.db("issue-updates.sqlite") as db, db:
            for ident, completed, age in [("op-month", 1, 40), ("op-old", 2, 200), ("op-open", 0, None)]:
                db.execute("INSERT INTO operations(id,repo,issue,before_body,after_body,change,completed,completed_at) VALUES (?,?,?,?,?,?,?,?)",
                           (ident, "o/r", 1, "", "published body", '{"note":"x"}', completed, None if age is None else int(NOW - age * DAY)))
        with self.db("discord-delivery.sqlite") as db, db:
            for ident, age in [("rec-month", 40), ("rec-old", 200)]:
                db.execute("INSERT INTO inbound_recovery VALUES (?,?,?,?,'settled','quoted text','evidence text')", (ident, "h", iso(age), iso(age)))
        with self.db("reply-sends.sqlite") as db, db:
            for target, age in [("t-month", 40), ("t-old", 200)]:
                db.execute("INSERT INTO reply_sends(target,text_hash,state,reply_id,started_at) VALUES (?,?,'sent','r',?)",
                           (target, "hash", int((NOW - age * DAY) * 1000)))
            db.execute("INSERT INTO reply_sends(target,text_hash,state,started_at,pending_text) VALUES ('t-unknown','event:completion','sending',0,'pending result')")
        self.housekeeping(approve=True)
        with self.db("issue-updates.sqlite") as db:
            ops = {row[0]: row[1:] for row in db.execute("SELECT id,after_body,change FROM operations WHERE id LIKE 'op-%'")}
        with self.db("discord-delivery.sqlite") as db:
            recovery = {row[0]: row[1:] for row in db.execute("SELECT id,outcome,reason,evidence FROM inbound_recovery")}
        with self.db("reply-sends.sqlite") as db:
            sends = {row[0] for row in db.execute("SELECT target FROM reply_sends WHERE target LIKE 't-%'")}
        self.assertEqual(ops, {"op-month": ("", ""), "op-open": ("published body", '{"note":"x"}')})
        self.assertEqual(recovery, {"rec-month": ("settled", None, None)})
        self.assertEqual(sends, {"t-month", "t-unknown"})


    def test_a_rule_whose_column_is_not_migrated_yet_is_reported_and_the_rest_still_apply(self):
        self.seed()
        with self.db("issue-updates.sqlite") as db, db:
            db.execute("ALTER TABLE operations DROP COLUMN completed_at")
        result = self.housekeeping(approve=True)
        self.assertEqual(list(result["skipped"]), ["issue-updates.sqlite:operations"])
        self.assertIn("rules_skipped=1", HK["summary"](result))
        self.assertTrue(HK["notable"](result))
        self.assertEqual(self.counts()[4], {"q-open"})

    def test_worktree_keep_reasons_are_kept_in_the_report(self):
        rows = [{"key": "a", "path": "/w/a", "action": "kept", "reason": "lane is working"},
                {"key": "b", "path": "/w/b", "action": "removed", "reason": "PR acme/app#2 merged 4 days ago", "evidence": "https://github.com/acme/app/pull/2"}]
        self.dori.write_text("#!/bin/sh\necho '" + json.dumps(rows) + "'\n")
        result = self.housekeeping(approve=True)
        self.assertEqual(result["worktrees"]["kept"], [{"key": "a", "reason": "lane is working"}])
        self.assertEqual(result["worktrees"]["removed"], [{"key": "b", "reason": "PR acme/app#2 merged 4 days ago", "evidence": "https://github.com/acme/app/pull/2"}])
        self.assertIn("worktrees_removed=1 worktrees_kept=1 ", HK["summary"](result))
        import io
        from contextlib import redirect_stdout
        followups = runpy.run_path(str(ROOT / "scripts/helio-followups.py"))
        followups["daily_upkeep"].__globals__["run"] = lambda args: "[]"
        output = io.StringIO()
        with redirect_stdout(output):
            followups["daily_upkeep"]({**HK, "run": lambda *args: result})
        self.assertIn("FOLLOWUP_HOUSEKEEPING", output.getvalue())
        self.assertIn('read="helio housekeeping --last"', output.getvalue())

class Preview(Fixture):
    def seed_everything(self):
        RetentionRules.seed(self)
        Sessions.session(self, "old", 40)
        logs = self.home / ".local/share/helio-chrome"
        logs.mkdir(parents=True)
        (logs / "helio-browser.log").write_bytes(b"x" * (HK["LOG_MAX_BYTES"] + 1))
        (logs / "helio-browser.log.2").write_text("oldest")
        backups = self.home / ".dori/elobot/backups"
        backups.mkdir(parents=True)
        for offset in range(1, 20):
            (backups / f"daily-{time.strftime('%Y%m%d', time.gmtime(NOW - offset * DAY))}.tar.gz").write_text("x")

    def test_an_unapproved_first_run_changes_nothing_but_its_report(self):
        self.seed_everything()
        before = self.snapshot()
        result = self.housekeeping()
        self.assertEqual(result["mode"], "dry-run")
        self.assertTrue(result["logs_to_rotate"] and result["sessions"]["archived"])
        self.assertEqual(self.snapshot(), before)

    def test_an_explicit_preview_changes_nothing_after_approval(self):
        self.seed_everything()
        (self.state / "housekeeping-approved").write_text("approved")
        before = self.snapshot()
        self.assertEqual(self.housekeeping(preview=True)["mode"], "dry-run")
        self.assertEqual(self.snapshot(), before)


class Sessions(Fixture):
    def session(self, name, age_days):
        project = self.home / ".omo/agent/sessions/--proj--"
        project.mkdir(parents=True, exist_ok=True)
        path = project / f"2026-01-01T00-00-00-000Z_{name}.jsonl"
        path.write_text(json.dumps({"type": "session", "id": name}) + "\n")
        (project / f"{path.stem}-artifacts").mkdir()
        os.utime(path, (NOW - age_days * DAY, NOW - age_days * DAY))
        return path

    def test_old_inactive_sessions_are_archived_and_lane_and_lead_sessions_kept(self):
        old = self.session("old", 40)
        lane = self.session("lane", 40)
        lead = self.session("lead", 40)
        recent = self.session("recent", 2)
        (self.state / "lanes").mkdir()
        (self.state / "lanes/worker.json").write_text(json.dumps({"key": "worker", "status": "hibernated", "session": "lane"}))
        (self.state / "helio-lead-sessions.json").write_text(json.dumps([{"id": "lead", "project": "/p"}]))
        result = self.housekeeping(approve=True)
        self.assertEqual(result["sessions"], {"archived": 1, "deleted": 0})
        self.assertFalse(old.exists())
        archived = self.home / ".omo/agent/sessions-archive/--proj--" / f"{old.name}.gz"
        self.assertEqual(json.loads(gzip.decompress(archived.read_bytes()))["id"], "old")
        self.assertTrue((archived.parent / f"{old.stem}-artifacts").is_dir())
        self.assertTrue(all(path.exists() for path in (lane, lead, recent)))
        index = [json.loads(line) for line in (archived.parent.parent / "index.jsonl").read_text().splitlines()]
        self.assertEqual([entry["session"] for entry in index], ["old"])

    def test_archive_age_counts_from_last_activity_and_the_index_forgets_deleted_archives(self):
        ancient, month = self.session("ancient", 200), self.session("month", 40)
        archive = self.home / ".omo/agent/sessions-archive"
        packed = lambda path: archive / "--proj--" / f"{path.name}.gz"
        indexed = lambda: [json.loads(line)["session"] for line in (archive / "index.jsonl").read_text().splitlines()]
        self.housekeeping(approve=True)
        self.assertEqual([packed(ancient).exists(), packed(month).exists()], [False, True])
        self.assertFalse((archive / "--proj--" / f"{ancient.stem}-artifacts").exists())
        self.assertEqual(indexed(), ["month"])
        HK["run"](self.state, self.home, NOW + 141 * DAY, [str(self.dori)], approve=True)
        self.assertEqual([packed(month).exists(), indexed()], [False, []])

    def test_a_session_opened_while_housekeeping_runs_is_never_archived(self):
        old = self.session("old", 40)
        scan = HK["sessions"].__globals__["_protected_sessions"]

        def opened_after_scan(state, sessions):
            keep = scan(state, sessions)
            holders = old.parent / "session-holders" / "old"
            holders.mkdir(parents=True, exist_ok=True)
            (holders / f"{os.getpid()}.json").write_text(json.dumps({"pid": os.getpid()}))
            return keep
        HK["sessions"].__globals__["_protected_sessions"] = opened_after_scan
        try:
            result = self.housekeeping(approve=True)
        finally:
            HK["sessions"].__globals__["_protected_sessions"] = scan
        self.assertEqual(result["sessions"]["archived"], 0)
        self.assertTrue(old.exists())
        self.assertFalse((old.parent / "session-holders/old/move.lock").exists())

    def test_a_session_being_moved_by_omo_is_skipped(self):
        old = self.session("old", 40)
        holders = old.parent / "session-holders" / "old"
        holders.mkdir(parents=True)
        (holders / "move.lock").write_text(json.dumps({"pid": os.getpid()}))
        self.assertEqual(self.housekeeping(approve=True)["sessions"]["archived"], 0)
        self.assertTrue(old.exists())

    def test_the_archive_index_names_the_lane_and_job_of_a_closed_lane(self):
        self.session("closed", 40)
        (self.state / "lanes").mkdir()
        (self.state / "lanes/fix.json").write_text(json.dumps({"key": "fix", "job": "issue-8", "closedAt": "x", "session": "closed"}))
        self.housekeeping(approve=True)
        index = [json.loads(line) for line in (self.home / ".omo/agent/sessions-archive/index.jsonl").read_text().splitlines()]
        self.assertEqual([(entry["session"], entry["lane"], entry["job"]) for entry in index], [("closed", "fix", "issue-8")])

    def test_a_session_a_lane_starts_using_after_the_scan_is_never_archived(self):
        old = self.session("old", 40)
        scan = HK["sessions"].__globals__["_protected_sessions"]

        def resumed_after_scan(state, sessions):
            keep = scan(state, sessions)
            (state / "lanes").mkdir(exist_ok=True)
            (state / "lanes/worker.json").write_text(json.dumps({"key": "worker", "status": "working", "session": "old"}))
            return keep
        HK["sessions"].__globals__["_protected_sessions"] = resumed_after_scan
        try:
            result = self.housekeeping(approve=True)
        finally:
            HK["sessions"].__globals__["_protected_sessions"] = scan
        self.assertEqual(result["sessions"]["archived"], 0)
        self.assertTrue(old.exists())

    def test_the_archive_index_finds_closed_lanes_in_the_lane_archive(self):
        self.session("closed", 40)
        (self.state / "lanes/archive").mkdir(parents=True)
        (self.state / "lanes/archive/fix.json").write_text(json.dumps({"key": "fix", "job": "issue-8", "closedAt": "x", "session": "closed"}))
        self.housekeeping(approve=True)
        index = [json.loads(line) for line in (self.home / ".omo/agent/sessions-archive/index.jsonl").read_text().splitlines()]
        self.assertEqual([(entry["lane"], entry["job"]) for entry in index], [("fix", "issue-8")])

    def test_lead_registry_drops_archived_sessions_but_keeps_the_newest_five(self):
        self.session("gone", 40)
        records = [{"id": "gone", "project": "/p"}] + [{"id": f"new{i}", "project": "/p"} for i in range(5)]
        (self.state / "helio-lead-sessions.json").write_text(json.dumps(records))
        self.housekeeping(approve=True)
        kept = json.loads((self.state / "helio-lead-sessions.json").read_text())
        self.assertEqual([record["id"] for record in kept], [f"new{i}" for i in range(5)])


class Logs(Fixture):
    def test_an_oversized_log_rotates_keeping_two_generations_while_its_writer_keeps_appending(self):
        logs = self.home / ".local/share/helio-chrome"
        logs.mkdir(parents=True)
        log = logs / "helio-browser.log"
        (logs / "helio-browser.log.1").write_text("older")
        (logs / "helio-browser.log.2").write_text("oldest")
        # Chrome keeps the descriptor helio-browser.py opened in append mode for its whole life.
        writer = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self.addCleanup(os.close, writer)
        os.write(writer, b"x" * (HK["LOG_MAX_BYTES"] + 1))
        self.assertEqual(self.housekeeping(approve=True)["logs_rotated"], ["helio-browser.log"])
        os.write(writer, b"after rotation\n")
        self.assertEqual(log.read_bytes(), b"after rotation\n")
        self.assertEqual((logs / "helio-browser.log.2").read_text(), "older")
        self.assertEqual((logs / "helio-browser.log.1").stat().st_size, HK["LOG_MAX_BYTES"] + 1)


class Backups(Fixture):
    def test_daily_backup_restores_state_and_memory_and_omits_worktrees(self):
        memory = self.home / HK["MEMORY_REPO"]
        memory.mkdir(parents=True)
        git = lambda *args: subprocess.run(["git", "-C", str(memory), *args], check=True, capture_output=True, text=True)
        git("init")
        git("-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "--allow-empty", "-m", "note")
        head = git("rev-parse", "HEAD").stdout.strip()
        (self.state / "worktrees/lane").mkdir(parents=True)
        (self.state / "worktrees/lane/file").write_text("checkout")
        name = self.housekeeping(approve=True)["backup"]
        restored = Path(self.tmp.name) / "restored"
        with tarfile.open(self.home / ".dori/elobot/backups" / name) as tar:
            tar.extractall(restored, filter="data")
        with closing(sqlite3.connect(restored / "state/discord-delivery.sqlite")) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertFalse((restored / "state/worktrees").exists())
        clone = Path(self.tmp.name) / "clone"
        subprocess.run(["git", "clone", "-q", str(restored / "memory.bundle"), str(clone)], check=True, capture_output=True)
        self.assertEqual(subprocess.run(["git", "-C", str(clone), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(), head)

    def test_rotation_keeps_seven_days_and_four_weekly_backups(self):
        root = self.home / ".dori/elobot/backups"
        root.mkdir(parents=True)
        for offset in range(1, 60):
            day = time.gmtime(NOW - offset * DAY)
            (root / f"daily-{time.strftime('%Y%m%d', day)}.tar.gz").write_text("x")
        self.housekeeping(approve=True)
        kept = sorted(path.name for path in root.glob("daily-*.tar.gz"))
        self.assertEqual(kept, [
            "daily-20261220.tar.gz", "daily-20261227.tar.gz", "daily-20270103.tar.gz", "daily-20270109.tar.gz",
            "daily-20270110.tar.gz", "daily-20270111.tar.gz", "daily-20270112.tar.gz", "daily-20270113.tar.gz",
            "daily-20270114.tar.gz", "daily-20270115.tar.gz",
        ])


class Scheduling(Fixture):
    def test_housekeeping_runs_once_a_day(self):
        self.assertTrue(HK["due"](self.state, NOW))
        self.housekeeping()
        self.assertFalse(HK["due"](self.state, NOW + DAY - 1))
        self.assertTrue(HK["due"](self.state, NOW + DAY))

    def test_a_worktree_kept_for_an_open_pr_is_reaped_again_within_hours(self):
        """2026-11-14: health still said "PR #20 is OPEN" the day after it merged, from the daily snapshot."""
        last = self.state / "housekeeping-last.json"
        original = {"at": NOW, "mode": "applied", "worktrees": {"kept": [
            {"key": "issue19", "reason": "PR o/r#20 is OPEN"}]}, "backup": "kept"}
        merged = [sys.executable, "-c", 'import json; print(json.dumps([{"key": "issue19", "path": "/w", '
                  '"action": "removed", "reason": "PR o/r#20 is MERGED"}]))']
        for at, after_merge in ((NOW + 6 * 3600, False), (NOW + 1, True)):
            with self.subTest(after_merge=after_merge):
                last.write_text(json.dumps(original))
                self.assertIsNone(HK["refresh_worktrees"](self.state, NOW, merged))
                refreshed = HK["refresh_worktrees"](self.state, at, merged, after_merge=after_merge)
                self.assertEqual(refreshed["removed"], [{"key": "issue19", "reason": "PR o/r#20 is MERGED"}])
                report = json.loads(last.read_text())
                self.assertEqual((report["at"], report["backup"], report["worktrees_at"]), (NOW, "kept", int(at)))
                self.assertIsNone(HK["refresh_worktrees"](self.state, NOW + 30 * 3600, merged))


if __name__ == "__main__":
    unittest.main()
