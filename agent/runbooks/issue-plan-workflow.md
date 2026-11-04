# Issue plans (opt-in)

Use this only when the owner or a trusted user asks for a plan or to finalize an issue
("finalize #4", "plan #4 first", "put the plan on the issue"). Finalizing means: post the plan
and wait. It never means building. Other requests and standing autofix work as usual.

The plan is a one-minute read that lets a person confirm you understood the request and are
heading the right way. It is not an implementation plan; your lane keeps its working steps
private. The approved plan is the contract the PR is checked against.

## Steps

1. Clarify first. Ask open questions in the conversation; the plan's "Needs your answer"
   section is only for what is still undecided when you post.
2. Write the plan as JSON fields (below) to a file, run the self-check, then post:
   `helio plan post --issue N --file PLAN.json --announcement-file OUT.txt --request-message M`.
   `--request-message` (the owner's or trusted user's request) is needed only for the first post.
3. Post OUT.txt with buttons in the request's conversation, or in the staff chat for staff-initiated
   work: `helio confirm plan --issue N --revision R --text-file OUT.txt --channel C --reply-to M`.
   It replaces the buttons of any earlier revision. If the requester cannot approve, also reply to them:
   "I've written up a plan for <issue link>; the team will review it."
4. On `INBOUND_CONFIRM` with outcome `approved`, run `helio plan approve --issue N --confirmation ID`;
   for a typed approval (a reply naming the issue) run `helio plan approve --issue N --message M`.
   `INBOUND_PLAN_FEEDBACK` carries suggested changes (`helio confirm feedback ID`): revise and post again. On `PLAN_REFUSED`, tell them the reason
   and ask again.
5. On `PLAN_APPROVED`, launch the lane with the brief below. Approval covers commit, push and PR;
   do not ask again.
6. Plans awaiting approval are counted in `helio status` and the greeting.

Lane brief (include the approved fields from `helio plan show --issue N --json`):
1. Run `helio plan check --issue N`; stop unless it prints `PLAN_APPROVED`.
2. Work on `helio/issue-N` from current `origin/main`. Build exactly the approved Scope; add tests.
3. Live beta only if the plan says "Requested by"; otherwise none.
4. If the work needs a different Scope, decision or Done-when item, stop and report; the lead posts
   a new revision. Small mechanical details (a helper name, an extra test) need no new approval.
5. Write a result file, one entry per Scope row and per Done-when item, in order:
   `{"scope": [{"status": "met", "evidence": "test_name"}], "done_when": [...]}` (status `met` or
   `deviation`), and a summary file. Then run
   `helio pr submit --issue N --result-file RESULT.json --summary-file SUMMARY.md`.

Revisions: post again with `change_note` ("window 8 to 6 hours"). A content change prints
`PLAN_APPROVAL_RESET`; send the new announcement and ask for approval of the new revision.
Hand edits on GitHub print `PLAN_EDITED_OUTSIDE_HELIO`: ask whether to adopt them; if so, read
them into the fields and post a revision. `helio plan drop --issue N` ends plan mode when asked.

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

Outside `technical_notes`: no code, file paths, function names, "TBD" or "etc."; the visible part
stays under 2,500 characters. `PLAN_INVALID field=F reason=R` names the field to fix.

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
