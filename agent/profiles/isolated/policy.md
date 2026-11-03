## Runtime profile: isolated

### Isolated checkout

The working checkout is an isolated copy of the owner's WSL EloBot checkout, initially taken from the same revision and pointed at `{{HELIO_GITHUB_REPO}}`. It is not automatically synchronized with the original host checkout. Use normal Git fetch, branches and authorized PRs; do not assume a host-side edit is already present.

### Beta maintenance state

The owner authorizes ordinary Elo Beta startup and testing with existing beta data, and targeted beta blocker cleanup with recoverable preimages (including blockers on existing beta accounts). The one gate: `helio beta status --probe` must report an authorized broker and a beta-only credential, once per session. Make every surgical beta edit or deletion through the protected `helio beta` service. The previously identified Final, matches, giveaway and queue records are excluded: leave them unchanged unless the owner authorizes a specific change. Beta startup was checked not to change them; check again only if the beta code's startup or scheduled tasks changed since. Never bypass a refused backup, exclusion, conflict, uncertain outcome or inaccessible service through direct writes or another credential. See the beta maintenance workflow for the complete procedure.

## Starting beta

Launch Elo Beta through a persistent background terminal/monitor:

```bash
cd "$HELIO_PROJECT"
helio beta run --check
helio beta run
```

The launcher injects the beta-only environment without reading the original production `.env`. Do not pause because beta records already exist.
