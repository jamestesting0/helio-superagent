# GitHub issue and pull request writing

Use this for new Helio-authored posts and reviewed description updates. Keep
the current issue as the request and the PR as the implementation report.
Preserve requirements, decisions, evidence and limitations when reorganizing.

## Issue drafts

Use named fields and render locally before publishing:

```json
{
  "summary": "What is wrong, who it affects, and the intended outcome.",
  "requirements": {
    "Expected behavior": ["A verifiable requirement."],
    "Edge cases and acceptance": ["A meaningful constraint."]
  },
  "context": {
    "Decisions and scope": "Confirmed choices and exclusions.",
    "Example": "A complete example, fenced when appropriate."
  },
  "evidence": "Known source links, duplicate search and technical observations."
}
```

```bash
helio issue render --draft-file DRAFT.json --output-file BODY.md
```

The command only writes a local preview. Continue the normal authorized issue
creation or `helio issue update --body-file BODY.md --note-file NOTE.md` workflow.
It does not grant creation or closing authority. Existing/manual descriptions
need review of the current body before replacing them. Do not automatically
rewrite historical closed issues or merged PRs.

Use a Reproduction context section for bugs. Keep expected behavior and material
constraints visible; supporting sources and investigation are expandable.
H2 sections and H3 groups come from the renderer. Put code and literal Markdown
examples in complete fences rather than adding headings inside author fields.
Never shorten a requirement by clipping its text.

## PR reports

Direct, planned and automatic fixes use the same report fields:

```json
{
  "summary": "The user-facing outcome and why it matters.",
  "changes": {
    "Behavior": ["What actually changed."],
    "Data and compatibility": ["Only a relevant data or compatibility detail."]
  },
  "verification": {
    "Focused regressions": "What was checked and the observed result.",
    "Live beta": "Not run; not requested."
  },
  "review_notes": ["A material limitation, deviation or deployment requirement."]
}
```

Omit empty groups and irrelevant review notes. Do not repeat the unit-suite
count: the submission gate owns that result. Distinguish focused, integration,
visual and live evidence. Do not imply that passing unit tests verifies the
Discord surface or live service health.

```bash
helio pr submit --issue N --result-file RESULT.json --report-file REPORT.json
helio autofix submit --issue N --report-file REPORT.json
```

Direct result rows name the confirmed requirement:

```json
{
  "scope": [
    {"requirement": "Readable prediction state", "status": "met", "evidence": "test_name or evidence path"}
  ],
  "done_when": []
}
```

Plan-mode rows stay in approved scope/done-when order; the composer derives
their labels from the plan. The approved plan comment and its hash are unchanged.
Partial implementation remains a reference, with deviations and remaining work
visible. The publisher owns the closing relationship and implementation marker.
Do not copy the issue body, status banner or machine metadata into the report.

`--summary-file` remains available for in-flight/legacy jobs. Its prose is kept;
new authoring should use structured reports. Normal legacy autofix URL reuse
retains its existing behavior; supply a report when reviewing/updating that PR.
No new approval is needed for this mechanical input conversion.

## Routine updates and bot-owned recovery

Update the existing document and named fields instead of appending another
snapshot. Generated status, verification and relationship facts each have one
owner. Write only change facts in NOTE.md: the publisher supplies its prefix.
Do not add a duplicate "Issue updated" heading.

The publication journal records intent before a network write. The bot's
normal reconciliation watcher retries pending reads/writes and settles lost
responses. Do not ask the user to retry, renew permission, compute hashes or
operate the recovery commands. Do not create a second PR or repeat an uncertain
creation because its response was lost. Continue independent work while the
bot reconciles; confirm the canonical PR/head before reporting delivery.

Reviewer notes outside the generated PR region are preserved automatically.
For `PR_EDITED_OUTSIDE_HELIO`, read the current description, incorporate its
material facts into the report and use `--adopt-body SHA256` for that exact body.
The hash is SHA-256 of the complete current body text from the GitHub API.
This is the bot's review step under the existing task authority; do not ask
whether to adopt. If the edit introduces genuinely ambiguous or unauthorized
product scope, ask only about that missing decision.

Pending work is retained across restarts, with its exact original payload.
The bot rechecks source authority, issue scope and PR identity before writing.
Once an ordinary transport problem resolves, recovery needs no user input.
A local lock cannot lock GitHub's external editor; preserve reviewed snapshots,
honor detected conflicts, and never promise atomic compare-and-swap.

Check both expanded and collapsed Markdown before claiming visual review.
Published issue/PR previews are external writes and require their applicable
authorization; local drafts do not authorize historical edits.
