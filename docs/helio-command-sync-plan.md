# Automatic Discord command synchronization

Status: implemented; source gate approved and stopped-start prerequisites
installed and verified, November 7, 2026. Native Discord execution remains deferred.
This changes Helio administration lifecycle handling, not EloBot production.

## Decision

The active administration controller owns command synchronization. It compares
the catalog compiled into its own running code with Discord and writes only
differences. Startup, update, and deployment request this same operation.

Do not publish command definitions directly from newly downloaded source:
`helio update` stages managed files, while the protected controller is installed
and activated separately. Administration deployment and activation now have their
own recorded identity, independently of intake/lead restart state. Publishing
from the updater would expose newer commands before their handlers are active.

The existing nine direct roots, 27 operations, roles, DM identity handling,
configured-server scope, and guild/DM option differences remain unchanged.

## User-facing lifecycle

| Action | Proposed behavior |
| --- | --- |
| Controller startup | Connect its handler, then reconcile DM and configured-guild catalogs in the background. An empty catalog must not prevent first startup. |
| `helio start` / `helio restart` | Once administration has been installed and enabled, ensure the deployed administration controller version is active. Restart that controller only if its deployed version changed; otherwise request reconciliation from its existing process. Preserve the existing workspace restart rules. |
| `helio update` | Finish the current managed-file update first. Request a reconciliation from the active controller. Report separately when newer administration source still needs deployment/activation; never publish those staged definitions from the updater. Preview performs no request. |
| `helio deploy` | Build/install a changed controller through the protected deployment helper, using an unprivileged build and atomic publication. Record administration activation pending separately from lead/monitor restart state. Keep the running controller and its published schema in place until activation. |
| `helio deploy --restart` | Also activate a changed administration controller when administration is enabled, alongside the existing explicitly requested restart behavior. |
| Administration unavailable | Main Helio startup/update can still succeed. Report missing installation, disabled service, or failed activation explicitly. Do not silently enable services. |

Initial protected installation and enablement remain an explicit bootstrap step.
The user's subsequent readiness instruction authorized that preparation on
November 7, 2026. Installation, enablement, and deployment are complete; the
workspace and administration services remain stopped for the user's next start.

## One publisher, small requests

Keep `admin/manifest.ts` as the definition source. Extend
`admin/registration.ts`; add no SDK, daemon, polling service, or second catalog.

For each reconciliation:

1. Read application metadata once, using the controller's current credentials.
   Reuse fresh startup metadata for the first run. Use only installation
   contexts the application advertises.
2. Read global and configured-guild command catalogs independently, requesting
   full localization dictionaries for a complete comparison. DM work must not
   depend on guild access or a successful guild-policy lookup.
3. Compare writable command definitions. Ignore server-generated IDs/version
   fields and normalize documented defaults. Treat context/install-type arrays
   as sets; preserve option/choice ordering and meaningful numeric bounds.
4. Leave matching commands untouched. POST missing commands; PATCH changed
   existing commands by ID, including explicit resets for removed optional
   settings. Match identity by name and command type within the target scope.
5. Read back a changed scope and verify its complete desired catalog. Delete
   only explicitly retired administration names, initially legacy `helio`,
   after replacements are verified. Preserve unrelated commands and command
   types; never bulk-overwrite the application catalog.
6. Save the observed result and timestamp for each scope separately.

An unchanged reconciliation normally needs three GETs including application
metadata, and zero writes. An option change updates only its affected root in
each scope. Readback costs one extra GET only for a scope that changed.

Use one in-flight reconciliation inside the controller. Startup and SIGHUP
requests coalesce; a request arriving during a run causes at most one follow-up
run. Lifecycle hooks target that controller, rather than starting competing
registrars. Existing low-level registration entry points must use this same
publisher coordination instead of keeping a separate unconditional write path.
Signal only a current controller that advertises synchronization support in its
process-bound readiness receipt. An older controller must be reported as needing
activation; sending it an unhandled SIGHUP could otherwise terminate it.

The running controller always uses its loaded definitions. Updating its bundle
on disk does not authorize an older process to publish the newer schema.
Activation receipts distinguish staged, deployed, and running versions.

## Failures and recovery

DM and guild each finish with their own result; neither scope's failure discards
the other's success. Registration status and runtime readiness stay separate.

| Condition | Behavior |
| --- | --- |
| Already matches | Record verified/unchanged; no write. |
| Guild 403 / missing authorization | Keep DM working, report the guild and Discord error, and stop requests to that denied scope for this run. Recheck on a later explicit lifecycle trigger or authorization change; no permission retry loop or alternative registration scope. |
| Invalid credentials | Stop further requests using them. Report configuration failure; prevent the systemd five-second restart policy from generating repeated authentication attempts. |
| Rate limit | Honor Discord's retry time. If it exceeds the bounded attempt budget, record when work can resume rather than delaying startup or interaction callbacks. |
| Timeout / network / server error | Keep verified successes, label unverified effects, and schedule one background retry with bounded backoff. Re-read Discord before any further write. |
| Partial update | Report changed and remaining commands. Do not claim the scope complete or delete its retired names. Resume by actual remote comparison. |
| Controller restart during work | Begin from a fresh remote comparison; do not rely on a cached success or replay a saved mutation list. |

Use a thirty-second total attempt budget and at most one pending retry timer.
Transient failures back off by one, five, then fifteen minutes, capped there,
with Discord retry times taking precedence.
Permission/configuration failures do not enter that retry loop. New lifecycle
requests coalesce with pending work. Registration must not consume the separate
interaction-response deadline or queue; give metadata its own existing REST
client instance. Preserve rate-limit not-before times across triggers/restarts,
so a new lifecycle request does not bypass Discord's required wait.

Store an atomic status JSON in the existing administration state directory.
Include application, guild, loaded schema/version, checked time, last successful
verification, per-scope result/counts, sanitized error, and next retry time.
This is an observation receipt, not authority to skip remote checks.
The exception is preserving an unexpired server-mandated rate-limit wait;
cached verification success never substitutes for comparing the remote catalog.

Expose it through existing `helio status` / `helio doctor` and administration
status, for example:

```text
Commands DM: verified, 9 unchanged
Commands guild: unavailable (403; application not authorized for configured guild)
Controller: running, deployed version active
Runtime: ready
```

When a new version is only staged, show deployment pending. When registration
succeeds but the runtime is unavailable, show both facts without calling the
whole administration feature ready.

## Implementation boundaries

- `admin/registration.ts`, `main.ts`, `transport.ts`: semantic reconciliation,
  independent scope outcomes, finite request budgets, single-publisher lifecycle,
  background retry and observation receipt. Reuse the existing REST package.
- `scripts/helio_admin_controller.py` and the controller unit: route lifecycle
  requests to the correct process and distinguish persistent configuration
  failures from restartable crashes.
- `scripts/helio_admin_install.py`, `helio_root_bundle.py`,
  `helio_isolated_admin.py`, and `helio_deploy_plan.py`: ship the fixed trusted
  builder, build as the owner, atomically install/version the protected bundle,
  and track its activation separately from intake monitors.
- Owner `sync-install.py` and the existing protected
  `helio_isolated_launcher.py` start / `helio_isolated_admin.py` restart paths:
  request synchronization after successful lifecycle actions. Preserve the host
  isolation boundary, which routine updates deliberately do not replace. Initial
  readiness setup adds a reviewed, read-only administration status delegation to
  the host wrapper; later updates retain that wrapper. Respect preview,
  temporary-home, and isolated-profile boundaries; report administration
  pending/unavailable without hiding the main result.
- Existing status/doctor readers and operator docs: expose timestamped scope
  results and deployment/activation state. Preserve current authorization.

## Acceptance checks

1. Fresh enabled controller starts with no existing commands and registers both
   accessible scopes; a guild denial still permits DM registration.
2. Running the same lifecycle twice causes zero command writes on the second
   run, including when Discord serializes defaults differently.
3. One nested option change updates only its root. Removed options/settings
   converge too. Unrelated commands and other command types survive.
4. A lost response, partial update, or process exit is recovered by read/diff;
   retired names remain until complete replacements are verified.
5. Rate-limit timing is respected; permission/configuration errors do not loop;
   interaction callbacks remain responsive during synchronization.
6. Concurrent startup/update requests coalesce. Updated source cannot make an
   old controller publish newer definitions; activation loads the correct ones.
7. Preview and temporary-home/isolated update tests make no live requests.
   Missing administration installation does not break normal Helio startup.
8. Installed-layout tests exercise lifecycle hooks and version receipts. After
   separate activation authorization, verify actual DM/guild registration and
   owner/trusted/unauthorized behavior on Discord.

Platform references checked November 7: Discord's official Application Commands
documentation (scoped identities, POST upserts, PATCH/DELETE, bulk overwrite,
global contexts) and Rate Limits documentation (403/401 handling and
Retry-After). Existing project boundaries were traced through `sync-install.py`,
`helio_admin_install.py`, `helio_root_bundle.py`, `helio_isolated_admin.py`,
`helio_deploy_plan.py`, and `helio-admin-controller.service`.
