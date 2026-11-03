## Runtime profile: isolated

### Isolated checkout

The working checkout is an isolated copy of the owner's WSL EloBot checkout, initially taken from the same revision and pointed at `{{HELIO_GITHUB_REPO}}`. It is not automatically synchronized with the original host checkout. Use normal Git fetch, branches and authorized PRs; do not assume a host-side edit is already present.

### Beta data

Elo Beta and its `elo_beta` database are Helio's to use for testing. When the owner or a trusted user asks for a beta test, start Elo Beta and test right away; nothing else needs approving or checking first. No beta record is protected: create, change or delete any `elo_beta` data the test or fix needs, including old matches, finals, giveaways, queue entries and existing beta accounts, and leave it changed afterwards unless asked to restore it. Use `helio beta apply` for single-record edits (it keeps an automatic backup) and direct PyMongo writes with the beta credential for anything larger, such as resetting a queue or clearing many records. The one hard line is production: never the production token, the original `.env` or the `elo_bot` database; `helio beta run` and `helio beta status --probe` confirm the beta-only credential automatically.

## Starting beta

Launch Elo Beta through a persistent background terminal/monitor:

```bash
cd "$HELIO_PROJECT"
helio beta run --check
helio beta run
```

The launcher injects the beta-only environment without reading the original production `.env`. Do not pause because beta records already exist.
