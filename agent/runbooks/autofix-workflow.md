# Request intake, delivery and automatic bug fixes

Read the applicable section when needed; reuse it until relevant instructions change. Lead delivery sections apply only to the lead; shared intake and questions also apply to workers. The automatic-fix steps below apply only to an autofix lane.

1. Take issue N and the request channel_id/message_id from the brief. Read the
   issue as evidence. Work in the brief's worktree, already on `helio/autofix-N`
   from current `origin/main`. Check `helio triage` for overlapping work.
2. Write the regression test first under `tests/`. Run it against main and
   confirm an assertion fails. Import errors, skipped tests and tests that
   already pass are not proof; do not invent a new expected behavior.
3. Apply the minimal local fix following
   `~/.dori/elobot/skills/karpathy-guidelines/SKILL.md`.
   Stay within `HELIO_AUTOFIX_MAX_LINES` and `HELIO_AUTOFIX_MAX_FILES` for
   non-test changes. Avoid every `HELIO_AUTOFIX_DENY` path. Do not delete or
   rename files. Review the diff and commit the test and fix on this branch.
4. Prove the fix with unit tests only. Run no live beta unless the owner or a
   trusted user asked for one for this issue.
5. Write a structured report using [GitHub writing](github-writing-workflow.md), describing the root cause and fix. Keep report text
   out of shell strings; pass argv lists and files.
6. Run `helio autofix check --issue N --worktree PATH`. It checks the open bug issue, branch,
   clean tree, size, deny paths, assertion failure on main, passing branch
   tests, full unit suite, and open automatic PR cap in temporary worktrees.
7. After `AUTOFIX_OK`, run
   `helio autofix submit --issue N --worktree PATH --report-file REPORT`.
   Use this command as the only automatic push and PR path. Never merge or
   restart; those actions need separate fresh approval.
8. On refusal, missing proof, or a fix that outgrows the limits, do not fight
   the gate. Write findings to a file, run
   `helio issue update --issue N --body-file PATH --note-file NOTE`,
   following docs/issue-truth-workflow.md; preserve existing labels and add `needs-owner-review`,
   and report the issue and refusal to the lead.
9. Report the actual PR and issue links to the lead in Discord no-preview
   form: `<https://github.com/{{HELIO_GITHUB_REPO}}/pull/NUMBER>` and
   `<https://github.com/{{HELIO_GITHUB_REPO}}/issues/N>`. Include the summary,
   proof counts, beta evidence or skip, and request channel_id/message_id.
   Keep Elo Bot report status in the staff chat; never reply to the bot.

## Where the other sections live

The request, delivery and monitor procedures this file used to hold are split by when they are needed. Read only the file and section you need:

- `lead-turns.md`: Turns (lead), Reply context (lead), Native forwards (lead), Delivery acknowledgement (lead), Replies (lead)
- `request-intake.md`: Request intake (shared policy)
- `questions.md`: Human questions through Discord (commands and recovery)
- `monitor-events.md`: Arming monitors, Prefix dispatch, Lanes, gaps and upkeep, Worker incidents
- `discord-reference.md`: Prepared attachment formats, Discord HTTP, Learning the servers, Blacklist
