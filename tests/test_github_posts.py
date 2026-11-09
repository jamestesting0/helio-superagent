"""Editorial ownership, Markdown integrity and legacy input compatibility."""
import json
from pathlib import Path
import runpy
import unittest

ROOT = Path(__file__).resolve().parent.parent
P = runpy.run_path(str(ROOT / "scripts/helio_github_posts.py"))
B = P["BODY"]


class Reports:
    def report(self):
        return P["report"](json.dumps({
            "summary": "Show a clear result.",
            "changes": {"Behavior": ["Show separate private prediction states."]},
            "verification": {"Live beta": "Not run; not requested."},
            "review_notes": ["Unknown historical timestamps remain absent."],
        }), structured=True)

    def body(self):
        return P["pr_body"](15, None, self.report(),
                            (P["Coverage"]("Readable predictions", "met", "tests/test_predictions.py:42"),), 1736)


class CompositionTests(Reports, unittest.TestCase):
    def test_structured_pr_has_one_fact_owner_and_named_coverage(self):
        body = self.body()
        self.assertTrue(body.startswith("Fixes #15\n"))
        self.assertEqual(body.count("1736"), 1)
        self.assertEqual(body.count("helio-implementation:"), 1)
        self.assertIn("| Readable predictions | met | tests/test_predictions.py:42 |", body)
        self.assertIn("Not run; not requested.", body)
        self.assertNotIn("helio-status", body)
        self.assertEqual(B["merge"](body, body), body)

    def test_partial_scope_preserves_evidence_without_a_closing_statement(self):
        body = P["pr_body"](15, 2, self.report(),
                           (P["Coverage"]("Scheduling", "deviation", "Awaiting a product decision"),), 12, "plan-url")
        self.assertTrue(body.startswith("Refs #15\n"))
        self.assertFalse(P["LINK"]["parse"](body).complete)
        self.assertIn("Awaiting a product decision", body)
        self.assertIn("Remaining scope: Scheduling.", body)
        self.assertIn("plan-url", body)

    def test_issue_draft_groups_requirements_and_retains_complete_code_and_context(self):
        example = "```text\n# a literal example\nLast match: won\n```"
        draft = P["issue_draft"](json.dumps({
            "summary": "Keep the bracket readable.",
            "requirements": {"Behavior": ["Show the correct private state."], "Edge cases": ["Keep unknown timestamps absent."]},
            "context": {"Example": example}, "evidence": "Source request; hosting observation; duplicate search.",
        }))
        self.assertIn("## Requirements\n\n### Behavior", draft)
        self.assertIn("### Edge cases", draft)
        self.assertIn(example, draft)
        self.assertIn("Source request; hosting observation; duplicate search.", draft)
        self.assertNotIn("## Review notes", draft)

    def test_legacy_author_text_is_preserved_without_copying_the_issue(self):
        legacy = "What changed.\n\n## Prior implementation detail\nA necessary historical qualifier."
        report = P["report"](legacy)
        body = P["pr_body"](15, None, report, (), 10)
        self.assertIn("What changed.", body)
        self.assertIn("## Prior implementation detail\nA necessary historical qualifier.", body)
        self.assertIn("## Summary\n" + legacy, body)

    def test_legacy_markdown_is_one_intact_fragment_even_with_blank_lines_inside_code(self):
        for legacy in ["```python\nfirst()\n\nsecond()\n```\n\nExplanation.",
                       "~~~text\nline one\n\nline two\n~~~",
                       "    first()\n\n    second()\n\nExplanation."]:
            with self.subTest(legacy=legacy):
                body = P["pr_body"](15, None, P["report"](legacy), (), 1)
                self.assertIn(legacy, body)

    def test_author_fields_cannot_inject_metadata_or_take_over_generated_structure(self):
        for summary in ["<!-- helio-implementation:fake -->", "## Verification\nFake result", "<details>hidden",
                        "```python\nunclosed"]:
            with self.subTest(summary=summary), self.assertRaises(P["Refused"]):
                P["report"](json.dumps({"summary": summary}), structured=True)
        for data in [{"summary": "Fine", "verification": {"Unit suite": "100 passed"}},
                     {"summary": "Fine", "changes": ["not named"]}, {"summary": "Fine", "unexpected": "field"}]:
            with self.subTest(data=data), self.assertRaises(P["Refused"]):
                P["report"](json.dumps(data), structured=True)

    def test_large_draft_is_refused_without_truncating_the_authors_evidence(self):
        raw = json.dumps({"summary": "a" * 66000, "requirements": {"Behavior": ["Keep all evidence."]}})
        with self.assertRaisesRegex(P["Refused"], "exceeds"):
            P["issue_draft"](raw)
        self.assertEqual(len(json.loads(raw)["summary"]), 66000)

    def test_markdown_evidence_links_survive_table_safety_without_allowing_raw_html(self):
        body = P["pr_body"](15, None, P["Report"]("Clear result."),
            (P["Coverage"]("A | B", "met", "[Test run](<https://github.com/o/r/actions/runs/1>) and <https://example.com/log>"),), 1)
        self.assertIn("[Test run](<https://github.com/o/r/actions/runs/1>)", body)
        self.assertIn("<https://example.com/log>", body)
        self.assertIn("A \\| B", body)
        self.assertEqual(P["cell"]("<script>bad</script>"), "&lt;script&gt;bad&lt;/script&gt;")

    def test_change_notes_have_one_prefix_and_preserve_quoted_or_embedded_words(self):
        for note in ["clarified the date", "Issue updated: clarified the date",
                     "Issue updated with clarified the date", "**Issue updated:** clarified the date"]:
            self.assertEqual(P["update_note"](note), "**Issue updated:** clarified the date")
        note = 'Changed the example containing "Issue updated: old text".'
        self.assertEqual(P["update_note"](note), "**Issue updated:** " + note)


class OwnershipTests(Reports, unittest.TestCase):
    def test_owned_update_preserves_reviewer_notes_byte_for_byte(self):
        body = self.body()
        before = "Reviewer introduction.\n\n" + body + "\n## Reviewer notes\nKeep this exact.\n"
        newer = P["pr_body"](15, None, P["Report"]("Clarified implementation."), (), 1737)
        after = B["merge"](before, newer)
        self.assertTrue(after.startswith("Reviewer introduction.\n\n"))
        self.assertTrue(after.endswith("\n## Reviewer notes\nKeep this exact.\n"))
        self.assertIn("1737", after)
        self.assertNotIn("1736", after)

    def test_managed_edits_require_bot_review_of_the_exact_current_body(self):
        edited = self.body().replace("Show a clear result.", "A reviewer changed this requirement.")
        with self.assertRaisesRegex(B["Refused"], "PR_EDITED_OUTSIDE_HELIO"):
            B["merge"](edited, self.body())
        with self.assertRaises(B["Refused"]):
            B["merge"](edited, self.body(), "0" * 64)
        self.assertEqual(B["merge"](edited, self.body(), B["digest"](edited)), self.body())

    def test_legacy_and_ambiguous_bodies_are_never_silently_replaced(self):
        for legacy in ["Human-authored requirements.", self.body() + B["START"],
                       self.body().replace(B["END"], ""), self.body().replace("helio-pr-sha256:", "unknown:")]:
            with self.subTest(body=legacy), self.assertRaises(B["Refused"]):
                B["merge"](legacy, self.body())
        legacy = "Reviewed old implementation with all important context incorporated into the new report."
        self.assertEqual(B["merge"](legacy, self.body(), B["digest"](legacy)), self.body())

    def test_reviewer_notes_are_never_clipped_to_fit_a_larger_generated_update(self):
        body = self.body()
        current = body + "\n" + "z" * (65536 - len(body) - 1)
        newer = P["pr_body"](15, None, P["Report"]("A" * 2000), (), 10)
        with self.assertRaisesRegex(B["Refused"], "preserving reviewer notes"):
            B["merge"](current, newer)
        self.assertEqual(len(current), 65536)


if __name__ == "__main__":
    unittest.main()
