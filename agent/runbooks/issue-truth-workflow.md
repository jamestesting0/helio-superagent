# Current issue descriptions

The body describes the request as it stands now. Comments remain discussion and the history of substantive changes; a decision or scope change must also update the body.

Read the body before changing it. Use `helio issue update --issue N --body-file FILE --note-file NOTE`. Use the request-intake issue template for the rewritten prose; preserve unrelated human details. Files keep Discord text out of shell command strings. For a close add `--close completed` or `--close not_planned`; for reopen add `--reopen`. Only the owner/current trusted user's explicit issue decision authorizes closing/reopening.

The command manages the status block from GitHub plan/PR facts, preserves prose, and removes `needs-owner-review` after a verified approved plan. Labels supplied by `--labels` are the full desired set; preserve unrelated labels. Routine `helio issue sync --issue N` updates facts without notification comments.

On `ISSUE_EDITED_OUTSIDE_HELIO`, read the new body, merge its changes into the proposed text and pass `--adopt` with the reported SHA256 of that exact reviewed body. This detects earlier edits and narrows concurrent races; GitHub does not provide an atomic body compare-and-swap here. Never claim human edits cannot race.

Updates persist before/after bodies and intended operations locally. If a later step fails, keep the successful body/PR and resume with `helio issue resume --operation ID`. Do not create a second PR or repeat notification comments to recover. A pending operation blocks later edits to that issue until reviewed/resumed. Notification markers deduplicate an uncertain successful send.

If a human changed the body while an operation was pending, preserve the saved history and review the current issue. `helio issue cancel --operation ID` abandons only the local intent; it does not revert any external changes. Start a newly reviewed/adopted update after cancellation rather than forcing the old body over the human edit.

Plan post/approve/drop, PR/autofix submission and follow-up outcomes enqueue reconciliation. The existing follow-up watcher handles up to five due tracked issues per cycle and keeps failures visible. State is a timestamped observation and may be unavailable; never say a merged change is live solely because checkout HEAD includes it.

A complete implementation PR uses `Fixes #N` against main and must have the corresponding GitHub closing relationship before merging. A plan result with deviations uses `Refs #N`, explains remaining scope and leaves the issue open. Preserve the generated implementation metadata when editing PR prose. `ISSUE_LINK_REVIEW` means inspect the stated mismatch: merge, issue completion and deployment are separate facts. A merged legacy PR without completion metadata needs scope review; never ask for a new merge approval or silently close the issue from a cross-reference alone.

Private decisions never go into public issue prose. A private hold is displayed only as an owner/author review requirement; ask the owner before publishing a private paraphrase.
