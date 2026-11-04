"""Readiness observation never repeats a restart or overstates login evidence."""
import runpy
import unittest
from pathlib import Path

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_release_client.py"))


class ReadinessTests(unittest.TestCase):
    def test_delayed_login_uses_only_readonly_requests(self):
        calls = []
        elapsed = [0]

        def exchange(request, **kwargs):
            calls.append(request)
            return {"invocation": "run1", "active": True, "phase": "running",
                    "login_evidence": "observed" if elapsed[0] >= 80 else "absent"}

        result = M["observe"]("run1", exchange_fn=exchange, clock=lambda: elapsed[0],
                              sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        self.assertEqual(result["readiness"], "login_observed")
        self.assertEqual(elapsed[0], 80)
        self.assertEqual(calls, [{"action": "inspect"}] * 9)

    def test_timeout_keeps_readiness_unverified(self):
        elapsed = [0]
        result = M["observe"]("run1", 20,
                              exchange_fn=lambda *a, **k: {"invocation": "run1", "active": True, "login_evidence": "absent"},
                              clock=lambda: elapsed[0],
                              sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
        self.assertEqual(result["readiness"], "unverified")
        self.assertEqual(elapsed[0], 20)

    def test_changed_invocation_stops_observing_approved_run(self):
        result = M["observe"]("run1", exchange_fn=lambda *a, **k: {
            "invocation": "run2", "active": True, "login_evidence": "observed"})
        self.assertEqual(result["readiness"], "invocation_changed")

    def test_status_does_not_call_checkout_the_running_revision(self):
        text = M["describe"]({"head": "a" * 40, "active": True, "login_evidence": "observed"})
        self.assertIn("running revision unverified", text)
        self.assertIn("gateway health unverified", text)


if __name__ == "__main__":
    unittest.main()
