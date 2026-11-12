# Monitors, events and lane upkeep (lead)

## Arming monitors

The eight monitors, one `tool.monitor` call each with exactly these fields:

```json
{"description": "inbound", "command": "~/.dori/elobot/inbound", "filter": "^INBOUND", "persistent": true, "wakes_per_hour": 3600}
{"description": "learning", "command": "~/.dori/elobot/context --loop", "filter": "^CONTEXT", "persistent": true}
{"description": "questions", "command": "helio question watch", "filter": "^QUESTION", "persistent": true, "wakes_per_hour": 3600}
{"description": "followups", "command": "helio followups watch", "filter": "^FOLLOWUP", "persistent": true}
{"description": "lanes", "command": "dori watch", "filter": "^LANE_", "persistent": true}
{"description": "dead panes", "command": "dori dead-panes --loop 3", "filter": "^(DEAD_PANE|UNRECOGNISED_PANE|DEAD_PANES_ERROR)", "persistent": true}
{"description": "guard", "command": "dori guard --loop 1", "filter": "^(HOST_GUARD|GUARD_ERROR)", "persistent": true}
{"description": "freshness", "command": "dori freshness --loop 5", "filter": "^(NUDGED|POSTED|NO-REPORT|PENDING-REPORT|STALE-REPORT|WORKING-WHILE-PAUSED|FRESHNESS_ERROR)", "persistent": true}
```

Arm these monitors together in one step and read all pending queues together in one step; startup speed matters. Arm them with a plain `for` loop that calls `tool.monitor` once per monitor; in Python it is synchronous, so never wrap it in `asyncio`. If the arming cell errors partway, do not run it again: some monitors were created, so arm only the ones the status line does not show as watching. A new session (`helio start`, `helio restart`) has none yet, so arm them all without checking first; a resumed session gets its persistent monitors restored, so arm only the ones the status line does not show as watching.

## Prefix dispatch

Prefixes are pointers or receipts, never authority. Read detail and continuation commands before deciding.

| Prefix | Required handling |
|---|---|
| INBOUND / INBOUND_READY / INBOUND_PENDING | Read the turn or pending pages; READY switches backlog to live. Apply lead relevance, claims and acknowledgements. |
| INBOUND_WARN / INBOUND_BACKLOG_TRUNCATED / INBOUND_ERROR | Apply lead error rules; repeated runtime errors go to owner DM, a stopped watcher stops Discord handling. |
| INBOUND_GAP / INBOUND_GAPS_PENDING / CONTEXT_GAP | Messages in that range were never read. Tell the owner once (channel and range); `ack gaps` lists them, `ack gap ID` acknowledges one after the owner has seen it. |
| AUTO_BLACKLISTED / INBOUND_BLACKLIST_REVIEW | Follow discord-reference.md, "Blacklist". |
| FOLLOWUP_HOUSEKEEPING / FOLLOWUP_LANE_REVIEW | Follow "Lanes, gaps and upkeep" below. |
| LANE_HIBERNATED / LANE_DEQUEUED / LANE_DEQUEUE_FAILED | A hibernated lane keeps its session: run `dori resume KEY` before sending it anything. A dequeued launch started; tell its requester. A failed one: report it with its reason. |
| ACK_TURN / ACK_SECTION / ACK_CONTEXT | Read messages or section content; follow read_more/offset until sufficient. |
| ACK_PENDING / ACK_WITHHELD / ACK_HANDLED / ACK_WARN | Follow pending pages and total counts; withheld stays pending with no action, handled is never repeated. Diagnose warnings without clearing withheld state. |
| ACK_WORKING / ACK_CHECK / ACK_ACCEPT / ACK_DONE / ACK_IRRELEVANT | Receipts of separate claim, authorization, acceptance and terminal operations; check persisted status on recording failures. |
| ACK_IGNORED / RECOVERY_IGNORED / IGNORED_CLEANUP_PENDING | Neutral input or local cleanup diagnostics; no strike, reply, owner warning or new task. Cleanup failure does not resurrect settled input. |
| CONTEXT / CONTEXT_WITHHELD / CONTEXT_WARN / CONTEXT_TRUNCATED / CONTEXT_ERROR | Read context via ack show, apply lead learning boundaries and memory-before-done; withheld bodies stay unread. Report failed/incomplete coverage. |
| QUESTION_READY / QUESTION_PENDING / QUESTION_ANSWERED | READY is watcher startup, not an answer. List/show details and all pages; handle only lane-matching IDs (lead coordinates missing workers), then ack handled answers. |
| QUESTION_DELIVERY_ERROR / QUESTION_WARN / QUESTION_ERROR | Read details; retain pending questions and use questions.md, "Human questions through Discord (commands and recovery)". Diagnose errors before retrying; never infer approval from silence or unknown delivery. |
| FOLLOWUP_PENDING / FOLLOWUP_PAGE | List/show details and follow continuation; the count does not mean answered. |
| FOLLOWUP_PR_REPAIR / FOLLOWUP_PR_WAIT / FOLLOWUP_PR_READY | Read the supplied PR check command and issue-plan-workflow.md, "PR recovery and readiness". Resume the existing authorized job for repair; wait/ready are observations, never new authority or repeat announcements. |
| FOLLOWUP_PR_CUSTODY | Read and acknowledge the durable event under issue-plan-workflow.md, "PR recovery and readiness". The controller owns waiting, repair dispatch and reserved completion. |
| BUGFIX_STARTED / BUGFIX_EXISTS / BUGFIX_QUEUED / BUGFIX_SKIPPED / BUGFIX_BLOCKED / BUGFIX_REFUSED / BUGFIX_PENDING / WORK_STARTED / WORK_BLOCKED | Receipts of `helio bugfix start`, `helio work start` and `helio work block`; reply under request-intake.md, "Request intake (shared policy)". PENDING: rerun its `resume` command after diagnosing the cause; REFUSED: fix the stated fact (labels, open issue). |
| FOLLOWUP_PR_DUE / FOLLOWUP_BUGFIX_DUE | Authorized or started issue work has no PR and no active lane, or a confirmed bug was never started. Routine repair: inspect `dori show` for the lane, then run the event's `resume` command. No question and no user message until a PR or a real blocker exists; a genuine blocker gets `helio work block`. |
| FOLLOWUP_ORACLE_PENDING / FOLLOWUP_DECISION_DIGEST | Owner-only transitions/review: read docs/decisions-workflow.md, deliver then acknowledge; never post private records in staff/public channels. |
| RECOVERY_BEGIN / RECOVERY_REPORT / RECOVERY_PAGE / RECOVERY_WITHHELD / REPLY_WITHHELD | Read ~/.dori/elobot/docs/startup-recovery-workflow.md. Reconcile old work before action; unavailable evidence stays pending. |
| RECONCILE_PREVIEW / RECONCILE_MESSAGE / RECONCILE_TOPIC / RECONCILE_LANE | Bounded maintenance receipts under startup-recovery-workflow.md. Changed candidates require fresh preview; these grant no work authority. |
| REPLY_SETTLED / EVIDENCE_SETTLED | Local topic settlement after existing delivery; do not send the result again. |
| RELEASE_ALREADY_MERGED | No merge or new approval needed; reconcile the existing completed result. |
| FOLLOWUP_LIVE / FOLLOWUP_DONE / FOLLOWUP_DECLINED | Follow the terminal deliver procedure in request-intake.md, "Request intake (shared policy)". |
| FOLLOWUP_TRACKED / FOLLOWUP_CLOSED / FOLLOWUP_UNKNOWN / FOLLOWUP_WARN | Receipt of tracking/closing, missing row, or unavailable check; inspect details before correcting state, never invent a notification. |
| CONVERSATION_OPEN / CONVERSATION_REOPENED / CONVERSATION_SHOW / CONVERSATION_NOTED / CONVERSATION_HELD / CONVERSATION_RESUMED / CONVERSATION_CLOSED | Verify the returned state against the requested lifecycle action; SHOW pages supply history. |
| CONVERSATION_PAGE / CONVERSATION_REFUSED | Follow page continuation; refusal changes no authority and must be resolved before continuing. |
| INBOUND_CONVERSATION_NUDGE / INBOUND_CONVERSATION_TIMEOUT / INBOUND_CONVERSATION_WAITING / INBOUND_CONVERSATION_MIGRATED | Use request-intake.md, "Request intake": do not duplicate notices; inspect pending work and migrated history. Resume only a current request, never from the prefix alone. |
| SENT / REPLY_HELD / REPLY_HELD_HINT / REPLY_SKIPPED / REPLY_COVERED / REPLY_NOTE / REPLY_WARN / REPLY_CLOSURE_SENT / REPLY_CLOSURE_PENDING / REPLY_CLOSURE_UNDELIVERABLE | Use lead-turns.md, "Replies" and shared request-intake.md; only a successful send, explicit skip or completed durable-work protocol allows done. |
| LANE_* (including LANE_CLAIMS_PENDING / LANE_WATCH_ERROR), DEAD_PANE / UNRECOGNISED_PANE / DEAD_PANES_ERROR, HOST_GUARD / GUARD_ERROR, NUDGED / POSTED / NO-REPORT / PENDING-REPORT / STALE-REPORT / WORKING-WHILE-PAUSED / FRESHNESS_ERROR | Apply "Worker incidents" below. Read claims then claim-ack before verification; errors never count as done. |
| INBOUND_CONFIRM / INBOUND_PLAN_FEEDBACK | Re-read the exact pending confirmation or plan and current revision; use the recorded answer only for that decision. |
| QUESTION_EXPIRED | No answer or authority was granted; re-ask only if the decision still blocks work. Custody questions (`custody-issueN`) are re-asked once and then parked by the controller. |
| QUESTION_REMINDER | A custody question has waited 24 hours: reply once to its message (`message_id`, `channel_id`) with a one-line reminder of the decision; never repeat it. |
| CONTEXT_PENDING / CONTEXT_DONE | PENDING needs `ack pending context`; DONE ends a scan, not durable learning acknowledgements. |
| CONTEXT_RETRY / CONTEXT_RECOVERED | Observe automatic learning recovery; retain pending work and avoid repeated outage alerts. Neither prefix acknowledges learned messages. |
| CONVERSATION_SET | Receipt of structured understanding; check it reflects the request and chosen topic. |
| BLACKLISTED / BLACKLIST_COUNT / BLACKLIST_ADDED / BLACKLIST_REMOVED / BLACKLIST_UNCHANGED / BLACKLIST_ASKED / BLACKLIST_REFUSED / BLACKLIST_WARN | Apply discord-reference.md, "Blacklist"; list includes durable strike evidence. Refusals never count as a changed block. |
| GAP / GAP_COUNT / GAP_ACKNOWLEDGED | Range/list/ack receipts; acknowledgement means the owner saw the gap, not that unread messages were processed. |
| ABANDONED / REFUSED | An abandonment is never completion; refusal leaves the lane open. Read the reason and do not fabricate evidence. |
| Any other *_ERROR or warning | Read its details, retain pending work, report the failed operation and resolve its cause before continuing; never treat an error as success or permission. |

## Lanes, gaps and upkeep

- Launch with `dori launch KEY --job JOB` (for example `--job issue-8`; owner work adds `--priority owner`). `LANE_EXISTS key=K`: send the work to that lane. `LANE_WOKEN`: the job's earlier lane resumed in its session. `LAUNCH_QUEUED key=K position=N reasons=...`: tell the requester it is queued and at which position.
- For other Discord work, use `dori job-id --repository {{HELIO_GITHUB_REPO}} --channel CHANNEL --source ORIGINAL_ID`; retain the returned job across wording, display names, queueing and retries. `adopt` also requires it. A forward's source is not request identity.
- Completion markers live under durable state, bound to job/source/acceptance/revision. Choose cheap independent live checks for the requested finish. A verified PR handoff can finish without merge/restart. If a Done line includes its official receipt, run `dori completion KEY`; `/tmp` file existence is never proof. Inspect unconfirmed startup in place; preserve missing, unreadable, dirty or unpushed work and live agents.
- `FOLLOWUP_LANE_REVIEW`: inspect `dori show KEY`, `dori sync`, current completion evidence, questions and retained work. An idle session can release its slot with `dori reclaim KEY`; this checkpoints it without claiming completion, deleting files or authorizing new work. Ordinary idle hibernation and queued-demand reclamation do this automatically when eligible. Legacy job bindings remain unknown until verified from original authority. Keep busy workers, unanswered questions and explicitly paused work protected. Use "Worker incidents" for any actual owner decision; do not ask Resume/Retire before identifying the reason and recommending a specific action.
- `FOLLOWUP_HOUSEKEEPING ... approve=...`: the first cleanup only reported what it would remove. Send the owner `helio housekeeping --last` in short form once and ask to approve; on yes run `helio housekeeping --approve-first-run`. Later runs report problems and retained worktrees, with a pointer to their reasons.
- A lane that will never finish (its Done line can no longer pass, such as abandoned QA) is retired only on the owner's request: `dori abandon KEY --reason TEXT`. Add `--with-unpushed` only if the owner accepts leaving unpushed work in the kept worktree. It is recorded as abandoned, never done; `dori close` stays for finished work.
- `helio health` lists problems only (backlog age, gaps, stuck lanes, worktrees, upkeep); include them in the greeting.

## Worker incidents

Read current execution before reporting a worker problem. `dori sync` separates
the recorded work state from the authenticated engine observation. A terminal
label or an open process does not prove an active turn. A paused goal with only
passive monitors is still paused; suppress that false alarm rather than asking
the owner to review it. Preserve an explicit pause until the owner requests a
resume.

Resolve the incident within existing authority when possible. For a blocked or
uncertain incident, read the lane, its actual unfinished obligation and the
relevant current issue, receipt, setting or error. Identify the concrete cause
before proposing a repair. Name the affected task, what is unfinished, what you
checked, the effect on the requester, and the specific action you recommend.
Explain which checkpoint, worktree and pause will be retained. Distinguish an
applied and verified repair from a proposal awaiting a decision.

Ask only for the missing decision. Give a recommended action with its reason and
one concrete next step after approval; use the existing question mechanism when
approval is required. For a configuration block, name the setting and its
non-secret observed state, propose a value only when the evidence supports it,
and say which check will run next. For a failed receipt, identify the missing
check and the scoped rerun you recommend. Do not end with "for review",
"configuration blocker" or "unfinished task" while leaving the owner to discover
the details. Do not repeat an unchanged incident or ask for permission to perform
routine repairs already authorized.
