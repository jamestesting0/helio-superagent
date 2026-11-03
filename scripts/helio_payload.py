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
           "reply.ts", "reply.test.ts", "thread-target.ts", "thread-target.test.ts")
RUNBOOKS = ("discord-qa-workflow.md", "beta-maintenance-workflow.md", "oracle-restart-workflow.md")
PROFILE_RUNBOOKS = ("beta-maintenance-workflow.md", "oracle-restart-workflow.md")
VENDOR_FILES = ("LICENSE", "scripts/src/run.ts", "scripts/src/messenger/discord.ts", "scripts/src/messenger/http.ts")
MESSENGER = ("http.ts", "discord.ts")
MANAGED = ("setup-prompt.md", "work-policy.md", *RUNBOOKS, "config.json", *EXECUTABLES, *HELPERS)
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
    "ack.ts", "archived-threads.ts", "archived-threads.test.ts", "authorization.ts",
    "bug-reports.test.ts", "bun.lock", "catchup.test.ts", "catchup.ts",
    "channel-policy.test.ts", "context-pending.test.ts", "context-replay.ts", "expiry.ts", "expiry.test.ts",
    "context.ts", "learning-context.test.ts", "learning-scope.ts", "learning-scope.test.ts", "delivery.test.ts", "delivery.ts", "filter.test.ts", "filter.ts",
    "fixtures/discord.ts", "flow.test.ts", "forwarded.test.ts", "forwarded.ts", "reply-context.ts", "reply-context.test.ts", "question-answer.ts", "question-answer.test.ts",
    "images.test.ts", "images.ts", "inbound.ts", "lastseen.ts", "normal-flow.test.ts", "package.json", "policy-flow.test.ts",
    "recovery-flow.test.ts", "rest.ts", "watched-channels.ts",
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
    }
    for name in PROFILE_RUNBOOKS:
        rendered[name] = render_text([overlay / "runbooks" / name], mapping)
    return rendered


def plain(name: str) -> Path:
    folder = "bin" if name in EXECUTABLES else "helpers"
    return AGENT / folder / name
