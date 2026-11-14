# Helio administration

The command catalog and UI contract live in
`helio-admin-commands-plan.md`. The implementation supports guild-scoped and
globally registered bot-DM commands, ephemeral embeds, native selectors, record autocomplete, and conventional
message action rows. It does not use the lead model to route administration.

Owner and trusted users can inspect authorized records and manage blocks.
Trusted membership, channel rules, timing/limits, and abandonment require the
owner. Private DM topics remain private to their requester. Every interaction
rechecks current access, including autocomplete and confirmation clicks.
Commands are direct: `/status`, `/conversations`, `/lanes`, `/blocks`, `/trusted`,
`/channels`, `/timeouts`, `/settings`, and `/audit`. There is no `/helio` prefix.
DM interactions use the authenticated top-level Discord `user`; no guild member
object is required. DM operations still use `HELIO_ADMIN_GUILD` for server data
and Discord visibility checks. Panel ownership retains its actual DM origin.
Autocomplete shares one runtime request budget across DM policy resolution and
record lookup, leaving time for Discord's interaction callback.

## Code ownership

The administration files are under `discord-inbound/admin/`:

| Boundary | Owner |
| --- | --- |
| Gateway connection and lifecycle synchronization | `main.ts`, `command-sync.ts` |
| Guild/DM definitions and semantic remote comparison | `manifest.ts`, `registration.ts`, `command-schema.ts` |
| Process-bound synchronization observations | `command-sync-state.ts`, `scripts/helio_admin_lifecycle.py` |
| Discord event parsing and current membership checks | `interaction.ts` |
| Per-panel serialization and navigation | `controller.ts` |
| Panel identity, expiry, and saved positions | `panels.ts` |
| Embeds, component budgets, and content pagination | `render.ts`, `record-format.ts` |
| Mutation previews and configuration submissions | `editor.ts` |
| Typed broker envelopes and socket client | `protocol.ts`, `broker.ts` |
| Discord REST rate limits, deadlines, and safe errors | `transport.ts` using `@discordjs/rest` |
| Isolated proof entry point and operation receipts | `runtime.ts`, `backend.ts` |
| Runtime database lifetime | `runtime-state.ts` |
| Current channel/DM access and member permissions | `runtime-access.ts` |
| Conversation, lane, moderation, and audit projections | `runtime-records.ts`, `lane-records.ts` |
| Policy, application, and deployment projections | `policy-records.ts` |
| Shared domain mutations | `runtime-mutations.ts` |
| Independent lane execution observations | `lane-session.ts` |
| Read-only GitHub, worktree, completion-binding, and cleanup observations | `lane-evidence.ts` |
| Isolated authoritative operation reconciliation | `runtime-recovery.ts` |
| GitHub observations | `github-status.ts`, `scripts/helio_github_status.py` |

Dependencies run from the controller toward typed operations and existing domain
stores. Record readers cannot submit a mutation. Rendering receives records and
panel state; it does not open databases or call Discord. Domain operations reuse
the existing conversation, moderation, and Dori lifecycle implementations.

The root broker is `scripts/helio_admin_service.py`. Its private socket accepts
only the owner OS user and is never mounted into the sandbox. The Gateway
controller runs as that owner and receives authentic Discord events directly.
Administration interactions are handled outside intake delivery; panel
components retain the `ha1:` namespace.

The broker owns the privilege crossing: actor authorization, typed request
allowlists, operation deduplication, protected proof publication, namespace
selection, and execution after dropping to the isolated UID. The runtime
receives a short-lived read-only proof rather than a fabricated Discord owner
message. Root bounds subprocess output without limiting runtime database sizes.
Its operation journal, bounded worker-process handling, and Unix framing are
separate modules: `scripts/helio_admin_journal.py`,
`scripts/helio_admin_process.py`, and `scripts/helio_admin_socket.py`.
`scripts/helio_admin_recovery.py` reads canonical receipts or asks the isolated
receipt owner to reconcile a submitted operation. It does not submit a second
runtime mutation.

The administration REST transport uses the pinned `@discordjs/rest` package for
shared route/global rate-limit handling. Server-error/timeout retries are disabled
to preserve unknown-write outcomes. Interaction callbacks have a short deadline
and reject rate-limit waits; ordinary response edits retain bucket scheduling.
The existing `agent-messenger` Gateway connection remains the event source.

## Configuration and migration

`~/.config/helio/helio.env` remains the canonical source. New values are
`HELIO_ADMIN_GUILD` and `HELIO_CONVERSATION_TIMEOUT_HOURS`; old files inherit
their template defaults until explicitly set. `HELIO_CONVERSATION_NUDGE_HOURS` is
retired (Helio no longer sends reminders); an existing line is ignored.

Settings writes use the same lock as rendering and policy publication. A revision
conflict leaves the current canonical file intact. Stable operation receipts
prevent a repeated confirmation from applying the transition twice.

Rendering adds a non-secret `policy/policy.json` and a lane-settings projection.
An unconfigured fresh installation supplies default lane settings so its Dori
configuration can load before the owner creates `helio.env`. It does not supply
credentials or an authorization snapshot; configuration rendering replaces those
default lane settings when the canonical file exists.
Legacy updates without a canonical file also initialize a missing lane-settings
projection before replacing the Dori configuration. An existing projection,
including the protected isolated mount, is preserved.
The isolated launcher mounts the protected policy directory read-only. The
legacy trusted/report/release files become exact relative links into that
directory. This avoids pinning an old authorization-file inode after replacement.
Managed updates accept only that specific link layout, not arbitrary symlinks.

Intake, learning, and the lane watcher acknowledge a policy revision with their
live process identity. “Saved and active” requires current acknowledgments.
Persistence can succeed while application is pending; Settings shows which
consumers have applied the revision. Manual owner CLI renders notify the same
publisher when the administration broker is installed.

Conversation reminders must precede timeout. The automatic-block window is
bounded to the existing 24-hour strike retention. Hibernation accepts zero to
disable it. Other supported units and bounds appear in timing details and
autocomplete.

## Initial host activation

Initial installation is explicit; subsequent command synchronization is
automatic. The controller starts its Gateway handler before reconciling global
bot-DM and configured-guild commands independently. A guild denial does not stop
DM registration or the main Helio workspace.

First review the owner configuration and apply its normal managed update.
Install the locked inbound dependencies if they are not present. Preview the
controller build:

```sh
cd ~/PythonProjects/helio-superagent
(cd discord-inbound && bun install --frozen-lockfile --ignore-scripts)
helio update
python3 scripts/helio_admin_install.py
sudo python3 -I scripts/helio_root_bundle.py --administration-only
```

After approving the host changes, install the root scripts/units/template and
the bundled controller:

```sh
sudo python3 -I scripts/helio_root_bundle.py --administration-only --apply
sudo python3 -I scripts/helio_admin_install.py --apply
sudo systemctl enable helio-admin.service helio-admin-controller.service
```

The administration-only installation preserves beta/release payloads and does
not restart them. The controller build creates immutable versioned files and an
atomic activation link; installation and enablement do not start it.
Initial readiness setup also installs the reviewed host wrapper containing
read-only administration status and isolated Python invocation. Routine updates
continue to preserve that wrapper.

Deploy the managed runtime payload, then perform the separately approved full
workspace stop/start so the directory mount and updated Dori watcher load.
`helio deploy` includes the owner update and prepares a changed installed
administration controller. If Helio is stopped, run `helio start` afterward.
If the deployment requires a full workspace restart, stop the current workspace
with its normal Stop/Ctrl+C control before starting it again.
The first start publishes the protected policy directory.
Deployment transfers only the staged lockfile's package-cache entries from the
owner to the isolated cache before its frozen offline dependency update. It does
not copy the whole owner cache, credentials, or `node_modules`.

`helio start` / `helio restart` activates the deployed administration version
when installed and enabled. `helio update` requests a background reconciliation
from the current compatible controller. New source definitions wait for the
matching deployment/activation. No standalone registration command is needed.
Status reports staged and deployed source identities separately from the installed
and running bundle. If deployment_pending is true, run `helio deploy`; the running
controller continues to synchronize its own loaded definitions until activation.

Registration uses the application's bot identity, reads the actual catalogs,
creates missing roots, and patches changed roots. An unchanged reconciliation
uses three Discord GETs including application metadata and makes no command
writes. Readback verifies changed catalogs before deleting the retired `helio`
prefix. Other application commands and command types are preserved.
DM registration uses the global endpoint, bot-DM context, and the application's
enabled guild/user installation types. It needs no guild command access or
successful guild-policy lookup. Empty catalogs do not prevent first startup.
Synchronization is serialized/coalesced inside the controller, uses a separate
REST client, and retains per-scope observations. Transient failures retry with
backoff; permission/configuration failures do not loop, and server rate-limit
waits survive process restarts.
The application's Interactions Endpoint URL must be empty for Gateway delivery.
The controller checks this and refuses a split dispatch setup.

Check service logs for `ADMIN_READY` and `ADMIN_CONTROLLER_READY`, then open
`/status`. Verify owner, trusted, and unauthorized behavior using the Helio
application. Do not substitute Elo Beta command checks for this feature.
`helio status`, host `helio doctor --json`, and `/status` expose registration
results with observation times. Registration and runtime readiness are distinct;
an unavailable runtime is not reported as ready merely because commands exist.

In DMs, channel options accept an ID with authorized server-channel autocomplete.
Guild-only channel/member menus are replaced by exact slash-command guidance;
the commands remain usable without a guild picker. Bot-DM availability also
requires a supported installation for the caller. Registration is not evidence
that the host controller or isolated runtime is active.

## Operations and recovery

Panels expire after ten idle minutes and lose all controls. Components bind to
their actor, guild, channel, message, and view revision. Restart invalidates old
confirmation controls. A submitted uncertain change retains only receipt
inspection across restart. Use a new invocation after expiry.

Lists preserve a snapshot of stable record IDs. Page navigation rechecks
visibility, removes unavailable records, and never selects a replacement record
by its old position. Refresh admits new matches and preserves the first visible
record when possible. Activity and long fields are paginated without discarding
their retained text.

Unknown write outcomes are saved under their operation ID and inspected before
another write is offered. A successful change remains reported even if reloading
the target's current details fails. Runtime changes appear in Audit; canonical
configuration changes are merged from the owner transaction journal.
An unresolved panel offers Check outcome and Close panel. Closing or expiring
the panel leaves the durable operation available in Audit. Recovery consults
canonical/runtime/domain receipts, rechecks current target visibility, and
preserves an unresolved outcome when no authoritative witness exists. Initial
read outages retain Refresh and Close panel without exposing mutation controls.
Definite refusals retain the proposed inputs, including the reason. Refresh
reloads the target and offers a fresh confirmation with a new operation ID;
it does not retry automatically. Changed or unavailable actions stay read-only.
Malformed replies and unexpected dispatch failures remain unresolved rather than
being labeled refusals. Authorization denial clears the sensitive controls.
Policy inspection can read only the acting user's private-thread membership
alongside channel metadata. Ignored message content, other membership records,
membership lists, and writes remain blocked by that capability.

GitHub diagnostics perform only reads inside the isolated runtime. DNS,
authentication, REST, GraphQL, and rate-budget observations have a timestamp.
They do not clear queued synchronization or prove a prior write completed.
The existing five-minute reconciliation queue persists failed, uncertain,
partial, and completed outcomes, including `ISSUE_LOG_PENDING` on a zero exit.
It also retains classified failure/stage, attempt start/end, last completed sync,
next attempt, and explicit review holds. Human-edit conflicts stay held until
review rather than being retried as network failures.
Review eligibility is independent of a simultaneous transport or comment-write
failure, including output captured when reconciliation times out.
Probe pages retain their
timestamped observation; Check GitHub replaces it, while ordinary navigation and
Refresh do not silently discard it or perform another probe.

Lane registry status and actual session execution are separate facts. The
investigated Stop/resume bug is documented in `lane-resume-investigation.md`.
A goal acknowledgment without a running session is reported as uncertain rather
than a verified resume. Completion with a surviving terminal is reported as
cleanup pending.
Lane detail retains the Done contract and recorded close/cleanup receipt, and
reads current linked GitHub state, local worktree state, completion bindings, and
pane execution separately. Read-only detail does not execute arbitrary Done
commands or URL checks; explicit closure still runs the existing verification.

The newly requested copy cleanup and automatic retirement/capacity policy are
proposals in `workflow-followups-plan.md`. Automatic reclamation is not part of
the activated command catalog yet.

## Verification

Before gate corrections, offline checks passed: 469 Python tests, 609 inbound tests, 174 Dori tests, and
35 installed-helper tests in a disposable home. The installer and managed-update
suites also passed after the fresh-install lane-settings correction. The final
controller bundle built without installation, and both administration service
units passed `systemd-analyze verify`. Corrected-tree integration receipts are
recorded in `helio-admin-acceptance.md`.

A disposable socket running with the service's Python 3.12 accepted the owner UID,
rejected the isolated UID even with filesystem access granted, and rejected an
oversized request before dispatch. This checks Unix transport authorization and
framing, not live namespace execution. The temporary-home rehearsal also packed
and unpacked the locked package cache and completed a frozen offline install.

Offline payload and interaction tests do not prove native Discord layout or
service activation. Before acceptance, capture the actual Helio panels at
desktop/phone widths and light/dark themes, including list boundaries, filters,
details, preview, success, pending application, expiry, and revoked access.
Exercise the mounted policy update and owner/isolated service boundary on the
approved host installation when live testing resumes. The owner deferred live
testing on 2026-11-06 and confirmed that none of the supplied QA accounts is the
Helio owner. The current gate reviews implementation and offline evidence;
native-client behavior remains unverified.

`helio-admin-acceptance.md` records the command and interaction matrix, completed
offline checks, and observed external prerequisites. Its live rows remain pending
until the actual Helio application supplies the required evidence.
