# Elo Beta maintenance workflow

## Current state: mutation disabled

The owner authorizes future targeted beta cleanup that unblocks testing, including specific older beta records, after effective database isolation and a recoverable preimage. The already identified Final/match and giveaway blockers are excluded from this standing authorization; leave them untouched unless the owner later explicitly requests their modification. Do not restore stale blockers after a future test merely to recreate the blocker.

`elo_beta` is the only database Helio may access for this workflow. The beta worktree environment now uses a MongoDB identity with effective privileges limited to `elo_beta`. The current lead can still access broader credentials and SSH through other paths. A Python database-name check or this document cannot enforce the owner's boundary. A separate protected preimage service is running and the existing records are on its exclusion list, but agent execution isolation and integration with that service have not yet been verified. Do not perform beta writes, direct or indirect, or launch a beta process that can write until all are independently verified. Never access the main `elo_bot` database for beta maintenance.

## Available preparation commands

- `helio beta status --probe` reads the separate `~/.dori/elobot/beta-mongo.env` and asks MongoDB only for current identity/privilege metadata and reports whether the credential is apparently beta-scoped. It does not establish process isolation, create a backup, or authorize a change.
- `helio beta inspect COLLECTION ID_JSON` reads a single exact ID from `elo_beta` only, and refuses the connection unless effective MongoDB privileges pass the strict beta-only check. For an ObjectId, ID_JSON is `'{"$oid":"24-hex-characters"}'`; for a string ID, pass a JSON string. This is read-only and does not establish process isolation.
- `helio beta plan FILE` validates a locally prepared JSON plan only. It does not connect to MongoDB, back up records or perform changes.
- `helio beta apply` is intentionally disabled. Do not work around the disabled command with PyMongo, shell scripts, a browser, SSH, another credential, or another process.

An offline plan uses `database: "elo_beta"`, a concise `purpose`, and `operations`, each with an exact `collection`, `id`, `action` (`update` or `delete`), `reason`, and full `before` document containing the same `_id`. Updates use a `set` object and/or an `unset` list of field paths. Bulk selectors, other databases, system collections, _id edits, unknown commands, overlapping field paths, and more than 50 operations are rejected. Validation is not permission, is not a database preflight, and does not save a backup.

## Intended procedure after prerequisites are verified

1. Determine the requested test, the exact blocker IDs and related Final, match, participant, queue and publication records. Identify any concurrent beta instance and relevant Discord/Helper effects. Existing beta data alone is not a reason to stop or ask the owner.
2. Read only the minimum relevant beta records. Establish the expected current state and a narrow plan. Prefer a normal beta command when it safely produces the required state; otherwise prepare exact-ID changes. Do not drop a database, drop a collection, issue unconstrained multi-record mutations, or change a main record.
3. Save complete BSON preimages and relationships in the protected backup service before each change. Verify the backup was durably recorded. Apply atomic compare-and-set or transactional operations when supported; a changed preimage or uncertain result requires reinspection rather than blind retry or overwrite.
4. Confirm the resulting beta records and run the real test. Keep the audit record with operation IDs and evidence; do not publish credentials, unrelated user data, or raw documents to Discord. Leave cleared old test blockers cleared, with a recoverable backup; do not automatically restore if it recreates a blocker or overwrites newer state.
5. Only ask via Discord when the boundary is unavailable, the affected records or external side effects cannot be bounded, the backup fails, or a genuine product decision remains. Resolve routine fixture and known beta blocker choices autonomously.

A database snapshot cannot undo a Discord message, announcement, permission change, CoC/Helper action, or other external side effect. Check the destinations and scheduling state before starting beta; never claim the backup reverses those effects. The owner's existing Discord/production authorization rules still apply.
