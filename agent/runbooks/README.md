# Helio operator documentation

The human operator guide is [docs/operator-guide.md](../../docs/operator-guide.md)
in this repository. It isn't installed. The agent's own instructions are built
from [agent/prompts/lead.md](../prompts/lead.md) and
[agent/prompts/policy.md](../prompts/policy.md) plus the selected profile overlay
under `agent/profiles/<profile>/`. They're installed as `~/.dori/elobot/setup-prompt.md`
(lead only) and `~/.dori/elobot/work-policy.md` (lead and every worker).

## Runbooks

Installed runbooks live in `~/.dori/elobot/docs/`.

- [Discord command QA](discord-qa-workflow.md): beta launch, browser testing,
  multi-account scenarios, evidence and cleanup. Shared by both profiles; the
  profile-specific beta start commands are in work-policy.md under "Starting beta".
- Beta maintenance (`beta-maintenance-workflow.md`): changing beta data (no record is protected),
  backups and conflict handling. Per profile:
  [owner](../profiles/owner/runbooks/beta-maintenance-workflow.md),
  [isolated](../profiles/isolated/runbooks/beta-maintenance-workflow.md).
- Oracle restart (`oracle-restart-workflow.md`): inspection and separately
  authorized production restarts. Per profile:
  [owner](../profiles/owner/runbooks/oracle-restart-workflow.md),
  [isolated](../profiles/isolated/runbooks/oracle-restart-workflow.md).

Installed copies keep the old root runbook paths as relative symlinks for
existing prompts, notes and external references. Edit the files in this repository,
not the installed copies. `setup-prompt.md` and `work-policy.md` stay at the
installation root because sessions load them directly. `project-docs/` remains a
separate bundle copied into the bot checkout by `knowledge-setup.py`; it is not
runtime state.

## Installed folder map (`~/.dori/elobot/`)

| Location | Purpose |
|---|---|
| `docs/` | Installed operator runbooks |
| `project-docs/` | Bot development and presentation guidance |
| `start`, `inbound`, `ack`, `context`, `reply.ts`, `thread-target.ts`, `browser-env` | Runtime entrypoints and helpers; keep their paths |
| `config.json`, `setup-prompt.md`, `work-policy.md` | Runtime configuration and instructions |
| `trusted-users`, `release-approvers`, `report-channels` | Authorization settings generated from `~/.config/helio/helio.env`; edit them there and run `helio update` |
| `env`, `beta.env`, `beta-mongo.env` | Private credentials; do not print or move |
| `state/` | Active sessions, deliveries, attachments and worktrees; do not reorganize |

## Existing installations

From the portability kit, preview the content-preserving move:

```bash
python3 scripts/organize-elobot-docs.py --home "$HOME"
python3 scripts/organize-elobot-docs.py --home "$HOME" --apply
```

Use the actual installation home. The owner host and the dedicated isolated
runtime home are separate installations. This command moves each installation's
existing runbooks without replacing their content or changing its sync baseline,
credentials, permissions, runtime state or processes. It refuses collisions and
unexpected symlinks. It can resume a move interrupted before its compatibility
link was created. Normal `sync-install.py --apply` also performs the organization
after its usual local-change checks pass.
