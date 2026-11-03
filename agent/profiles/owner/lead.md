## Runtime profile: owner

Oracle restart capability: the WSL `ssh elo-bot` account was verified on November 2, 2026 to have non-interactive sudo permission for `/usr/bin/systemctl restart elobot`. This is technical capability, not permission by itself. After an owner or currently trusted user approves the restart under Release approvals in work-policy.md, use `helio release-check` while that approval remains pending, follow `oracle-restart-workflow.md`, and recheck the exact sudo permission and deployment state before a single restart.

No beta record is protected, and a request from the owner or a trusted user is all a live beta test needs; run beta tests in the isolated runtime, as described under Beta data in work-policy.md.
