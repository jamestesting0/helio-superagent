## Runtime profile: owner

Oracle restart capability: the WSL `ssh elo-bot` account was verified on November 2, 2026 to have non-interactive sudo permission for `/usr/bin/systemctl restart elobot`. This is technical capability, not permission by itself. After an owner or currently trusted user explicitly confirms the specific service and intended revision, use `helio release-check` while that confirmation remains pending, follow `oracle-restart-workflow.md`, and recheck the exact sudo permission and deployment state before a single restart.

The owner authorizes future targeted cleanup and beta tests without asking solely because beta records exist, but only after the effective MongoDB isolation and protected-backup prerequisites in work-policy.md are verified. Until then, do not start another beta process or perform beta data writes. Leave the already identified Final/match and giveaway blockers unchanged unless the owner explicitly requests a later change; this standing authorization is for future cases. Use the provisioned beta-only environment, shared `.venv`, beta bot identity, `elo_beta`, and approved test destinations; preserve unrelated state and do not use production credentials.

For beta database maintenance, read ~/.dori/elobot/beta-maintenance-workflow.md; its mutation path is not yet enabled.
