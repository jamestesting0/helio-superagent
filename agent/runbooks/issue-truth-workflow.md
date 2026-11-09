# Current issue descriptions

Use [GitHub writing](github-writing-workflow.md) for grouped drafts, PR reports
and bot-owned publication recovery. The bot handles routine retries; users
should not have to operate recovery commands or repeat task authorization.

The body describes the current request, confirmed requirements (with sources),
open questions and decisions. Unverified claims stay open questions. Update an
active issue without another confirmation. Closing needs the owner or a current
trusted user. Closed issues remain historical; never reopen them.

## New work related to closed history

Triage related open issues/PRs/lanes first. Reuse an exact open task; a historical
citation alone creates nothing. For substantive follow-up, regression or
remaining work after closure, create a new issue containing only its current
scope, acceptance criteria and why it differs from the completed work:

`helio issue followup --previous N --message M --channel C --title TITLE
--body-file FILE --labels LABEL...`

Run as an argv array; TITLE is text, not a shell fragment. The helper adds a
canonical historical reference, giving GitHub a backlink without changing the
old issue. It records the current request before creating and returns the same
issue on replay. If creation is uncertain, repeat this same command to reconcile;
never bypass it with another create. Unknown outcomes stay pending after
read-back, not guessed successful or blindly reposted.

Use the new number for its plan, authorization, PR completion metadata and
requester follow-up. The current clear implementation request can authorize that
scope without another question; old plans, approvals and completion do not
transfer. Read applicable decisions and preserve current holds/no-commit/no-PR/
no-beta limits. Never copy completed scope or private decisions into the new body.

A merged/closed PR stays historical and the new task gets a new branch/PR. If an
existing open PR already contains the work, revise it in its existing tree/lane
only when the current request covers its whole remaining diff. Its new issue
must describe that full scope. Submit against the new number; the helper permits
a numbered predecessor branch only for a verified existing canonical open PR.
Its closing link becomes the new issue; the old issue is only a reference.
Never create a duplicate PR or revive an old lane merely because topics match.

Legacy pending reopen operations are retired locally, retaining their history.
Already completed external changes are not reverted. Historical reopen events
remain visible in projections; they are not a procedure to repeat.

## Updating current facts

When a discussion about an issue adds, corrects or confirms facts, update the body in that turn, before telling anyone the facts are noted. Replies that name an issue link the conversation to it; later requester messages in that conversation, and new GitHub comments by people, make the issue due. `ISSUE_REVIEW_DUE` appears after such a reply and repeats from the follow-up watcher until you run `helio issue update`, or `helio issue reviewed --issue N --reason-file FILE` when nothing changes the description.

Read an issue with `helio issue show N`: the body plus comments by people since the last review. Helio's own comments are a public change log for people and are never decision input; the body is the truth.

Read the body before changing it. Use `helio issue update --issue N --body-file FILE --note-file NOTE`; a description change requires a short public "Issue updated" comment. Use the request-intake template and preserve unrelated human details. Files keep text out of shell commands. An authorized close uses `--close completed` or `--close not_planned`. Routine historical status/correction updates can retain links and facts on a closed issue; new scope belongs in its linked follow-up.

The command manages the status block from GitHub plan/PR facts, preserves prose, and removes `needs-owner-review` after a verified approved plan. Labels supplied by `--labels` are the full desired set; preserve unrelated labels. Routine `helio issue sync --issue N` updates facts silently except for one "Progress" comment per new milestone: PR opened, merged or closed, and live revision observed.

On `ISSUE_EDITED_OUTSIDE_HELIO`, read the new body, merge its changes into the proposed text and pass `--adopt` with the reported SHA256 of that exact reviewed body. This detects earlier edits and narrows concurrent races; GitHub does not provide an atomic body compare-and-swap here. Never claim human edits cannot race.

Updates persist before/after bodies and intended operations locally. If a later step fails (for example a connection error), keep the successful body/PR: the next update or the five-minute sync of that issue finishes the interrupted operation first, so no manual step is needed. Call it pending until `ISSUE_UPDATED` or the next sync confirms it. Do not create a second PR or repeat notification comments to recover. Only an operation that cannot finish (the issue was edited during it) stays pending; review it, then `helio issue resume --operation ID` or `cancel`. Notification markers deduplicate an uncertain successful send.

If a human changed the body while an operation was pending, preserve the saved history and review the current issue. `helio issue cancel --operation ID` abandons only the local intent; it does not revert any external changes. Start a newly reviewed/adopted update after cancellation rather than forcing the old body over the human edit.

Plan post/approve/drop, PR/autofix submission and follow-up outcomes enqueue reconciliation. The existing follow-up watcher handles up to five due tracked issues per cycle and keeps failures visible. State is a timestamped observation and may be unavailable; never say a merged change is live solely because checkout HEAD includes it.

A complete implementation PR uses `Fixes #N` against main and must have the corresponding GitHub closing relationship before merging. A plan result with deviations uses `Refs #N`, explains remaining scope and leaves the issue open. Preserve the generated implementation metadata when editing PR prose. `ISSUE_LINK_REVIEW` means inspect the stated mismatch: merge, issue completion and deployment are separate facts. A merged legacy PR without completion metadata needs scope review; never ask for a new merge approval or silently close the issue from a cross-reference alone.

Private decisions never go into public issue prose. A private hold is displayed only as an owner/author review requirement; ask the owner before publishing a private paraphrase.
