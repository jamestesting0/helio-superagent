import runpy
import unittest
from pathlib import Path

P = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_deploy_plan.py"))


class DeployPlanTests(unittest.TestCase):
    def needs(self, kit=(), installed=(), env=False):
        return P["plan"](list(kit), list(installed), env)

    def test_tools_docs_and_tests_need_nothing(self):
        result = self.needs(["scripts/helio-triage.py", "docs/workflow.md", "tests/test_x.py", "isolation/README.md"],
                            ["@inbound/turns.test.ts", "@inbound/fixtures/discord.ts", "ack", "reply.ts", "@launcher"])
        self.assertEqual((result["needs"], result["monitors_changed"]), ("none", False))

    def test_monitor_code_restarts_monitors_only(self):
        helpers = ["helio_housekeeping.py", "helio_retention.py", "helio_state_backup.py", "helio_observations.py", "helio_decision_upkeep.py", "helio_issue_sync.py"]
        cases = [(["scripts/" + name], []) for name in helpers]
        for kit, installed in cases + [(["scripts/helio-followups.py"], []), ([], ["@inbound/inbound.ts"]), ([], ["context"])]:
            with self.subTest(kit=kit, installed=installed):
                result = self.needs(kit, installed)
                self.assertEqual((result["needs"], result["monitors_changed"]), ("monitors", True))

    def test_owner_administration_changes_are_distinct_from_shared_runtime_changes(self):
        for path, need, administration in (
            ("@inbound/admin/command-sync.ts", "none", True),
            ("@inbound/admin/controller.ts", "none", True),
            ("@inbound/admin/protocol.ts", "monitors", True),
            ("@inbound/admin/runtime-access.ts", "monitors", True),
            ("@inbound/admin/command-sync.test.ts", "none", False),
        ):
            with self.subTest(path=path):
                result = self.needs(installed=[path])
                self.assertEqual(result["needs"], need)
                self.assertEqual(result["admin_controller_changed"], administration)

    def test_instructions_settings_and_dori_need_a_lead_restart(self):
        for kit, installed, env in (([], ["work-policy.md"], False), ([], ["config.json"], False),
                                    (["vendor/dori-mode/scripts/src/cli.ts"], [], False), ([], [], True)):
            with self.subTest(kit=kit, installed=installed, env=env):
                self.assertEqual(self.needs(kit, installed, env)["needs"], "lead")
        self.assertTrue(self.needs(env=True)["monitors_changed"])

    def test_the_strongest_need_wins(self):
        self.assertEqual(self.needs(["scripts/helio_isolated_start.py", "docs/a.md"], ["work-policy.md"])["needs"], "full")
        self.assertEqual(self.needs([], ["@inbound/inbound.ts", "setup-prompt.md"])["needs"], "lead")

    def test_rsync_and_sync_output_parsing(self):
        itemized = ">f.st...... scripts/helio-triage.py\ncd+++++++++ newdir/\n*deleting   old/file.py\n.d..t...... scripts/\n>f+++++++++ docs/new.md\n"
        self.assertEqual(P["rsync_changes"](itemized), ["scripts/helio-triage.py", "old/file.py", "docs/new.md"])
        self.assertEqual(P["managed_changes"]("Update profile: isolated\nManaged updates: work-policy.md, @inbound/inbound.ts\n"),
                         ["work-policy.md", "@inbound/inbound.ts"])
        self.assertEqual(P["managed_changes"]("Managed updates: none\n"), [])


if __name__ == "__main__":
    unittest.main()
