"""Submit evidence survives publication uncertainty and cannot be rebound by prose."""
from __future__ import annotations
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH

import json
import runpy
import unittest
import argparse
import os
from pathlib import Path
from unittest.mock import patch

from plan_fixture import verified_suite
import test_pr_publication as fixtures

V = runpy.run_path(str(fixtures.ROOT / "scripts/helio_pr_verification.py"))


class VerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.task = fixtures.PublicationTests()
        self.addCleanup(self.task.doCleanups)
        self.task.setUp()

    def receipt(self, failed: bool = False) -> str:
        suite = verified_suite()
        suite["counts"]["failures"] = int(failed)
        return V["record"](self.task.store, {
            "issue": 7, "branch": "helio/autofix-7", "route": "request",
            "head": self.task.github.head, "base": "b" * 40,
            "authority": V["digest"](json.dumps(self.task.proof, sort_keys=True)),
            "authority_proof": self.task.proof,
            "scope": fixtures.M["digest"](self.task.github.issue["body"]),
            "job": "issue-7", "generation": None,
        }, suite)

    def publish(self, receipt: str) -> str:
        return fixtures.P["publish"](
            self.task.store, 7, "helio/autofix-7", self.task.github.head, self.task.body(),
            "Fix regression", self.task.proof, fixtures.M["digest"](self.task.github.issue["body"]),
            verification=receipt)

    def test_lost_publication_finalizes_the_original_verification_after_restart(self) -> None:
        receipt = self.receipt()
        with self.assertRaisesRegex(V["Refused"], "unpublished"):
            V["read"](self.task.store, receipt)
        self.task.github.lose_create = "after"
        with self.assertRaises(fixtures.P["Refused"]):
            self.publish(receipt)

        restarted = fixtures.M["Issues"]("o/r", self.task.state, command=self.task.github.command)
        restarted.publications(7)

        evidence = V["read"](restarted, receipt)
        self.assertEqual((evidence["context"]["head"], evidence["suite"]["counts"]["run"]),
                         (self.task.github.head, 5))
        self.assertEqual((self.task.github.creates, self.task.github.edits), (1, 0))
        with restarted.operations() as db:
            self.assertEqual(db.execute("SELECT completed FROM operations").fetchall(), [(1,)])

    def test_receipt_for_another_scope_cannot_authorize_a_publication_write(self) -> None:
        receipt = self.receipt()
        self.task.github.issue["body"] = "Different confirmed requirements"

        with self.assertRaisesRegex(fixtures.P["VERIFICATION"]["Refused"], "does not belong"):
            self.publish(receipt)

        self.assertEqual(self.task.github.creates, 0)

    def test_failed_suite_never_creates_successful_evidence(self) -> None:
        with self.assertRaisesRegex(V["Refused"], "full unit suite must pass"):
            self.receipt(failed=True)
        with self.task.store.operations() as db:
            self.assertEqual(db.execute("SELECT id FROM pr_verifications").fetchall(), [])

    def test_edited_receipt_cannot_be_read_as_published_verification(self) -> None:
        receipt = self.receipt()
        self.publish(receipt)
        with self.task.store.operations() as db:
            db.execute("UPDATE pr_verifications SET record='{}' WHERE id=?", (receipt,))

        with self.assertRaisesRegex(V["Refused"], "damaged"):
            V["read"](self.task.store, receipt)

    def test_autofix_receipt_names_the_base_actually_executed_when_main_moves(self) -> None:
        import test_helio_autofix as autofix
        auto = autofix.AutofixTests()
        auto.setUp()
        self.addCleanup(auto.doCleanups)
        module = runpy.run_path(str(fixtures.ROOT / "scripts/helio-autofix.py"))
        original = module["VERIFICATION"]["autofix_result"]
        proof = module["VERIFICATION"]["PROOF"]["proof"]
        git_run = proof.__globals__["_run"]
        captured = []
        def observed(argv, cwd):
            result = git_run(argv, cwd)
            if argv[:4] == ["git", "worktree", "add", "--detach"] and Path(argv[4]).name == "before":
                captured.append(auto.git("rev-parse", "HEAD", cwd=Path(argv[4])))
            return result
        def main_moves(*args, **kwargs):
            tree = auto.root / "new-main"
            auto.git("worktree", "add", "--detach", str(tree), "origin/main")
            (tree / "unrelated.py").write_text("constant = 1\n")
            auto.git("add", ".", cwd=tree)
            auto.git("commit", "-m", "unrelated main update", cwd=tree)
            auto.git("push", "origin", "HEAD:main", cwd=tree)
            auto.git("fetch", "origin", "main")
            return original(*args, **kwargs)
        (auto.root / "github.json").write_text(json.dumps(auto.data))
        args = argparse.Namespace(command="submit", issue=7, worktree=auto.project,
                                  summary_file=auto.summary, report_file=None, adopt_body=None)
        with patch.dict(os.environ, auto.env), patch.dict(proof.__globals__, {"_run": observed}), \
                patch.dict(module["VERIFICATION"], {"autofix_result": main_moves}):
            module["execute"](args)
        store = fixtures.M["Issues"]("o/r", auto.root / "state")
        with store.operations() as db:
            record = json.loads(db.execute("SELECT record FROM pr_verifications WHERE status='published'").fetchone()[0])
        self.assertEqual(record["context"]["base"], captured[0])
        self.assertNotEqual(captured[0], auto.git("rev-parse", "origin/main"))
