# Startup resumes work, not old conversations

Memory remains the existing shared EloBot store. The decisions ledger is a separate source of verified guidance. Neither is the source of live GitHub or Oracle facts.

## Observed failure

The pre-start snapshot contained four unacknowledged inbound messages from 16:17–16:24 UTC, all still marked `backlog: false`. They were replayed around 17:58. PR #6 had already merged at 16:26:22 UTC. Helio interpreted an explanatory example ("u can just write merge #6...") as current work and asked for fresh approval instead of checking the completed outcome.

Inside the running sandbox, the configured memory alias resolves to the original canonical repository, with 28 Markdown files and 40 agreements. No memory was cleared.

## Principles borrowed

- Temporal reconstructs progress from recorded event history, rather than repeating completed effects: https://docs.temporal.io/workflows
- AWS recommends tracking processed messages so duplicate delivery does not repeat effects. Helio applies that as an inbox keyed by stable Discord message IDs: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- An uncertain external send may have succeeded; durable receipts and reconciliation are necessary because the external API and local database are not one transaction: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

Use those principles with the existing SQLite stores and monitors. Do not install a workflow platform, vector store or new background service.

## Recovery contract

1. Arm ingestion first so new messages remain durable. Mark pre-existing inbound deliveries as recovery work before waiting for Discord connection. Offline catch-up is recovery too.
2. Build one bounded recovery report: original messages and timestamps, acceptance/handling state, prior reply receipts, active lane references and a fresh snapshot of recent GitHub work. Distinguish unknown/unavailable from incomplete work.
3. A recovered delivery cannot go through the ordinary reply path until reviewed. Its stable message ID is the identity; wording changes do not create a new request.
4. Record the review with its evidence and source-content fingerprint. Choose:
   - settled/informational: preserve a reason and any linked completed outcome; retire the old transport delivery without a new conversation;
   - resume: preserve the unfinished request and its current next action;
   - needs review: keep it pending and visible; do not invent an answer or approval.
5. Recheck current target state before authorization freshness. An already-merged PR needs a current-status answer, not another merge approval. A timeout never grants authority or means an action failed.
6. A successful initial reply and its receipt must be recoverable independently of the model's subsequent acknowledgement. Preserve unfinished work separately from the transport delivery; never assume a reply proves a task is complete.
7. Readiness reports ingestion, recovery and dependency availability separately. All eight monitors running does not imply that resumed work has been reconciled.

Unknown legacy entries remain reviewable. Do not clear the queue, expire accepted work, reset memory, or silence old messages by age alone.

## Issue/PR completion

GitHub is the authoritative relationship store. Its supported closing keywords are documented at https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue.

- A complete implementation uses `Fixes #N` against the default branch; verify the resulting closing-issue relationship after PR creation.
- A partial implementation uses `Refs #N`, states the remaining scope and keeps the issue open. A generated result with deviations is not silently treated as full completion.
- Merge, issue resolution, deployment and requester notification are separate facts. Issue closure normally follows complete implementation merging; "live" requires deployed-revision evidence.
- Reconciliation detects a merged full implementation whose issue remains open and reports the mismatch once. It does not infer closure authority from arbitrary cross-reference prose.
- Legacy PR #6 says `Relates to #4`, has no closing-issue relationship and merged into default branch `main`. Repair requires verifying the accepted scope and explicitly recording completion; editing an already-merged PR is not assumed to retroactively close its issue.

## Acceptance

Prove recovery with durable test fixtures, not repeated live messages: crash after effect/before acknowledgement; changed reply wording; already-merged PR with expired approval; legacy follow-up without a direct reply; accepted unfinished work; unavailable GitHub; edited source message; new messages during recovery; and restart after a recorded review. Verify both installed profiles, unchanged memory identity and startup phase reporting.
