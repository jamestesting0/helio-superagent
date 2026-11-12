"""helio metrics reads a lane's transcripts and reports its submit window, ceremony and post-release wakes."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
T0 = 1_794_000_000


def stamp(seconds: float) -> str:
    import datetime
    return datetime.datetime.fromtimestamp(T0 + seconds, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def turn(at: float, call_id: str, name: str, arguments: dict) -> dict:
    return {"type": "message", "timestamp": stamp(at), "message": {
        "role": "assistant", "timing": {"requestedAt": (T0 + at) * 1000, "endedAt": (T0 + at + 2) * 1000},
        "content": [{"type": "toolCall", "id": call_id, "name": name, "arguments": arguments}]}}


def result(at: float, call_id: str, name: str, text: str) -> dict:
    return {"type": "message", "timestamp": stamp(at), "message": {
        "role": "toolResult", "toolCallId": call_id, "toolName": name, "timestamp": (T0 + at) * 1000,
        "content": [{"type": "text", "text": text}]}}


class SessionMetricsTests(unittest.TestCase):
    def test_a_lane_window_ends_at_the_successful_submit_and_counts_wakes_after_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            cwd = "/home/james/.dori/elobot/state/worktrees/issue9-example"
            lanes = home / ".dori/elobot/state/lanes"
            lanes.mkdir(parents=True)
            (lanes / "issue9-example.json").write_text(json.dumps({"key": "issue9-example", "job": "issue-9", "cwd": cwd,
                                                                   "openedAt": "2026-11-12T00:00:00Z", "profile": "direct"}))
            sessions = home / ".omo/agent/sessions" / ("-" + cwd.replace("/", "-") + "--")
            sessions.mkdir(parents=True)
            events = [
                {"type": "session", "timestamp": stamp(0)},
                turn(1, "a1", "todo", {"op": "init"}), result(4, "a1", "todo", "ok"),
                turn(5, "a2", "read", {"path": "/home/james/.dori/elobot/docs/lead-turns.md"}), result(6, "a2", "read", "x" * 1000),
                turn(6, "a5", "eval", {"code": "helio pr check --issue 9"}),
                result(7, "a5", "eval", "PR_OPEN previous PLAN_PR https://github.com/o/r/pull/3 Output truncated"),
                turn(7, "a6", "eval", {"code": "helio pr submit --issue 9 --result-file r --report-file p"}),
                result(7.5, "a6", "eval", "PLAN_REFUSED closing-issue links disagree"),
                turn(8, "a3", "eval", {"code": "helio pr submit --issue 9 --result-file r --report-file p > /tmp/submit.log"}),
                result(9, "a3", "eval", "Command running in background with ID: bash_7"),
                turn(20, "a8", "bash_output", {"bash_id": "bash_70"}),
                result(21, "a8", "bash_output", "PLAN_PR https://github.com/o/r/pull/4 from an older run"),
                turn(22, "a9", "eval", {"code": "tail /tmp/submit.log.old"}),
                result(23, "a9", "eval", "PLAN_PR https://github.com/o/r/pull/5"),
                turn(59, "a7", "bash_output", {"bash_id": "bash_7"}),
                result(60, "a7", "bash_output", "status: completed exit_code: 0\nPLAN_PR https://github.com/o/r/pull/10 verification=v"),
                {"type": "custom_message", "customType": "goal-continuation", "timestamp": stamp(100), "content": "continue"},
                turn(110, "a4", "eval", {"code": "await tool.monitor({description: 'Phase check', command: 'helio pr phase check --issue 9 --generation 1', filter: '^PHASE'})"}),
                result(111, "a4", "eval", "Monitor started"),
                {"type": "custom_message", "customType": "senpi-monitor:notification", "timestamp": stamp(120),
                 "content": "Monitor event(Phase check): PHASE_HANDED_OFF issue=9 generation=1 receipt=r"},
                {"type": "custom_message", "customType": "goal-continuation", "timestamp": stamp(400), "content": "continue"},
            ]
            (sessions / "2026-11-12_s1.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
            lead = home / ".omo/agent/sessions" / ("-" + str(home / "PythonProjects/elo-bot").replace("/", "-") + "--")
            lead.mkdir(parents=True)
            (lead / "2026-11-12_lead.jsonl").write_text("".join(json.dumps(event) + "\n" for event in (
                turn(1, "l1", "read", {"path": "/home/james/.dori/elobot/docs/questions.md"}), result(2, "l1", "read", "q" * 2400))))
            output = subprocess.run([sys.executable, str(ROOT / "scripts/helio_session_metrics.py"), "--home", str(home), "--json"],
                                    capture_output=True, text=True, check=True).stdout
        report = json.loads(output)
        lane = report["lanes"]["issue9-example"]
        self.assertEqual(report["lead"], {"2026-11-12_lead.jsonl": {"runbook_reads": 1, "characters": 2400, "characters_per_read": 2400}})
        self.assertEqual({key: lane[key] for key in ("status", "minutes_to_submit", "active_minutes", "round_trips",
                                                     "ceremony_share_pct", "instruction_kchars", "bookkeeping_trips",
                                                     "goal_continuations", "wakes_after_release", "profile")},
                         {"status": "submitted", "minutes_to_submit": 1.0, "active_minutes": 1.0, "round_trips": 8,
                          "ceremony_share_pct": 25, "instruction_kchars": 1, "bookkeeping_trips": 1,
                          "goal_continuations": 2, "wakes_after_release": 1, "profile": "direct"})
        self.assertEqual((lane["closing_link_refusals"], lane["truncated_by"]), (1, {"helio pr check --issue 9": 1}))


if __name__ == "__main__":
    unittest.main()
