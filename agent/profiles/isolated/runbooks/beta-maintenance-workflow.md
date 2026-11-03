# Elo Beta maintenance workflow

## Boundary

`elo_beta` is the only database for beta work, and all of it is available: no beta record is protected. A live beta test needs only a request from the owner or a currently trusted user. Never use production credentials, the original `.env` or the `elo_bot` database. `helio beta run` and `helio beta status --probe` confirm the beta-only credential automatically; if they report a production or non-beta credential, stop and tell the owner.

## Starting a test

1. `cd "$HELIO_PROJECT"`, then `helio beta run --check` and `helio beta run` in a persistent background terminal.
2. Set up whatever state the test needs. Prefer the bot's own commands when they produce it; otherwise change the data directly (below).
3. Run the real test and report the result with evidence.

## Changing beta data

- One record: `helio beta inspect COLLECTION ID_JSON` (ObjectIds as `'{"$oid":"24-hex-characters"}'`), write a plan with one `update` or `delete` operation, `helio beta plan FILE`, then `helio beta apply FILE`. The service backs up the record before changing it, so this is the quick path with an undo.
- Many records or structural changes (resetting a queue, clearing old matches, removing a stale final or giveaway): use PyMongo directly with the beta credential from `~/.dori/elobot/beta-mongo.env`, limited to the `elo_beta` database.
- Leave changed data as it is after the test unless someone asks for it back. On `conflict`, re-read the record and retry with a fresh plan. On an uncertain result, re-read the current state before deciding what to do next.

## External effects

A database change or backup cannot undo Discord messages, announcements, role changes or CoC/Helper calls, so keep beta output in the test channels. Since Elo Bot `26e3136` the inactive-thread cleanup runs only on the main bot, never on Elo Beta. `helio beta run` therefore requires a checkout that contains `origin/main`; for an older PR branch it prints the commands to test the branch merged with main in a local worktree. Never push that merge.

## Backups

The owner can run `helio-backup list`, `helio-backup verify OPERATION_ID` or `helio-backup export OPERATION_ID` from their normal WSL shell to recover a record changed through `helio beta apply`.
