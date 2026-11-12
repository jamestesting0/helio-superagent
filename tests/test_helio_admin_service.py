"""The owner-peer broker never turns a forged or revoked actor into authority."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
from dataclasses import replace
import json
import os
from pathlib import Path
import runpy
import stat
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
M = runpy.run_path(str(ROOT / "scripts/helio_admin_service.py"))
C = runpy.run_path(str(ROOT / "scripts/helio_config.py"))


class AdminServiceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "owner"
        source = C["config_path"](self.home)
        source.parent.mkdir(parents=True)
        self.values = {"DORI_DISCORD_TOKEN": "private", "BOT_BETA_TOKEN": "beta", "COC_API_PASSWORD": "coc",
                       "HELPER_API_KEY": "helper", "HELIO_BETA_MONGO_URL": "mongodb://beta",
                       "HELIO_TRUSTED_USERS": "11111"}
        self.save()
        settings = M["Settings"](self.home, self.root / "isolated", self.root / "policy",
                                 self.root / "state", os.getuid(), os.getgid(), 999, 999)
        self.service = M["AdminService"](settings)

    def save(self):
        source = C["config_path"](self.home)
        source.write_text("".join(f"{key}={value}\n" for key, value in self.values.items()))
        source.chmod(0o600)

    def test_policy_protocol_never_returns_the_owner_credentials(self):
        response = self.service.perform({"kind": "policy"})
        self.assertEqual(response["values"]["HELIO_TRUSTED_USERS"], "11111")
        for secret in ("private", "mongodb://beta", "DORI_DISCORD_TOKEN", "BOT_BETA_TOKEN"):
            self.assertNotIn(secret, json.dumps(response))

    def test_an_untrusted_actor_never_reaches_the_runtime_bridge(self):
        with patch.object(self.service, "run_runtime", side_effect=AssertionError("Untrusted runtime call")):
            with self.assertRaises(M["Refused"]) as refusal:
                self.service.perform({"kind": "runtime", "actor": "22222", "operation": "one",
                                      "guild": "1033924790513311756",
                                      "query": {"kind": "read", "section": "conversations", "filters": {}}})
        self.assertEqual(refusal.exception.code, "denied")
        self.assertFalse((self.root / "policy/requests").exists())

    def test_trusted_membership_is_rechecked_before_replaying_a_saved_operation(self):
        request = {"kind": "runtime", "actor": "11111", "operation": "same",
                   "guild": "1033924790513311756",
                   "query": {"kind": "mutate", "action": "blocks.add", "target": "22222", "expected": "", "input": {"reason": "Spam"}}}
        with patch.object(self.service, "run_runtime", return_value={"records": [], "notice": "Blocked"}) as runtime:
            self.service.perform(request)
            self.values["HELIO_TRUSTED_USERS"] = ""
            self.save()
            with self.assertRaises(M["Refused"]) as refusal:
                self.service.perform(request)
        self.assertEqual(refusal.exception.code, "denied")
        self.assertEqual(runtime.call_count, 1)

    def test_trusted_users_cannot_write_owner_configuration(self):
        with patch.object(self.service, "configure", side_effect=AssertionError("Owner operation reached")):
            with self.assertRaises(M["Refused"]) as refusal:
                self.service.perform({"kind": "configure", "actor": "11111", "operation": "grant",
                                      "action": "trusted.add", "target": "22222", "value": "", "expected": "a" * 64})
        self.assertEqual(refusal.exception.code, "denied")

    def test_duplicate_mutation_returns_its_receipt_without_reapplying(self):
        request = {"kind": "runtime", "actor": "11111", "operation": "same",
                   "guild": "1033924790513311756",
                   "query": {"kind": "mutate", "action": "blocks.add", "target": "22222", "expected": "", "input": {"reason": "Spam"}}}
        with patch.object(self.service, "run_runtime", return_value={"records": [], "notice": "Blocked"}) as runtime:
            first = self.service.perform(request)
            second = self.service.perform(request)
        self.assertEqual(first, second)
        self.assertEqual(runtime.call_count, 1)
        self.assertEqual(list((self.root / "policy/requests").iterdir()), [])

    def test_lost_configuration_response_recovers_the_canonical_receipt_after_restart(self):
        policy = self.service.policy()
        actor = policy["values"]["DORI_DISCORD_OWNER_ID"]
        request = {"kind": "configure", "actor": actor, "operation": "lost-response",
                   "expected": policy["revision"], "action": "trusted.add", "target": "33333", "value": ""}

        def committed_then_lost(body, current):
            C["change"](self.home, body["operation"], actor, body["expected"],
                        body["action"], body["target"], body["value"])
            raise OSError("Response lost after the canonical commit")

        with patch.object(self.service, "configure", side_effect=committed_then_lost):
            with self.assertRaises(M["Refused"]) as refusal:
                self.service.perform(request)
        self.assertEqual(refusal.exception.code, "uncertain")
        restarted = M["AdminService"](self.service.settings)
        audit = {"kind": "runtime", "actor": actor, "operation": "inspect", "guild": policy["values"]["HELIO_ADMIN_GUILD"],
                 "query": {"kind": "read", "section": "audit", "filters": {}}}
        with patch.object(restarted, "run_runtime", side_effect=lambda nonce: {"records": []}):
            listed = restarted.perform(audit)
            self.assertEqual([(row["id"], row["state"]) for row in listed["records"]],
                             [("owner-operation-lost-response", "uncertain")])
            audit["query"]["target"] = "owner-operation-lost-response"
            inspected = restarted.perform(audit)
            self.assertEqual(inspected["records"][0]["state"], "done")
        recovered = restarted.perform({"kind": "operation", "actor": actor, "operation": "lost-response"})
        self.assertEqual(recovered["status"], "done")
        self.assertEqual(recovered["result"]["operation"], "lost-response")
        with patch.object(restarted, "configure", side_effect=AssertionError("Committed configuration was resubmitted")):
            self.assertEqual(restarted.perform(request), recovered["result"])
        self.assertEqual(C["load"](self.home)["HELIO_TRUSTED_USERS"].split(",").count("33333"), 1)

    def test_pending_audit_redacts_a_runtime_target_until_current_visibility_is_verified(self):
        target = "55555:33333:77777:1000"
        request = {"kind": "runtime", "actor": "11111", "operation": "hidden-target",
                   "guild": "1033924790513311756",
                   "query": {"kind": "mutate", "action": "conversations.hold", "target": target,
                             "expected": "0", "input": {"reason": "A pending request"}}}
        with patch.object(self.service, "run_runtime", side_effect=M["Refused"]("uncertain", "Response lost")):
            with self.assertRaises(M["Refused"]):
                self.service.perform(request)
        audit = {"kind": "runtime", "actor": "11111", "operation": "inspect", "guild": "1033924790513311756",
                 "query": {"kind": "read", "section": "audit", "filters": {}}}
        with patch.object(self.service, "run_runtime", return_value={"records": []}):
            self.assertNotIn(target, json.dumps(self.service.perform(audit)))

    def test_runtime_output_bound_does_not_limit_ordinary_database_file_sizes(self):
        path = self.root / "large-runtime-file"
        process = M["PROCESS"]
        result = process["run_bounded"]([sys.executable, "-c",
            "from pathlib import Path; import sys; Path(sys.argv[1]).write_bytes(b'x'*3000000); print('done')",
            str(path)])
        self.assertEqual(result, b"done\n")
        self.assertEqual(path.stat().st_size, 3_000_000)
        with self.assertRaisesRegex(process["RuntimeFailure"], "bounded result"):
            process["run_bounded"]([sys.executable, "-c", "print('x'*2100000)"])

    def test_runtime_bridge_ignores_bwrap_arguments_containing_the_launcher(self):
        launcher = b"/home/james/helio-agent/scripts/helio_isolated_start.py"
        scope = self.root / "cgroup.procs"
        scope.write_text("101\n102\n103\n")
        processes = self.root / "proc"
        for pid, argv in (("101", [b"bwrap", b"--", b"/usr/bin/python3", launcher]),
                          ("102", [b"bwrap", b"--", b"/usr/bin/python3", launcher]),
                          ("103", [b"/usr/bin/python3", launcher, b"start"])):
            directory = processes / pid
            directory.mkdir(parents=True)
            (directory / "cmdline").write_bytes(b"\0".join(argv) + b"\0")
        (processes / "103/result").write_text(json.dumps({"ok": True, "result": {"records": [
            {"id": "runtime", "title": "Actual runtime", "summary": "", "revision": "1"}]}}))
        self.service.settings = replace(self.service.settings, agent_uid=os.getuid())
        bounded = M["PROCESS"]["run_bounded"]

        def run_worker(command):
            target = processes / command[command.index("--target") + 1] / "result"
            return bounded([sys.executable, "-c",
                "from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text())", str(target)])

        def mapped_path(path):
            return scope if str(path).endswith("/cgroup.procs") else processes if str(path) == "/proc" else Path(path)

        with patch.dict(self.service.run_runtime.__globals__, {"Path": mapped_path}), \
                patch.dict(M["PROCESS"], {"run_bounded": run_worker}):
            self.assertEqual(self.service.run_runtime("proof")["records"][0]["id"], "runtime")

    def test_runtime_proof_directory_remains_traversable_under_the_service_umask(self):
        request = {"kind": "runtime", "actor": "11111", "operation": "read",
                   "guild": "1033924790513311756",
                   "query": {"kind": "read", "section": "overview", "filters": {}}}

        def inspect_proof(nonce):
            directory = self.service.settings.policy_dir / "requests"
            self.assertTrue(directory.stat().st_mode & stat.S_IXOTH,
                            "the isolated UID cannot traverse the root-owned proof directory")
            return {"records": [], "notice": json.loads((directory / f"{nonce}.json").read_text())["operation"]}

        previous = os.umask(0o077)
        try:
            with patch.object(self.service, "run_runtime", side_effect=inspect_proof):
                self.assertEqual(self.service.perform(request)["notice"], "read")
        finally:
            os.umask(previous)
