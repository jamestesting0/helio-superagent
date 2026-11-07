"""What Helio installs into ~/.dori, and how each file is rendered.

Shared by scripts/install.py (fresh install) and scripts/sync-install.py (updates),
so both always agree on the file set and the rendered bytes.
"""
from __future__ import annotations

import json
import re
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = ROOT / "agent"
CONFIG = runpy.run_path(str(ROOT / "scripts/helio_config.py"))
PROFILES = ("isolated", "owner")
EXECUTABLES = ("start", "inbound", "ack", "context")
HELPERS = ("knowledge-setup.py", "helio-sessions.py", "browser-env", "browser-env.test.ts",
           "reply.ts", "reply.test.ts", "evidence.ts", "evidence.test.ts", "thread-target.ts", "thread-target.test.ts")
RUNBOOKS = ("discord-qa-workflow.md", "beta-maintenance-workflow.md", "oracle-restart-workflow.md", "autofix-workflow.md",
            "issue-plan-workflow.md", "decisions-workflow.md", "issue-truth-workflow.md", "startup-recovery-workflow.md")
PROFILE_RUNBOOKS = ("beta-maintenance-workflow.md", "oracle-restart-workflow.md")
# Skills passed to the lead and every lane with `omo --skill`; installed under ~/.dori/elobot/skills.
SKILLS = ("skills/karpathy-guidelines/SKILL.md",)
VENDOR_MANAGED = ("scripts/src/session-state.ts",)
VENDOR_FILES = ("LICENSE", "scripts/src/run.ts", *VENDOR_MANAGED,
                "scripts/src/messenger/discord.ts", "scripts/src/messenger/http.ts")
MESSENGER = ("http.ts", "discord.ts")
MANAGED = ("setup-prompt.md", "work-policy.md", *RUNBOOKS, "config.json", *EXECUTABLES, *HELPERS, *SKILLS)
RETIRED = ("GUIDE.md", "channel-policy.env")
# sha256 of files shipped by the pre-reorganization kit, per profile. An installed
# file with one of these digests was reviewed upstream, so replacing or retiring it
# cannot lose a local edit. Owner digests only count for the owner profile, so an
# unmarked owner home is never silently converted to isolated policy.
PREVIOUSLY_SHIPPED = {
    "owner": {
        "GUIDE.md": {"406d45b1b3204d79859716eb2a0b96a74b53146d923ba6f31c06d4342622e7fe"},
        "work-policy.md": {"f991be7f93958bbe8b6b6d463ea1c3267569b4774740cb771e322581d2a72e7c"},
        "setup-prompt.md": {"8d93cfa6bbc8076dbcc2b78c2f87ea39d52f62d0ad4a8f2dcf8373f73cbc7257"},
        "discord-qa-workflow.md": {"d4f7bd7d728c01604e0c28f5132b724a81dd3cf606b75f9f7c3bd7f193df22a4"},
        "beta-maintenance-workflow.md": {"46ba954d60702bc37ee74154200310f0743052c60e11aa3a45fa379b4fbbfdf4"},
        "oracle-restart-workflow.md": {"5ed3ffa7149e0e5b151356f5904dc3374fe88bf9c8bba3c7cff1b6f6ce02d90e"},
        "channel-policy.env": {"b254efee77fa67e3d51a4fc68bacb42deefcd83c71601c3a86c0aa18353dedec"},
    },
    "isolated": {
        "GUIDE.md": {"017f5d6570fc812134b3ffa7a930dbfef353622f91ff187a7d8e505bc87cff23"},
        "work-policy.md": {"b8aad8b8c16e8d95de5eabd448bd02ea9d7ec2f2b021c089ec543510d82d75c3"},
        "beta-maintenance-workflow.md": {"35a0475c1f23aa0a8994fc119bebfe0482726434cc38f444af324461c10229f1"},
        "oracle-restart-workflow.md": {"421ed64e1346e7b7a76e90e22d547b5cf8fc6d52a9d2351a3fb131305950796d"},
        "channel-policy.env": {"b254efee77fa67e3d51a4fc68bacb42deefcd83c71601c3a86c0aa18353dedec"},
    },
}
for _shipped in PREVIOUSLY_SHIPPED.values():
    _shipped.update({
        "start": {"808e7341f0f2723d52702f40a68a7f4ccd2cccfe79ac1fa24cbc5cbb0751faff"},
        "inbound": {"c6b1bc1d4fb1500026693ea8add9909816a5e89096b9b99743c0f0456369d9b1"},
        "ack": {"68f46fa026bb2346b5dc2f2b7cafbf6782a3695f6dd49b0325fcc0ce975b9e2f"},
        "context": {"12c79bdb6532d8287300bc3ce4179789a4cfe055ddbcd641a05ef4a1765c63f0"},
    })
INBOUND_FILES = (
    # entry points and package
    "ack.ts", "blacklist.ts", "bun.lock", "context.ts", "conversation.ts", "inbound.ts", "package.json", "recovery.ts",
    "patches/agent-messenger@2.40.0.patch",
    # owner-side controller and isolated administration bridge
    "admin/backend.ts", "admin/backend.test.ts", "admin/broker.ts", "admin/controller.ts", "admin/controller.test.ts",
    "admin/editor.ts", "admin/interaction.ts", "admin/lane-session.ts", "admin/main.ts", "admin/manifest.ts", "admin/panels.ts",
    "admin/protocol.ts", "admin/render.ts", "admin/render.test.ts", "admin/runtime.ts",
    "admin/lane-records.ts", "admin/lane-evidence.ts", "admin/policy-records.ts", "admin/record-format.ts",
    "admin/github-status.ts",
    "admin/transport.ts", "admin/transport.test.ts", "admin/registration.ts", "admin/registration.test.ts", "admin/command-schema.ts",
    "admin/command-sync.ts", "admin/command-sync-state.ts", "admin/command-sync.test.ts",
    "admin/main.test.ts", "admin/fixtures/main-preload.ts",
    "admin/runtime-access.ts", "admin/runtime-mutations.ts", "admin/runtime-records.ts", "admin/runtime-state.ts", "admin/runtime-recovery.ts",
    # discord
    "discord/rest-cache.test.ts", "discord/rest.test.ts", "discord/rest.ts",
    # intake
    "intake/archived-threads.test.ts", "intake/archived-threads.ts", "intake/authorization.ts",
    "intake/bug-reports.test.ts", "intake/catchup-gaps.test.ts", "intake/catchup.test.ts", "intake/catchup.ts", "intake/channel-policy.test.ts",
    "intake/filter.test.ts", "intake/filter.ts", "intake/lastseen.ts", "intake/owner-mentions.test.ts",
    "intake/preceding.test.ts", "intake/preceding.ts", "intake/recent-ids.test.ts", "intake/recent-ids.ts", "intake/turns.test.ts", "intake/turns.ts",
    "intake/watched-channels.ts",
    "intake/source-proof.ts", "intake/source-proof.test.ts",
    "intake/runtime-policy.ts", "intake/runtime-policy.test.ts",
    # delivery
    "delivery/context-render.ts", "delivery/delivery.test.ts", "delivery/delivery.ts", "delivery/expiry.test.ts",
    "delivery/expiry.ts", "delivery/monitor-summary.ts", "delivery/pending-reminder.ts",
    "delivery/ignored-store.ts", "delivery/ignored-cleanup.ts", "delivery/ignored.test.ts",
    "delivery/reconcile.ts", "delivery/reconcile-manifest.ts",
    "delivery/recovery-schema.sql", "delivery/recovery-store.ts", "delivery/moderation.ts", "delivery/moderation.test.ts",
    "delivery/moderation-effects.ts", "delivery/owner-proof.ts", "delivery/owner-proof.test.ts",
    # messages
    "messages/embed-images.test.ts", "messages/forwarded.test.ts", "messages/forwarded.ts",
    "messages/image-worker.test.ts", "messages/image-worker.ts", "messages/images.test.ts", "messages/images.ts",
    "messages/linked-files.test.ts", "messages/linked-files.ts", "messages/links.test.ts",
    "messages/message-text.test.ts", "messages/message-text.ts", "messages/reply-context.test.ts",
    "messages/reply-context.ts",
    # conversations
    "conversations/conversation-context.ts", "conversations/conversation-db.test.ts",
    "conversations/conversation-db.ts", "conversations/conversation-upkeep.test.ts",
    "conversations/conversation-upkeep.ts", "conversations/conversations.test.ts", "conversations/conversations.ts",
    "conversations/issue-review.ts", "conversations/understanding.test.ts",
    "conversations/question-answer.test.ts", "conversations/question-answer.ts", "conversations/receipts.test.ts",
    "conversations/reply-guard.ts", "conversations/reply-once.test.ts", "conversations/reply-once.ts",
    "conversations/reply-settlement.ts", "conversations/fulfillment.test.ts",
    "conversations/notice-store.ts", "conversations/notice-races.test.ts",
    "conversations/pending-input.ts",
    "conversations/reconcile-topic.ts", "conversations/reconcile-final.ts",
    "conversations/working-store.ts", "conversations/working.test.ts", "conversations/working.ts",
    # learning
    "learning/context-replay.ts", "learning/context-replay.test.ts", "learning/learning-scope.test.ts", "learning/learning-scope.ts",
    # interactive
    "interactive/cli-flow.test.ts", "interactive/cli.ts", "interactive/handler.ts", "interactive/question-store.ts", "interactive/questions.ts", "interactive/transport.ts",
    "interactive/questions.test.ts", "interactive/recovery.test.ts",
    "interactive/interactive.test.ts", "interactive/store.ts", "interactive/text.ts",
    # tests
    "tests/context-pending.test.ts", "tests/conversation.test.ts", "tests/flow.test.ts", "tests/catchup-pages.test.ts", "tests/ignored-threads.test.ts", "tests/upkeep-independent.test.ts", "tests/moderation-flow.test.ts", "tests/blacklist-cli.test.ts",
    "tests/stage-first.test.ts", "tests/gateway-message.test.ts", "tests/quiet-input.test.ts", "tests/reconciliation.test.ts",
    "tests/learning-context.test.ts", "tests/monitor-contract.test.ts", "tests/normal-flow.test.ts",
    "tests/policy-flow.test.ts", "tests/recovery-flow.test.ts", "tests/startup-recovery.test.ts",
    "tests/turns-flow.test.ts",
    # fixtures
    "fixtures/clock.ts", "fixtures/delivery-output.ts", "fixtures/discord-client.ts", "fixtures/discord-data.ts",
    "fixtures/discord.ts", "fixtures/now.ts", "fixtures/working.ts",
)
CHECKOUT_DOCS = ("README.md", "base-fingerprints.md", "bot-ui.md", "copy-style.md", "discord-qa.md")
PLACEHOLDER = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")


def installed_values(home: Path) -> dict[str, str]:
    for source in (CONFIG["config_path"](home), home / ".dori/elobot/env"):
        if source.is_file() and not source.is_symlink():
            return CONFIG["parse"](source.read_text(), strict=False)
    return {}


def configured_project(home: Path, env: dict[str, str]) -> str | None:
    return CONFIG["expand"](env["HELIO_PROJECT"], home) if env.get("HELIO_PROJECT") else None


def values(home: Path, project: str, env: dict[str, str] | None = None) -> dict[str, str]:
    known = set(CONFIG["defaults"]())
    resolved = CONFIG["resolve"]({k: v for k, v in (env or {}).items() if k in known}, home)
    resolved.update(HOME=str(home), HELIO_PROJECT=project)
    return resolved


def fill(text: str, mapping: dict[str, str], escape=lambda value: value) -> str:
    missing = sorted({name for name in PLACEHOLDER.findall(text) if name not in mapping})
    if missing:
        raise SystemExit("Unknown template placeholders: " + ", ".join(missing))
    return PLACEHOLDER.sub(lambda match: escape(mapping[match.group(1)]), text)


def render_text(sources: list[Path], mapping: dict[str, str]) -> bytes:
    return fill("\n\n".join(path.read_text().rstrip("\n") for path in sources) + "\n", mapping).encode()


def render_config(mapping: dict[str, str]) -> dict:
    text = (AGENT / "config.template.json").read_text()
    return json.loads(fill(text, mapping, lambda value: json.dumps(value)[1:-1]))


def documents(profile: str, mapping: dict[str, str]) -> dict[str, bytes]:
    if profile not in PROFILES:
        raise SystemExit(f"Unknown profile: {profile}")
    overlay = AGENT / "profiles" / profile
    rendered = {
        "setup-prompt.md": render_text([AGENT / "prompts/lead.md", overlay / "lead.md"], mapping),
        "work-policy.md": render_text([AGENT / "prompts/policy.md", overlay / "policy.md"], mapping),
        "discord-qa-workflow.md": render_text([AGENT / "runbooks/discord-qa-workflow.md"], mapping),
        "autofix-workflow.md": render_text([AGENT / "runbooks/autofix-workflow.md"], mapping),
        "issue-plan-workflow.md": render_text([AGENT / "runbooks/issue-plan-workflow.md"], mapping),
        "decisions-workflow.md": render_text([AGENT / "runbooks/decisions-workflow.md"], mapping),
        "issue-truth-workflow.md": render_text([AGENT / "runbooks/issue-truth-workflow.md"], mapping),
        "startup-recovery-workflow.md": render_text([AGENT / "runbooks/startup-recovery-workflow.md"], mapping),
    }
    for name in PROFILE_RUNBOOKS:
        rendered[name] = render_text([overlay / "runbooks" / name], mapping)
    return rendered


def plain(name: str) -> Path:
    if name in SKILLS:
        return AGENT / name
    folder = "bin" if name in EXECUTABLES else "helpers"
    return AGENT / folder / name
