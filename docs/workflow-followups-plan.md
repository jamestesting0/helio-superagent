# Issue copy and automatic worker retirement

Requested November 6, 2026. Findings and proposed changes only; no live worker,
queue entry, GitHub comment, issue, or worktree was changed.

## Issue text and formatting

The first screenshot shows one comment with its heading repeated in the comment
body, rather than two copies of a GitHub comment. Both variants are present:
`Issue updated: Issue updated: ...` and `Issue updated: Issue updated with ...`.

The renderer in `scripts/helio_issues.py`, `Issues._finish`, always prepends
`**Issue updated:**` to the caller's note. The note contract does not prevent
callers from including the same introduction. The issue-truth runbook asks for
an “Issue updated” comment without saying that the renderer owns that heading.
This is a boundary/ownership problem.

Keep one renderer responsible for the label. Define the note as the substantive
change alone. For example:

```text
Issue updated: Require a durable Final match schedule and preserve its recorded date.
```

The implementation should:

- Render new issue notes from a content-only change summary and a single fixed
  heading. Clarify the CLI/runbook contract at the input boundary.
- Canonicalize the two demonstrated legacy introductions at that boundary,
  before deriving a new operation identity. Do not rewrite persisted operation
  requests or deduplication markers.
- Keep substantive user wording intact. Do not apply a general “remove repeated
  words” regex to issue bodies, quotations, or comments.
- Preserve the existing operation marker and comment reconciliation, so a
  retry does not post another public comment.

The adjacent renderer audit found two other places to review with concrete
fixtures: the issue status block includes a last-note fragment beside its
timestamp, while the public update comment already explains that change; and
`helio-plan.py` and `helio_issues.py` both render labeled summary fields. Their
labels are structurally useful, so they should remain unless a fixture shows the
input repeating the label. Normalize labeled summary inputs once, not through
separate patches in every output template.

Use a short output contract: one title, one state, one substantive change, one
timestamp where useful, and links in their own location. Keep machine markers
out of visible prose. Test repeated prefixes, ordinary notes, quoted phrases,
Markdown, Unicode, retry after an ambiguous comment response, and existing
pending operations. Review representative issue body, update comment, progress
comment, plan summary, and Discord acknowledgment together.

Existing historical comments should remain historical unless the owner
separately requests edits.

## Automatic retirement and capacity

The second screenshot and the current queue record identify issue #15 at queue
position 1. The observed queue entry was created at 20:32:12 UTC on November 6,
2026 with owner priority. No queue or worker mutation was attempted here.

The current code has four distinct mechanisms:

- `admission.ts` counts occupied worker slots and refuses launch at capacity.
  Queue draining stops as soon as any capacity/host limit remains.
- `lifecycle.ts` hibernates only `working` lanes whose pane reports `idle`,
  after the configured idle interval, with a saved session and no open
  question. It does not evaluate GitHub issue completion.
- `done-flow.ts` closes verified completed work through completion checks.
  Its separate failed/abandoned retirement path refuses any pane with an
  agent in an “alive” state, including an idle agent.
- `reap.ts` removes only clean worktrees of already-closed lanes after a
  three-day settled-PR grace period. This does not reclaim an occupied worker
  slot.

Age alone is therefore insufficient, and the current “agent is alive” refusal
does not distinguish a busy worker from an idle session that can be checkpointed
and retired. The exact live-agent identity must be checked, not bypassed.

The observed `issue4-stats` record explains the specific dead end. It was opened
on November 4 at 14:25:49 UTC, has a surviving pane/tab, has no job binding, and
its only Done signal is `file /tmp/helio-issue4-verified.json`.
The hibernation loop skips every lane without a job. The current completion
contract rejects file-only acceptance without independent evidence. The
abandon/retire path then refuses the still-live agent. Changing the timeout alone
will not fix these three incompatible lifecycle contracts.

### Proposed policy

Use 24 hours as the normal completed-worker retirement grace period. Apply
capacity reclamation immediately when an authorized launch or queue drain needs
a slot. These are separate policies:

| Candidate | Normal maintenance | At worker capacity |
| --- | --- | --- |
| Verified completed work; linked issue still closed; no remaining obligations | Retire its owned session after 24 hours | Reclaim its slot immediately |
| Unfinished, idle, checkpointed work with no pending answer or active operation | Existing idle hibernation | Hibernate an eligible session early and retain resumable work |
| Legacy lane missing a job binding, but with a verified owned idle session and a recoverable checkpoint | Preserve completion as unknown | Allow resource-only hibernation; retain its original context and artifacts |
| Busy unfinished work, unresolved answer, objection, unverified completion, or changed session binding | Keep it | Keep it and report the blocking reason |
| Unreadable GitHub, Git, session, or question state | Keep it | Keep it; do not treat missing evidence as completion |

An issue closing starts eligibility review; it never proves that every lane
bound to that issue has finished. A closed issue can still have an unfinished
verification or requester follow-up. A reopened issue or new authorized work
invalidates the prior retirement decision.

Release the worker slot by checkpointing and closing the owned terminal/session.
Retain the branch, worktree, local files, completion evidence, and session ID.
Keep worktree deletion under the existing separate three-day cleanup policy.
No force deletion, automatic abandonment, or per-worker approval is needed for
the eligible session/slot operations under the approved policy.

Handle legacy lanes explicitly. Reconstruct their issue/job/source binding only
from existing authorization records or authoritative retained context, never
from a title or branch-name guess. Until then, a resource-only checkpoint may
free an eligible idle session's slot, but it must not mark the work complete or
automatically launch new work in that old scope. Future wake must pass current
authorization. Replace temporary file-only Done criteria through a recorded
migration with independent evidence; do not silently waive completion checks.

### Implementation boundaries

Add one Dori lifecycle module that owns eligibility, reasons, and reclamation.
Launch admission, the watcher, and administration commands call that same
module. The Discord controller must not implement a second retirement policy.

Record fresh issue/PR observations with their repository, identity, timestamps,
and the exact lane attempt. Reuse a bounded observation while fresh; refresh it
when required, and retain the candidate when the source is unavailable. Keep
GitHub access outside the launch lock.

Before teardown, acquire the launch/registry boundary and recheck the lane
revision, current job and source, session-to-pane binding, completion evidence,
question state, and execution state. The mutation must claim that exact
candidate so a concurrent launch, wake, or newer Stop cannot be overwritten.

For an owned idle session, save its checkpoint and perform the controlled
quiesce/close operation. For a worker with an active turn, retirement requires
verified completion plus an admitted stop/quiesce receipt for that exact
session. The known goal-resume/session-hold mismatch must be resolved before
using goal notification text as any execution receipt.

Persist a teardown operation before closing its pane. A successful close frees
the slot; a failed close becomes cleanup-pending and continues counting against
capacity until the terminal is confirmed gone. Restart reconciliation uses the
same operation, not another retirement request.

After a successful reclamation, resample actual worker capacity and host guard
limits, then start the next authorized queued item under the existing queue
ordering. Reclaim only as many eligible slots as the immediate demand needs.
Prefer verified completed sessions, then the oldest eligible idle checkpoint.
Do not repeatedly notify the requester while the same block persists.

### Command and presentation additions

The administration plan already contains lane list/show, pause, resume, verified
close, and owner-only abandonment. Extend it with an eligibility-checked
`lanes reclaim` operation and the matching “Release eligible slot” panel action.
It should show the concrete eligibility or refusal reason and retained resources.
Do not expose an unrestricted force-close button.

Add occupied/max workers, queued demand, hibernated workers, and the next
eligible candidate to capacity details. Show a short queue line when relevant.
A proposed acknowledgment is:

```text
Queued issue #15 at position 1. All four worker slots are occupied.
```

Only report reclamation or launch once the corresponding operation has actually
succeeded. Report an eligibility block once, with its actual reason.

### Acceptance

Cover the 24-hour boundary, pressure before that boundary, an idle saved session,
an unfinished active worker, a pending answer, dirty/unpushed work, issue reopen,
session reuse, a new Stop during quiesce, stale/missing GitHub evidence, concurrent
launch/reclaim, partial close, restart recovery, host pressure after reclamation,
and queue fairness. A full-slot scenario must actually release one eligible
session and start the next authorized queued job once, without asking for
per-worker approval.

Validate using disposable sessions and worktrees. Do not test automatic teardown
against the user's existing issue #4 worker or issue #15 queue entry.
