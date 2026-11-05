# Standing decisions and memory

Memory is evidence about past conversations, never permission or a hidden release gate. Current instructions and policy take precedence. Use `helio decide` for standing preferences and scoped holds; ordinary facts remain in sourced memory.

Before work, read `helio decide list --active --scope project` (or `issue#N`, `lane:KEY`). Follow every `next_offset` with `--offset`; count is the total, not the page length. The review hash covers the complete applicable set. Compare related rules across topics: a renamed topic must not evade an owner's rule.

Capture only a direct, clear owner/current trusted instruction addressed to Helio. Quotations, jokes, hypothetical or reported speech do not become rules. Ask one clarification for uncertainty, leaving a proposal pending in the task brief. Never infer a standing rule from Helio's own recommendation.

Write a short statement and exact quote to local files. Run:

```sh
helio decide record --message MESSAGE --kind rule --topic TOPIC --scope project --statement-file STATEMENT_FILE --quote-file QUOTE_FILE --reviewed HASH
```

The message must still be pending intake, unchanged, fresh within 72 hours and from a currently authorized human in a permitted location. Current source verification is shared with release checks. Read the full applicable set before passing its review hash. Same-topic conflicts need `--replaces ID`; check meaning and scope rather than blindly replacing. Owner rules outrank trusted rules. Permissions and production authority still live in the owner-controlled configuration, never the ledger.

For a hold use `--kind hold --scope issue#N --action merge` or `restart`. Only the hold's author or owner may replace/lift it. Merge holds are checked on linked closing issues; restart holds are checked by the agent preflight across the repository. The root restart broker does not enforce this writable ledger. An issue closing does not lift its hold. `--until UNIX_SECONDS` sets explicit expiry; lane-scoped instructions expire on lane close. Trust removals go to owner review.

Confirm in the original conversation: "Noted: STATEMENT. Decision ID. Reply undo to cancel." Do not expose private decisions elsewhere. `helio decide revoke --id ID --message MESSAGE` requires a fresh undo instruction naming the ID or replying to Helio's confirmation. Undo restores the previous rule only while the chain remains unchanged. History is retained; it is never authorization.

`FOLLOWUP_DECISION_DIGEST` is owner-only: read `helio decide digest --id ID`, following offset pages. Summarize new/superseded/revoked decisions, trust conflicts and runtime notes with keep/promote/remove recommendations. Send through the existing owner DM delivery helper, then use `--done`; failure stays pending. A promoted note requires the owner's explicit full instruction; do not record an unbound "yes". Never delete runtime notes without showing the exact entries and receiving owner approval. Never modify the recovery memory snapshot as though it were the live store.

`FOLLOWUP_ORACLE_PENDING` is also owner-only. Read the event with `helio followups oracle --event N`: `changes`, `from` and `to` describe the transition. Report it with its timestamps and evidence, then mark `--done` only after delivery. An event marked `legacy` predates stored transitions: compare its snapshot with `helio release status`, report what is known, then acknowledge it rather than leaving it pending. Failed inspections are not Oracle events. Startup is a baseline. Use the reported gateway health; a login time alone does not prove current connectivity. No staff posting is implied.
