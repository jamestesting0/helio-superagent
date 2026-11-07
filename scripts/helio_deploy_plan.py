"""Decide what a deploy needs, from the paths it changed. Pure functions; the root launcher loads this file.

Kit paths come from the copy into ~/helio-agent; installed names come from sync-install's
"Managed updates:" line (`@inbound/<file>`, `@messenger/<file>`, `@launcher`, or a file in ~/.dori/elobot).
"""
from __future__ import annotations

from fnmatch import fnmatch

NONE, MONITORS, LEAD, FULL = "none", "monitors", "lead", "full"
ORDER = (NONE, MONITORS, LEAD, FULL)

KIT_RULES = (
    ("scripts/helio_isolated_launcher.py", FULL),
    ("scripts/helio_isolated_start.py", FULL),
    ("isolation/*.md", NONE),
    ("isolation/*", FULL),
    ("scripts/helio-followups.py", MONITORS),
    ("scripts/helio-questions.py", MONITORS),
    ("scripts/helio_runtime_policy.py", MONITORS),
    *(("scripts/" + helper, MONITORS) for helper in (
        "helio_housekeeping.py", "helio_retention.py", "helio_state_backup.py",
        "helio_observations.py", "helio_decision_upkeep.py", "helio_issue_sync.py", "helio_pr_readiness.py")),
    ("vendor/dori-mode/*", LEAD),
    ("omo/*", LEAD),
)
INSTALLED_RULES = (
    ("@inbound/*.test.ts", NONE),
    ("@inbound/fixtures/*", NONE),
    *(("@inbound/admin/" + name, NONE) for name in (
        "main.ts", "controller.ts", "editor.ts", "interaction.ts", "panels.ts", "render.ts", "manifest.ts",
        "broker.ts", "transport.ts", "registration.ts", "command-schema.ts", "command-sync.ts", "command-sync-state.ts")),
    ("@inbound/package.json", MONITORS),
    ("@inbound/*", MONITORS),
    ("inbound", MONITORS),
    ("context", MONITORS),
    ("setup-prompt.md", LEAD),
    ("work-policy.md", LEAD),
    ("config.json", LEAD),
    ("start", LEAD),
    ("browser-env", LEAD),
    ("knowledge-setup.py", LEAD),
    ("env", LEAD),
)


def classify(path: str, rules) -> str:
    for pattern, need in rules:
        if fnmatch(path, pattern):
            return need
    return NONE


def plan(kit_changes: list[str], installed_changes: list[str], env_changed: bool) -> dict:
    needs = {classify(path, KIT_RULES) for path in kit_changes}
    needs |= {classify(name, INSTALLED_RULES) for name in installed_changes}
    if env_changed:
        needs |= {LEAD, MONITORS}
    needs.discard(NONE)
    top = max(needs, key=ORDER.index) if needs else NONE
    administration = any(path.startswith("discord-inbound/admin/") and not path.endswith(".test.ts")
                         for path in kit_changes) or any(name.startswith("@inbound/admin/") and not name.endswith(".test.ts")
                                                        for name in installed_changes)
    return {
        "needs": top,
        "monitors_changed": MONITORS in needs or FULL in needs,
        "admin_controller_changed": administration,
        "changed": sorted(set(kit_changes) | set(installed_changes) | ({"env"} if env_changed else set())),
    }


def rsync_changes(itemized: str) -> list[str]:
    """Paths of regular files rsync -i created, updated or deleted."""
    out = []
    for line in itemized.splitlines():
        if line.startswith("*deleting "):
            out.append(line.split(" ", 1)[1].strip())
        elif len(line) > 12 and line[0] in "<>ch" and line[1] == "f":
            out.append(line[12:].strip())
    return [path for path in out if not path.endswith("/")]


def managed_changes(sync_output: str) -> list[str]:
    for line in sync_output.splitlines():
        if line.startswith("Managed updates: "):
            value = line.split(": ", 1)[1].strip()
            return [] if value == "none" else [name.strip() for name in value.split(",")]
    return []


ADVICE = {
    NONE: "Nothing to restart: the change is live now.",
    MONITORS: "Monitors restart themselves within a minute to load the new code.",
    LEAD: "Instructions or settings changed: run `helio restart` when convenient (monitors restart with it).",
    FULL: "The sandbox or launcher changed: stop Helio and run `helio start`.",
}
