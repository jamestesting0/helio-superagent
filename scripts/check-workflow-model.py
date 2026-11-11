#!/usr/bin/env python3
"""No-tools semantic contract checks using rendered Helio instructions and Terra.

These check model decisions, not end-to-end execution. Installed CLI integration
tests independently exercise real Git/Discord delivery and authority boundaries.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import time


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--cases", type=Path, default=Path(__file__).resolve().parent.parent / "tests/workflow-contracts.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.source_root.resolve()
    payload = runpy.run_path(str(root / "scripts/helio_payload.py"))
    values = payload["values"](Path("/home/workflow-fixture"), "/home/workflow-fixture/project")
    documents = payload["documents"]("isolated", values)
    case_bytes = args.cases.read_bytes()
    cases = json.loads(case_bytes)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="helio-model-contract-") as temporary:
        home = Path(temporary)
        prompts = {}
        prompt_evidence = {}
        for role in ("lead", "worker"):
            sections = [documents["work-policy.md"].decode(),
                        (root / "vendor/dori-mode/SKILL.md").read_text(),
                        (root / "agent/skills/karpathy-guidelines/SKILL.md").read_text(),
                        documents["issue-plan-workflow.md"].decode(),
                        documents["issue-truth-workflow.md"].decode(),
                        documents["discord-qa-workflow.md"].decode()]
            if role == "lead":
                sections.append(documents["setup-prompt.md"].decode())
            prompts[role] = home / f"{role}.md"
            prompts[role].write_text("\n\n".join(sections))
            content = prompts[role].read_bytes()
            prompt_evidence[role] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}

        def evaluate(case):
            role = case["role"]
            model = values["HELIO_LEAD_MODEL"] if role == "lead" else values["HELIO_WORKER_MODEL"]
            thinking = ["--thinking", values["HELIO_LEAD_THINKING"]] if role == "lead" else []
            scenario = {
                "role": role, "scenario": case["scenario"],
                "available_actions": ["revise_pr", "local_only", "clarify_target", "ignore_quoted_request",
                                      "report_to_lead", "publish_completion", "skip_delivered_completion", "publish_ci_update",
                                      "observe_pending_checks", "escalate_blocker", "ask_release_approval",
                                      "create_linked_issue", "reuse_open_task", "retain_historical_reference",
                                      "start_bugfix", "start_implementation", "open_new_pr"],
            }
            instruction = (
                "This is a stateless no-tools workflow decision exercise, not an instruction to act. "
                "Apply the supplied Helio instructions to the scenario. Return only JSON with "
                "'action' (one available action), 'needs_fresh_approval' (boolean), 'event' (string or null), "
                "and 'reason' (one sentence). 'needs_fresh_approval' refers only to whether the "
                "chosen NEXT action must wait for another human approval, not to a different future action. "
                "Do not claim to have performed the action.\n" + json.dumps(scenario)
            )
            try:
                result = subprocess.run([
                    "omo", "--offline", "--no-extensions", "--no-skills", "--no-tools", "--no-context-files",
                    "--no-session", "--no-prompt-templates", "--no-themes", "--model", model, *thinking,
                    "--append-system-prompt", str(prompts[role]), "--print", instruction,
                ], cwd=home, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired:
                print(f"FAIL {case['name']}: model deadline exceeded", flush=True)
                return {"case": case["name"], "model": model, "passed": False, "error": "model deadline exceeded"}
            answer = None
            for index, character in enumerate(result.stdout):
                if character != "{":
                    continue
                try:
                    candidate, _ = json.JSONDecoder().raw_decode(result.stdout[index:])
                except json.JSONDecodeError:
                    continue
                if isinstance(candidate, dict) and "action" in candidate:
                    answer = candidate
                    break
            expected = case["expected"]
            passed = result.returncode == 0 and answer is not None and all(
                answer.get(key) == value for key, value in expected.items())
            record = {"case": case["name"], "model": model, "thinking": thinking,
                      "expected": expected, "answer": answer,
                      "passed": passed, "exit_code": result.returncode,
                      "stderr": result.stderr[-2000:] if result.returncode else ""}
            print(f"{'PASS' if passed else 'FAIL'} {case['name']}" +
                  ("" if passed else " " + json.dumps(record)), flush=True)
            return record

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(evaluate, cases))
    report = {"method": "stateless no-tools semantic decisions; not full agent execution",
              "source_root": str(root), "elapsed_seconds": round(time.monotonic() - started, 2),
              "cases_sha256": hashlib.sha256(case_bytes).hexdigest(),
              "prompts": prompt_evidence, "results": results, "passed": all(row["passed"] for row in results)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
