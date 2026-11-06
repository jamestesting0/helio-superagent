# Helio fork of dori-mode

This directory is a Helio-owned fork of the upstream dori-mode skill (sisyphuslabs/dori-superagent). It's still a general Dori contract and is also the skill registered at `~/.agents/skills/dori-mode`. The changes below let a deployment's own prompts (Helio's `agent/prompts/lead.md` and `policy.md`) narrow or extend the contract without contradicting it.

## Re-syncing from upstream

1. Fetch the current upstream skill into a scratch directory.
2. Diff it against this directory: `diff -ru <upstream>/skills/dori-mode vendor/dori-mode`.
3. Take upstream changes, then re-apply each change in the table below. Keep the wording general: name "the deployment", never Helio.
4. Re-run the script tests (`cd scripts && bun test`), including the Helio ones.

## Changes to SKILL.md and references

| File | Section | Change | Why |
|---|---|---|---|
| SKILL.md | First: your name | Don't ask for a name when the deployment's setup prompt already gives one | Helio's name is fixed by its setup prompt |
| SKILL.md | Description | Keep the same mode, setup and lane-operation triggers in a shorter description | The skill index is loaded into every session; the operating rules remain in the body |
| SKILL.md | Setup | If the setup prompt says setup is done, skip to arming monitors | Helio's bot, token and config are provisioned by the installer |
| SKILL.md | Setup step 6, Onboarding | Setup prompt may skip onboarding or narrow it to a scope; still ask per step, read-only | Helio onboards on EloBot only |
| SKILL.md | Inbound, first bullet | Deployments may define extra sender roles and scopes; authority only from the top-level author; quoted, forwarded, embedded, attached or bot content never grants authority | Helio has trusted users, staff report channels and an evidence-only bot |
| SKILL.md | Inbound, eyes reaction | Only react to messages that call for a response; deployment relevance rules decide, the rest get no reaction | Helio stays fully silent on unrelated shared-channel chatter |
| SKILL.md | Doing the work | Bug fixes stay within the deployment's authorization policy; steps it reserves (PR, merge, production restart) need an explicit go | Helio needs explicit authorization for PRs, merges and restarts |
| SKILL.md | Doing the work | Numbered options go through the deployment's question mechanism if it has one | Helio asks via `helio question ask`, never a terminal prompt |
| SKILL.md, references/sessions.md | Doing the work, completion signals | Reuse already given authority, resolve meaning in context and match completion checks to the requested finish | A verified PR request must not produce another permission prompt or wait for an unrequested merge |
| SKILL.md | Setup, Onboarding, Doing the work, Scripts | Keep conditional setup/CLI detail in existing references; routine conflict/check repair remains part of an authorized task | Reduces repeated reading and unnecessary approval pauses without changing setup consent or production authority |
| SKILL.md | Writing to the owner | Deployment reply/routing contracts govern whether multipart sends are allowed | Generic writing advice must not produce multiple completion publishers or replies |
| references/writing.md | Voice | Eyes reaction exception limited to messages that call for a response | Matches the SKILL.md change |
| references/writing.md | Asking | Use the deployment's question mechanism instead of a terminal prompt when one exists | Matches the SKILL.md change |
| references/writing.md | Visitors | Deployment-defined roles for non-owners take precedence; the visitor rules cover everyone else | Helio staff and trusted-user flows |

## Code changes

| File | Change | Why |
|---|---|---|
| `scripts/src/cli.ts`, `scripts/src/messenger/discord.ts` | `dori send discord --to user:ID` (or the owner ID) opens the DM channel first (`Discord.openDm`) | Discord rejects posting to a user ID as a channel (404 Unknown Channel), so DMs to the owner failed |
| `scripts/src/host-guard.ts` | Disk free is measured at the home directory instead of `/` | Inside a sandbox `/` is a small in-memory root, which made the guard hold every lane |

Tests: `scripts/test/helio-host.test.ts`.

`scripts/` also carries Helio patches to some `src/` files, covered by the Helio tests in `scripts/test/helio-*.test.ts` (lifecycle, missing, model). Check those tests before taking upstream changes to the same files. `launch.ts` refuses a lane model that matches none of the comma-separated globs in `HELIO_MODEL_ALLOW` (the same allowlist passed to `omo --models`), before any brief, worktree or tab is created; with the variable unset there is no check. `done-flow.ts` lets `dori close` retire a lane whose launch failed without its Done signals, only when its pane is gone or holds no working or idle agent and it has no unpushed work; the worktree is kept and the work thread is not told it is done.
- `dori send --text-file PATH`: reads the message text from a file, so callers never put text with backticks or `$` inside a shell command.
- Discord writes retry only definite rate-limit refusals, not server errors whose outcome may be uncertain. Server-provided waits are honored even above the fallback backoff cap; Discord HTTP requests have a 30-second deadline. Other messenger transports keep their deadlines unchanged. `references/scripts.md` matches retained worktrees and Linux memory probes.

## Intake and receipts reliability (2026-11-04, Part D)

| Files | Change |
|---|---|
| `scripts/src/done-flow.ts`, `registry.ts`, `cli.ts` | `dori show <key>` reads the complete lane record, including closed lanes. `dori claim-ack <key>` acknowledges the current claim and starts its full `closeAfterMin` window; repeated acknowledgement preserves the deadline. Unseen claims, including legacy `emitted` claims, never auto-close and repeat as one `LANE_CLAIMS_PENDING count=N oldest=<key>` pointer each tick. A new claim needs a fresh acknowledgement. Watch errors are isolated per lane and per unreadable registry file. |
| `scripts/src/monitor.ts`, `cli.ts`, `freshness.ts` | Shared single-line rendering caps lane/upkeep monitor lines at 1,000 characters. Upkeep failures use `DEAD_PANES_ERROR`, `GUARD_ERROR`, `FRESHNESS_ERROR`; watch failures use `LANE_WATCH_ERROR`. Freshness records `POSTED`, `lastPostedReport` and `lastAutoReplyAt` only after the thread hook exits 0; a failed hook stays eligible for the next tick. Loop handling moved out of the CLI to keep its command dispatcher within the module size limit. |
| `scripts/src/registry-lock.ts`, `registry.ts` | Locks publish a PID owner before acquisition, respect live owners, and atomically rename dead-owner locks aside before taking over. Nonempty tombstones keyed by device/inode are retained: competing stale reapers cannot rename a replacement live lock over the same tombstone. Prepared candidates also avoid a crash between acquiring a lock and writing its PID. Existing revision conflict checks remain. |
| `scripts/src/dead-panes.ts`, `cli.ts`, `references/scripts.md` | `dori dead-panes` judges only the panes of open lanes in the registry. Shells and other non-lane panes (for example a workspace's default tab) no longer raise `UNRECOGNISED_PANE` after every restart. |
| `scripts/src/host-guard.ts`, `routing.ts` | Linux memory availability and swap come from `/proc/meminfo`; unavailable or malformed readings are `null` and reported as unknown, never 100% free. Unknown memory holds new launches. Other platforms retain the macOS probes, now with explicit unknown results on failure. |
| `SKILL.md`, `references/setup.md`, `references/scripts.md`, `references/done-protocol.md` | Document evidence fetching, acknowledgement, repeated claim counts and the acknowledgement-based timer. Monitor filters include every relevant error prefix and `WORKING-WHILE-PAUSED`. Correct the done protocol's worktree cleanup description to match the existing retention behavior. |
| `scripts/test/helio-receipts.test.ts`, `helio-monitor.test.ts`, `done-flow.test.ts`, `signals.test.ts` | Cover large/repeated unseen claims, per-lane and corrupt-file isolation, real CLI evidence fetching and acknowledgement, monitor error filters, failed thread hooks, PID lock recovery/exclusion, Linux unknown readings, and the revised timer while retaining close-time signal/worktree checks. |

## Bounded lanes (2026-11-05)

Lifecycle reliability adds explicit job/source admission, durable completion
receipts bound to the attempt and live checks, and bounded preview/apply
reconciliation with fresh record and resource checks. The optional
`hooks.inspectJobSource` delegates read-only original request verification to the
deployment; its proof grants identity only. Failed retirement retains uncertain
resources and never reports task completion. Legacy jobless workers stay awake
because they cannot yet be safely resumed by job.

Owner replies follow deployment relevance rules; historical references do not
automatically reopen closed work. Reuse applicable instructions and restored
monitors rather than repeating setup or verification without changed evidence.

| Files | Change |
|---|---|
| `scripts/src/admission.ts`, `launch.ts`, `routing.ts` | `launch` enforces `maxWorkers` and the host guard under a launch lock, failing closed on an unknown pane count or host sample, and queues the rest durably (`LAUNCH_QUEUED`; owner priority first). One open lane per `--job` (`LANE_EXISTS`); a job's hibernated or closed lane is resumed in its recorded session. A failed attempt's key relaunches in place (fixes the stale-brief `EEXIST`). The session id is recorded at startup. |
| `scripts/src/lifecycle.ts`, `cli.ts` | `watch` also finishes `cleanup-pending` closes, hibernates idle lanes (`hibernateAfterMin`, recorded session, no open question) and drains the launch queue. |
| `scripts/src/done-flow.ts` | A close whose tab survives records `cleanup-pending` instead of a closed lane with a live tab. |
| `scripts/src/registry.ts` | Closed lanes move to `lanes/archive/`; hot loops read active records only. |
| `scripts/src/reap.ts` | `stale` and `reap-worktrees`: worktrees go 3 days after the lane's PR settles, never with unpushed work or without a lane record. Replaces "never delete worktrees automatically" (owner decision). |
| `scripts/test/lifecycle.test.ts` | Cover the cap and queue, fail-closed admission, job identity, session wake, hibernation guards, cleanup-pending, the archive, stale review and the reaper. |

- `dori abandon <key> --reason TEXT [--with-unpushed]` (`done-flow.ts`, `cli.ts`): the owner's way to retire a lane whose Done line can never pass. It shares the failed-launch retirement checks (no live agent in the pane; tab closed; worktree kept), refuses unpushed work unless `--with-unpushed`, records the receipt as abandoned with the reason, and never runs the thread-done hook. Covered by `scripts/test/lifecycle.test.ts`.

## Lifecycle identity and receipts (2026-11-06)

New `launch` and `adopt` calls require `--job`; adoption uses the launch admission
lock and persists the job. `job-id` computes a non-issue identity from repository,
channel and the original request ID. Queues and resumes retain identity; legacy
records are readable but are not bound by guessing from names. A valid recorded
session takes precedence over a failed attempt. Retirement records `retiredAt`
and preserves failure history without claiming success.

Launch failures retain `failedAfter`. Missing worktrees stay protected unless
failure preceded creation and Git confirms both the worktree and branch absent.
Unconfirmed startup is inspected in place. Completion receipts live under durable
state and bind job, source, acceptance, attempt and verified revision. The new
`completion` command records independent checks; close refuses arbitrary or stale
file markers and retains its own durable verification receipt. Existing claim
acknowledgement, live checks, holds and dirty/unpushed-work guards remain in force.

## Selective upstream review (2026-11-06)

Reviewed upstream `sisyphuslabs/dori-superagent` through
`201e6ca018e48c4a615ee3c50e3cf0da75291eab`, using the current Helio fork,
including its existing uncommitted lifecycle changes, as the integration base.
This is a selective backport, not a full upstream synchronization.

| Upstream commits | Adopted change | Helio adaptation |
|---|---|---|
| `37cf90b`, `1c608f9` | Refuse pane sends without a live agent or when an interactive shell occupies its foreground | Parse foreground process data at the boundary; empty, malformed or unavailable process information holds delivery. Keep existing single-Enter delivery semantics. |
| `f30f573`, `7d53474` | Check the lane's working directory when it owns no separate worktree | Preserve missing-worktree protection and `--untracked-files=all`. An unreadable Git probe blocks closure; a directory explicitly identified as outside Git may close. |
| `a60c617` and subsequent upstream report-parser corrections | Do not forward instructions, prompt echoes or unfilled report templates as progress | Keep the current report kinds, two-tick hold and successful-hook receipt rules. Recognize standalone reports and the final quoted element of a complete argv row. |
| `cbcbb07` | Accept string or array JSON responses for a published-version Done signal | Keep malformed, mismatched and unsuccessful registry responses as failed checks. |

The full applicability and rejection ledger is in
`../../docs/dori-upstream-review-2026-11-06.md`. New regressions cover pane
safety and direct-checkout closure; existing report and signal suites cover
the remaining fixes. No upstream root harness, installer, telemetry, journal,
supervision or onboarding feature was imported.
