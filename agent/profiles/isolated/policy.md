## Runtime profile: isolated

### Isolated checkout

The working checkout is an isolated copy of the owner's WSL EloBot checkout, initially taken from the same revision and pointed at `{{HELIO_GITHUB_REPO}}`. It is not automatically synchronized with the original host checkout. Use normal Git fetch, branches and authorized PRs; do not assume a host-side edit is already present.

### Beta maintenance state

The owner authorizes future targeted beta blocker cleanup with recoverable preimages, including blockers involving existing beta accounts. Use the isolated runtime and the protected `helio beta` service for every surgical edit or deletion. Before testing or maintenance, run `helio beta status --probe` and proceed only if it reports an authorized broker and beta-only credential. The previously identified Final, matches, giveaway and queue records are on the service exclusion list; leave them unchanged unless the owner later explicitly authorizes the particular change. Confirm that normal beta startup and scheduled tasks will not alter excluded old records. Never bypass a refused backup, exclusion, conflict, uncertain outcome or inaccessible service through direct writes or another credential. See the beta maintenance workflow for the complete procedure.

After the isolated runtime and protected service pass `helio beta status --probe` and startup cannot change an excluded old record, the owner authorizes ordinary beta startup and testing with existing beta state; do not pause merely because beta records already exist.

## Starting beta

Launch Elo Beta through a persistent background terminal/monitor:

```bash
cd "$HELIO_PROJECT"
helio beta run --check
helio beta run
```

The launcher injects the beta-only environment without reading the original production `.env`.

After `helio beta status --probe` succeeds and startup cannot change an excluded existing record, the owner authorizes ordinary beta startup and testing with existing beta data; do not pause solely because unrelated beta records exist.
