"""Readiness observation never repeats a restart or overstates login evidence."""
import runpy
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

M = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_release_client.py"))


class ReadinessTests(unittest.TestCase):
    def test_restart_json_reconciles_later_login_with_immediate_inspection(self):
        observed = {"login_evidence": "observed", "login_observed_at": "2026-11-05T12:01:00Z",
                    "gateway_health": "connected", "observed_at": "2026-11-05T12:02:00Z"}
        immediate = {"status": "restarted", "bot_login_verified": False, "invocation": "run1"}
        out = io.StringIO()
        with patch.dict(M["main"].__globals__, {
            "exchange": lambda *a, **k: dict(immediate),
            "observe": lambda *a, **k: {"readiness": "login_observed", "observation": observed},
        }), patch.object(sys, "argv", ["helio", "restart", "--channel", "12345", "--message", "23456",
                                      "--revision", "a" * 40]), redirect_stdout(out):
            code = M["main"]()
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue().split("\n", 1)[1])
        self.assertTrue(result["bot_login_verified"])
        for key in ("login_observed_at", "gateway_health", "observed_at"):
            self.assertEqual(result[key], observed[key])

    def test_status_reports_gateway_evidence_at_observation_time(self):
        for health, expected in (
            ("connected", "gateway connection open at 2026-11-05T12:02:00Z"),
            ("no_connection", "no gateway connection observed at 2026-11-05T12:02:00Z"),
            ("unavailable", "gateway health unverified"),
        ):
            with self.subTest(health=health):
                text = M["describe"]({"active": True, "gateway_health": health, "observed_at": "2026-11-05T12:02:00Z"})
                self.assertTrue(text.endswith(expected), text)

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
