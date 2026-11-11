# Issue plans (opt-in) and direct implementation

## Implementing without a plan

Resolve task identity first under issue-truth-workflow.md. Related closed issues
stay historical; new work uses a linked new issue. Authorize and plan the new
number from the current request, never from a completed issue's old approval.

An owner's or trusted user's request to implement an issue ("implement #8", "proceed" or "yes"
replying to your proposal to implement it) is one decision covering the work and its PR. Record and
launch it immediately: `helio work start --issue N --message M --channel C [--note-file F]`. It removes
`needs-owner-review` and launches the lane with a rendered phase brief. The job's Done is the PR
being ready or merged; a managed worker phase ends at verified custody handoff.
Add `--hold no-pr|no-push|no-commit` only when the requester's own words ask for it; a held
lane verifies locally and waits, and a later clear request ("make the PR") recorded with
`helio work authorize` lifts it. `helio work start --issue N --from-authorization` relaunches from the
recorded request (backstop events, failed launches). A genuine blocker: `helio work block --issue N
--reason TEXT`, then one question to whoever can decide; a newer request supersedes the block. The receipt survives intake acknowledgement, restarts
and elapsed implementation time. Its creation receipt is marked used after verified PR creation;
that does not revoke authorized updates to the same PR. Never ask separately for the commits
and ordinary pushes needed to implement or revise the requested work.
Receipts are per issue: when one human request clearly covers several tasks, record each
resolved issue. Completing one task does not revoke the other tasks from that request.

Decide intent and the issue from the permitted conversation before invoking the command.
A request can ask for a separate PR before its issue exists, contain a side question or rule out
a workflow. These do not cancel the instruction. Do not record a conditional suggestion or a
cancelled request as authorized work. The helper checks source identity, trust, location and
integrity; it does not decide the meaning of English. Before a new PR it rechecks the current
source against the recorded fingerprint. Accepted legacy sources without a fingerprint must
still be unedited on Discord. Inspect a changed or unavailable source instead of asking for
the same clear decision again.
The scope is the current issue body (`helio issue show N`): build its confirmed requirements and leave
its open questions out. The lane follows the brief below without the plan check; its result file has
one `scope` row per confirmed requirement, `deviation` for anything left open, which makes the PR
`Refs #N` and keeps the issue open. A work authorization never approves a merge or restart.

## Revising an existing PR

A direct owner/trusted instruction such as "remove that fact", "fix this in #14" or
"change the copy" in the PR's conversation requests the revision, including its
necessary commit and non-forced branch update. Resolve the target from permitted
context and lane records. For an open issue, record the new source with
`helio work authorize` for that issue. For closed history, first resolve the
linked new issue under issue-truth-workflow.md. Carry its current scope/limits
into the existing PR lane and update through `helio pr submit`. Do not ask
"may I commit?" or "may I update the PR?"
after that request. If plan mode applies, clear explicit feedback can authorize
the revised scope through `--from-message` and `--resolved-approval`; do not ask
the same decision twice. Proposals, ambiguous targets and explicit publication
holds still need resolution. A real denial, conflict or changed source is a
fact to diagnose, not a reason to invent a missing approval.

## PR recovery and readiness

New jobs admitted with `HELIO_PR_CUSTODY=on` carry a phase descriptor. Follow
their generated brief: create the exact active phase goal, acknowledge it with
`helio pr phase start --issue N --generation G`, implement, then submit.
Submission owns the full integration suite and returns a verification ID.
Transfer waiting with `helio pr wait --issue N --generation G --verification ID`;
check `helio pr phase check --issue N --generation G` before completing that
worker goal. `PHASE_HANDED_OFF` finishes the phase while CI remains pending.
The controller safely releases the worker, observes CI, schedules bounded
infrastructure recovery, and resumes the same session with a fresh generation
only for actionable repair. Workers never rerun CI, wait for CI, claim job
completion or close the lane after handoff.

`FOLLOWUP_PR_CUSTODY` is a durable internal event. Read its `read` command,
reconcile its current generation/status, then acknowledge its event with the
supplied `ack` command. Acknowledgement records delivery, not completion or new
authority. `helio health --json` exposes custody, next owner/probe and last
meaningful progress. Repeat observations do not warrant repeat announcements.
An unavailable lead leaves events pending. Admission off affects new jobs;
existing custody continues, including pending repair and settlement. Rollback
keeps the new handlers until all managed work settles or custody is explicitly
transferred.

An authorized task includes routine repair until its PR is usable. Fetch main
on launch/resume and before submission; the isolated checkout does not inherit
owner pushes. Merge current main into the task tree, preserving both intents.
If Git stops at conflicts, inspect the conflicting code and tests, resolve and
commit in that tree, then resubmit. A conflict is not a request for permission.
Do not switch, reset or stash someone else's shared work.

`helio pr submit` merges main before its integration suite and rechecks main
before publication and delivery. If main moves, incorporate it and verify the
new head through the same submission. A non-fast-forward push means inspect the
remote's new commits and reconcile them; never force-push or open a duplicate PR.

`helio pr check --number N` reads the current head, main ancestry, mergeability
and CI. The existing follow-up monitor checks open canonical `helio/` PRs every
five minutes, even after the worker closes. `FOLLOWUP_PR_REPAIR` is internal work:
read its command, resolve the issue/lane and original authority, then resume that
job. Repeated events while repair is running need no second lane or human reply.
`FOLLOWUP_PR_WAIT` means a named check or GitHub calculation is pending;
subscribe to its change. `FOLLOWUP_PR_READY` supplies the observed head/base;
announce only a new result the requester is waiting for.

For failed CI, inspect the failed run/job logs, reproduce the cause, fix the task
or integration regression and resubmit. Diagnose unavailable infrastructure or a
pre-existing failure before escalating; do not skip, weaken or disable checks.
An actual product-intent conflict needs one question explaining both intents and
what you tried. Preserve explicit holds and original autofix scope/path/size
limits; a monitor event never grants broader authority.

Report after repair, or when a diagnosed blocker needs a human/resource. Keep
required progress updates concise. Say which head and main revision were checked
and whether CI passed, remains running, or is blocked. Repairing a published head
invalidates approvals pinned to its old head; merge/restart checks still apply.

## Opting into a plan

Use plan mode only when the owner or a trusted user asks for a plan or to finalize an issue
("finalize #4", "plan #4 first", "put the plan on the issue"). Finalizing means: post the plan
and wait. It never means building. Other requests and standing autofix work as usual.

The plan is a one-minute read that lets a person confirm you understood the request and are
heading the right way. It is not an implementation plan; your lane keeps its working steps
private. The approved plan is the contract the PR is checked against.

## Steps

1. Record the planning source before acknowledgement:
   `helio plan request record --issue N --message M --channel C`.
   This preserves planning consent across clarification and restarts without authorizing implementation.
   Clarify first. Ask open questions in the conversation; the plan's "Needs your answer"
   section is only for what is still undecided when you post.
2. Write the plan as JSON fields (below) to a file, run the self-check, then post:
   `helio plan post --issue N --file PLAN.json --announcement-file OUT.txt --request-message M`.
   `--request-message` (the owner's or trusted user's request) is needed only for the first post.
   First posting also records a still-pending source for compatibility. An acknowledged source
   without a receipt cannot be reconstructed. Identical retries return the same revision and
   recreate OUT.txt; changed content still needs a change note.
3. Post OUT.txt with buttons in the request's conversation, or in the staff chat for staff-initiated
   work: `helio confirm plan --issue N --revision R --text-file OUT.txt --channel C --reply-to M`.
   It replaces the buttons of any earlier revision. If the requester cannot approve, also reply to them:
   "I've written up a plan for <issue link>; the team will review it."
4. On `INBOUND_CONFIRM` with outcome `approved`, run `helio plan approve --issue N --confirmation ID`;
   for a typed approval you have interpreted in context run `helio plan approve --issue N --message M --resolved-approval`.
   `INBOUND_PLAN_FEEDBACK` is a reply to the plan message with suggested changes (`helio confirm feedback ID`): revise and post
   again with `--from-message M`. If that reply also said to go ahead ("6 hours instead, then go"),
   approve the new revision with `helio plan approve --issue N --message M --resolved-approval` without asking again.
   A side question or method constraint does not cancel clear approval. Suggestions, unresolved scope,
   conditions and cancellations are not approval: resolve them before invoking approve.

`helio plan show` and `check` only inspect. An edited GitHub plan needs explicit
`helio plan adopt --issue N`; adoption preserves the human text and resets approval.
Use `helio plan request cancel --issue N --message M --channel C --from-message X`
for an explicit permitted cancellation. `helio plan drop --issue N` also cancels
accepted unpublished planning. A cancelled request never rearms itself.
`PLAN_PENDING` (exit 2) retains work after a busy issue, interrupted read or uncertain write.
Resume the same command; the existing follow-up pass reconciles saved effects.
Never send a second comment merely because the first response was lost.
Only announce publication after `PLAN_POSTED` verifies the revision, URL and label.
   The flag records your interpretation; it cannot bypass identity, source, recipient, issue or revision checks.
   Legacy callers without the flag retain the conservative parser. Production approvals do not use this flag.
   On `PLAN_REFUSED`, inspect the failed fact and recover within existing authority; ask only for a real missing decision.
5. On `PLAN_APPROVED`, launch the lane with the brief below. Approval covers commit, push and PR;
   do not ask again.
6. Plans awaiting approval are counted in `helio status` and the greeting.

Lane brief (include the approved fields from `helio plan show --issue N --json`):
1. Run `helio plan check --issue N`; stop unless it prints `PLAN_APPROVED`.
2. Use the lane's task worktree and `helio/` branch; `helio/issue-N` is a default for new work,
   not a requirement to rename an existing lane. Include current `origin/main` in that tree.
   Build exactly the approved Scope; add
   regressions for changed behavior. Use direct `ulw`, sized to the actual change, unless the
   requester selected another method. Do not create a planning pipeline merely to launch a lane.
3. Live beta only if the plan says "Requested by"; otherwise none.
4. If the work needs unrequested scope, decisions or Done-when changes, report the missing
   decision. A clear authorized follow-up already supplies its requested correction; the lead
   records that scope/source without another permission round. Mechanical details need no approval.
5. Write a result file, one entry per Scope row and per Done-when item, in order:
   `{"scope": [{"status": "met", "evidence": "test_name"}], "done_when": [...]}` (status `met` or
   `deviation`), and a report from [GitHub writing](github-writing-workflow.md). Then run
   `helio pr submit --issue N --result-file RESULT.json --report-file REPORT.json`.
   Run focused checks while implementing; `pr submit` owns its full-suite integration gate.
   Do not immediately repeat a passing full suite. Submission discovers the matching task worktree
   independently of the shared checkout and interpreter. Named lane branches are valid:
   run from the actual task tree, or pass its recorded `--worktree PATH` from the lead/shared tree.
   Without either, only a unique issue-numbered tree is a discovery fallback.
   Keep unrelated shared changes untouched. It handles normal branch
   updates and verifies the actual remote, PR head and latest main. An existing PR is updated when necessary;
   its URL alone is not success. Failed or uncertain creation does not spend authority before
   read-back establishes the PR and intended head. Do not create a duplicate to recover.
6. For a managed phase, follow the custody handoff above and finish its exact worker goal.
   For a legacy lane, run `helio pr check --number PR_NUMBER` using the published PR's number; resolve failed checks/conflicts before claiming
   readiness. Pending CI may be reported accurately while its watcher stays active.
   Return the result, verified head/base, checks and evidence paths privately to the lead, then claim
   done. The lead sends the routed completion once; do not also send it through evidence.ts.

Revisions: post again with `change_note` ("window 8 to 6 hours"). A content change prints
`PLAN_APPROVAL_RESET`; send the new announcement and ask for approval of the new revision.
Hand edits on GitHub are adopted automatically as a new revision (`PLAN_ADOPTED`): send its
announcement for approval; do not ask whether to adopt. `helio plan drop --issue N` ends plan mode when asked.

## Fields

| Field | Limits | Rule |
|---|---|---|
| `title` | 70 chars | The outcome, not the task: "Shorter match confirmation window", not "Refactor timer". |
| `size` | Small, Medium or Large | The appetite. |
| `live_beta` | | "Not planned", or "Requested by <name>: <what>" only when someone asked. |
| `in_short` | 40 words | The result for users in plain words; describe the outcome, not "I will". |
| `why` | 1-3, 25 words each | The problem and who it affects, with the requester's name. |
| `scope.changes` | 1-6 rows, 80 chars per cell | `where`, `today`, `after` in user words: commands, buttons, messages, rules. Internal-only work is one row "No visible change" with the reason. |
| `scope.not_included` | 0-3 | Only what a reader could plausibly expect but won't get; never filler. |
| `decisions` | 0-6 | `question`, `decision`, `decided_by`: a name, or "Helio" for your own call (shown with a flag). |
| `open_questions` | 0-4 | Any open question makes the plan a draft that cannot be approved. |
| `done_when` | 0-4, 120 chars | Extra outside-visible checks the Scope table does not already say (edge cases, what stays unchanged). Scope rows are checked in the PR automatically. |
| `risks` | 0-3 | `level` (Low/Medium/High), `what`, `mitigation`. |
| `technical_notes` | 600 chars | Optional, collapsed: areas at module level, data changes, test approach. No code. |
| `change_note` | 120 chars | Required from revision 2. |

The word/character targets and language recommendations above are editorial advice,
not posting gates. Keep plans readable, but do not rewrite useful content merely to
satisfy a style counter. `PLAN_ADVICE` is non-blocking. `PLAN_INVALID` names malformed
fields or actual rendered-comment overflow; the complete GitHub comment must fit
65,536 characters, including encoded metadata.

## Self-check before posting

1. Would the requester recognise their request in `in_short`?
2. Is every Scope row in user language?
3. Is every decision you made yourself marked "Helio"?
4. Is there a tempting extra a reader might expect? Name it under `not_included`; otherwise leave it empty.
5. Can each Scope row and Done-when item be checked without reading code, and does Done-when add
   only what the table does not say?

Good `in_short`: "Players get 8 hours instead of 24 to confirm a match, with one reminder before it
expires." Bad: "I will refactor the confirmation timer in the match service and add a scheduler job."
Good Done-when: "Matches created before the change keep their 24 hours." Bad: "The 8-hour window
works." (repeats a Scope row).

## Outputs

`PLAN_POSTED`, `PLAN_ANNOUNCEMENT_FILE`, `PLAN_APPROVAL_RESET`, `PLAN_INVALID`, `PLAN_AUTOFIX_ACTIVE`
(an automatic fix PR is open: stop it or point to it first), `PLAN_APPROVED`, `PLAN_AWAITING`,
`PLAN_DRAFT`, `PLAN_EDITED_OUTSIDE_HELIO`, `PLAN_NONE` (not in plan mode: work as usual),
`PLAN_DROPPED`, `PLANS_AWAITING count=N`, `PLAN_PR <url>`, `PLAN_REFUSED <reason>`.
