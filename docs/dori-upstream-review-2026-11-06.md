# Dori upstream review, November 6, 2026

Reviewed `sisyphuslabs/dori-superagent` main at
`201e6ca018e48c4a615ee3c50e3cf0da75291eab` (PR #111).
The review used a separate temporary clone and compared upstream
`skills/dori-mode` against this working tree. Helio first imported the vendor
in `ce14e86`; that import did not record an upstream revision. The review
therefore covered the upstream history and complete file differences rather
than assuming that a date or a recent commit list was a sufficient baseline.

The working tree already contained substantial changes, including lane identity,
reconciliation and completion receipts. Those changes are integration inputs,
not part of this backport. No full synchronization or deployment was performed.

## Adopted fixes

| Change | Evidence of a Helio defect | Implementation and retained protections |
|---|---|---|
| Live-agent and foreground-shell checks, `37cf90b` (#69), `1c608f9` (#94) | `sendVerified` typed text and pressed Enter after a failed status lookup, with no agent, or while a suspended agent's shell occupied the foreground. Nudge, objection and goal-control callers all use it. | Require an alive status and readable foreground processes before typing. Hold interactive shells, including BusyBox shells and PowerShell command invocations that retain a prompt. Noninteractive command wrappers remain supported. Malformed process records are held rather than cast into a trusted shape. |
| Direct-checkout dirty/unpushed checks, `f30f573` (#39), `7d53474` (#43) | `unpushedWork` inspected only discovered lane worktrees. A lane working directly in its `cwd` could close with uncommitted or unpushed work. | Inspect `cwd` when no owned worktree exists. Retain explicit missing-worktree checks, untracked-file checks and close/abandon protections. Unlike upstream's broad skip on a failed Git probe, unavailable or unreadable Git blocks closure. An explicit non-repository result may proceed. |
| Anchored report parsing and placeholder rejection, `a60c617` (#25) and later upstream corrections | A repeated instruction, prompt echo or standalone `$message`/`%s` template could replace a genuine report and be posted to a work thread after the two-tick hold. | Accept a standalone report or the last quoted element of a complete argv row, including a spawn call. Reject prose, prompts and placeholder-only bodies. Preserve ordinary variables in real report text, supported report kinds, the two-tick hold and successful-hook receipt handling. |
| Published-version JSON parsing, `cbcbb07` (#105) | A valid version array was compared as stripped text and failed the existing `published` Done contract. | Decode the JSON and match the exact version in a scalar or array. Wrong versions, objects, invalid JSON and command failures remain false. This repairs an existing generic CLI capability; it does not add an npm release workflow to EloBot. |

## Reviewed but not imported

| Upstream area | Decision and reason |
|---|---|
| Linux memory probe, `0e2994b` (#91) | Already covered more strictly. Helio reads Linux memory and swap from `/proc/meminfo`, represents missing measurements as unknown and holds launches. Upstream substitutes 100% free on some probe failures and defaults disk measurement to `/`; importing it would weaken the sandbox-aware guard. |
| Persistent-goal startup check, `8767205` (#51), `31778a6` (#83) | Defer. Upstream waits for text in the last three screen lines, with an 80-second total wait, and adds a configurable marker. That can be hidden by a changing footer, quoted by unrelated output, or disappear after fast completion. Helio also resumes recorded sessions through this path. Ready status alone remains insufficient proof of an active persistent goal, but the upstream screen heuristic has not been established as reliable for Helio. Its malformed-marker fix is irrelevant until the feature is adopted. |
| Durable lane reports, `4130b23` (#30) | Defer as a workflow/storage change. It changes worker brief instructions, report commands, registry fields and freshness behavior. Importing it alongside Helio's existing completion and conversation receipts would create another state owner without a migration or measured benefit. The independent screen-parser fix was taken. Upstream also records a thread post after a failed hook; Helio's existing successful-hook requirement was preserved. |
| Boot/restart inspection, `0086e77` (#37), `b41480b` (#72) | Defer. It depends on upstream reports and worklog, Slack authentication and monitor manifests. Its finished rule includes a report journal's `done` state, which is a worker claim rather than Helio's verified completion. Helio already has startup recovery, doctor and bounded lane reconciliation. |
| PR verification, `e9c76b7` (#44) | Do not add a second readiness gate. It checks configured commit identities and infers test requirements from `fix:` subjects and changed filenames. Those checks cannot establish that a regression test observes the fix; the generated UI loop assumes Bun. Helio already has submission, PR readiness and release checks. |
| Lane budgets, checkpoints and cost recording, `4ea8bd1` (#61) | Defer as a workflow change. It adds new journals, hooks, registry fields and screen-timer/activity heuristics. Helio already has admission limits, hibernation, durable attempts and completion receipts. No demonstrated need or subscription-compatible usage source justifies the added state here. |
| Repository lessons, `06c4600` (#65) | Defer. Adds a second learning store and injects its rules into worker briefs. Canonical `cwd` scoping also treats separate worktrees as separate repositories. Helio already shares memory; no migration, benefit measurement or instruction-trust contract was established. |
| Lead worklog, `067b70f` (#96) | Defer. Adds another durable request ledger alongside existing intake, conversations, issues, follow-ups and lane jobs. Adopting it requires a decision about ownership and recovery, not copying a utility. |
| Reserved `lead` lane key, `8ec7729` (#101) | Not needed independently. Its stated invariants concern upstream lesson records and lead-only checks that Helio does not import. Helio identifies its lead by `leadPane`, and lanes use explicit jobs. Legacy records remain intact. |
| Telegram polling and media/edit handling, `bdfaea4` (#76), `d82d153` (#79) | Not applicable to Helio's Discord intake. Adding a second intake transport would add polling, ownership and acknowledgement responsibilities. |
| Root harness ambiguous delivery and inbox locks, `f27d8c2` (#102), `201e6ca` (#111) | These change upstream root `src/{harness,herdr,store,cli}.ts`, not the vendored skill CLI Helio runs. That inbox and its replay path are absent here. Do not transplant its store or delivery state machine into Helio. The shared foreground-shell defect was separately fixed in the skill. |
| Root loop/duty stop, status and scheduling fixes, including `315c814` (#53), `31ec559` (#103) | Not applicable: Helio does not run that root loop or duty scheduler. Their flags and status strings are not the Helio monitor contract. |
| Root installer/bin mode fixes, `2b5687c` (#46), `248c291` (#49), `0c62916` (#84), `766630f` (#85) | Not applicable to Helio's Python installer and baseline-checked updater. No upstream shell installer was introduced. |
| Root harness fake-session isolation, `b3fe0c9` (#86) | Changes tests for the absent root harness; it does not repair a failure in Helio's vendor tests. |
| Lock-holder test ordering, `90f02c1` (#68) | Its target lock/test implementation is not Helio's PID/inode registry lock. Retain the existing dead-owner recovery, live-owner exclusion and revision checks. |
| Root telemetry, container recipes and generic onboarding/prompt expansion | No demonstrated harness fix. Telemetry and root container/install behavior are outside this kit's runtime. Helio's configured identity, authority, question routing, model allowlist and provisioning remain deployment-owned. |
| Raw-output runner option | Used by the unimported supervision activity parser. No existing Helio caller requires that option, so adding it would be unused API surface. |

## Verification

Before production changes, the existing vendor suite passed all 125 tests.
The new candidate regressions then produced 36 failures against unchanged
production code, demonstrating the unsafe-send, direct-checkout, false-progress
and publication-array defects.

Tests use disposable state and external-command fixtures. The installed
`herdr pane process-info --help` confirms the supported `--pane` interface.
No live Discord delivery, production restart or installed-home update is part
of this review. Final check results are reported with the completed change.

The final vendor suite passed 173 tests across 19 files, and its local
TypeScript compiler completed with exit code 0. The complete offline Python
suite passed 450 tests; Discord intake passed 584 tests. A disposable isolated
installation passed all 35 browser-env,
thread-target and reply helper tests. A separate CLI exercise confirmed that
`object-done` sends only to a live foreground agent, `close` retains direct
checkout work, `freshness` rejects repeated instructions and forwards a real
report, and a publication array permits verified closure. That exercise used
the actual CLI and registry with fake external services, never a live bot.
The pristine upstream skill also passed its own 299 tests; this is not an
assertion that its larger features fit Helio.

Review also reproduced and corrected an error-classification flaw in the
backport: a dubious-ownership error mentioning a directory named
`not a git repository` must block closure. Only Git's explicit non-repository
diagnostic permits the non-Git exception. The final suite includes that case.

The pane guard checks observed process state before a send; it cannot make
Herdr's separate inspection and typing operations atomic. Ambiguous delivery
remains unconfirmed and must not be blindly resent. The upstream root inbox
redelivery fixes do not provide that atomicity for this separate CLI.
