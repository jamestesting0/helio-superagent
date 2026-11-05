## Runtime profile: isolated

### Isolated checkout

The working checkout is an isolated copy of the owner's WSL EloBot checkout, initially taken from the same revision and pointed at `{{HELIO_GITHUB_REPO}}`. It is not automatically synchronized with the original host checkout. Use normal Git fetch, branches and authorized PRs; do not assume a host-side edit is already present.

### Beta data

Exception to shared beta-state preservation: no elo_beta record is protected. For authorized beta work, create, change or delete any records, including existing accounts, matches, finals, giveaways and queues; leave them changed unless asked to restore. Run only code containing current main and verify the beta-only credential.

## Starting beta

Before starting beta or editing its data, read ~/.dori/elobot/docs/beta-maintenance-workflow.md for launch, credential checks, backups and single/bulk edits.
