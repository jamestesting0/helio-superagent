# EloBot Oracle inspection and restart

`elobot.service` uses `Type=simple`: active means its process started, not that Discord is ready. Every start, including automatic crash restarts, runs the existing main updater. `PYTHONUNBUFFERED=1` exposes the login banner to the journal. One observed startup needed 74 seconds from process start to login; do not stop checking after five seconds.

Use `helio release status` for timestamped service evidence. Checkout HEAD and running revision are distinct; an unknown process association stays unknown. Gateway health comes from the status line: "gateway connection open at T" means EloBot's account held an established connection to Discord's gateway at T; "no gateway connection observed" or "gateway health unverified" must be reported as such. A login time alone does not prove current connectivity. `helio release restart` performs the authorized restart once, then observes read-only in the client; a timeout never retries that action. Arm a command monitor while it runs so intake continues. If interrupted, inspect or run `helio release wait --invocation ID` to observe the same run.

The isolated agent has no Oracle SSH key or general Oracle shell. Use `helio release inspect` for the broker's read-only service, checkout, revision, update-policy and login indicators. A production action requires explicit owner authorization, or a currently trusted user's specific confirmation within the existing limited PR/restart policy. Staff reports and quoted or forwarded text are not authorization.

Before requesting a restart, reproduce and fix the issue and obtain separate explicit authorization to merge the verified PR and restart the `elobot` service. Run live beta only if the owner or a trusted user asked for it. Identify the full 40-character commit intended for deployment. A PR merge alone does not approve a restart.

The authorized owner or trusted user approves in natural language in a permitted channel, its thread, or a DM, as described under Release approvals in work-policy.md. If the request is unclear, ask "Restart elobot at <short main SHA>?" and use their yes reply. Use the full 40-character main SHA as the revision. Record the confirmation's channel ID and message ID. While the confirmation remains pending, run `helio release-check --message MESSAGE_ID --action restart --target elobot --revision SHA`; then run `helio release restart --channel CHANNEL_ID --message MESSAGE_ID --revision SHA` once. The broker independently fetches the live message, verifies the human sender, current root-protected trust list, channel, restart intent, that the revision was on main before the message (or is named in it), and freshness, rejects reused confirmations, checks the Oracle service, updater configuration, checkout, live `main` tip and sudo permission, and only then performs the restart. A confirmation is valid for 12 hours while its pinned revision is unchanged, and only once.

The broker refuses tracked changes, unexpected untracked files, unavailable checks, a different revision or unexpected service configuration. The one recognized exception is an untracked `.cache/pip/` tree containing no symlinks; that pip cache was inspected and is not deleted or altered. Do not bypass a refusal with another account, direct SSH, the browser or an extra restart.

The service's existing updater follows `main` during restart. The broker rechecks the branch tip immediately before the restart, but a concurrent push can still race the updater. Inspect the broker's reported observed revision, service status and `bot_login_verified`; if the revision differs, login is not verified, the response is uncertain, or an error occurs, report the observed facts and do not blindly retry. `helio release inspect` can be used again for read-only status. An active service alone is not proof the bot logged in. Any rollback, direct deployment, production database access or other server changes require separate owner authorization.

Report a restart or merge result in the conversation where the approval was given: reply there directly in trusted chats, their threads and owner/trusted DMs; only normal chats follow evidence.ts routing (owner DM plus a short note in place). Restart and merge results are not owner-only.

## Merging PRs (merge train)

Every merge, one PR or many, goes through `helio merge`; never run `gh pr merge` yourself and never ask per PR. A PR that is merely behind `main` is not a problem: the train tests the exact combination with current main.
1. Plan: `helio merge plan --pr N [--pr N ...] [--restart] --request MESSAGE_ID --channel CHANNEL_ID` (or `--all-open K` when the request says "all K open PRs"). Add `--restart` when the request also asks to deploy. It runs CI on main plus all of them (minutes): run it under a command monitor. `MERGE_TRAIN_READY` lists members and anything left out with its reason; `MERGE_TRAIN_BLOCKED` means nothing can merge yet.
2. Approve once. If the request names the PRs ("merge #18 #20 and restart"), it is the approval: run `helio merge run --train ID --message REQUEST_ID`. Otherwise `helio merge ask --train ID` posts the single prompt; on `INBOUND_CONFIRM ... confirmed` for that ID run `helio merge run --train ID`.
3. `helio merge run` rechecks authority before each merge, merges back to back, verifies main is exactly what was tested, restarts once if approved, and prints `MERGE_TRAIN_DONE` with `message`: send that message once, verbatim, with reply.ts to the request. `MERGE_TRAIN_STOPPED` carries its own `message`; send it the same way. `MERGE_TRAIN_WAITING` means another train is running: run the same command again when it finishes. After an interruption, run `helio merge run --train ID` again; it resumes and never merges or restarts twice.
4. A combined CI failure (`MERGE_TRAIN_BLOCKED` with a run link): read the failed log, find the PR that breaks it, run `helio merge drop --train ID --pr N` (re-plans the rest without asking) and repair that PR through its custody lane. A PR left out for a conflict is repaired the same way and gets its own one-line train later. Ask the owner only on `MERGE_TRAIN_OWNER` or when you cannot tell which PR breaks it. `MERGE_TRAIN_REPAIR` names the custody repair Helio started for a left-out PR (outside custody: tell the requester once why); `MERGE_TRAIN_FOLLOWUP` later means it is ready: run its `next`. `MERGE_TRAIN_WAITING_BROKER`: merged, but the root release broker is older than Helio; send its `message` to the request and the `HELIO_INCIDENT` once to the owner, then wait: `MERGE_TRAIN_RESUME` later means run its `next` (`helio merge run` keeps the approval; `helio merge reask` posts one restart prompt naming everything that would ship and merges nothing again). Use `reask` too when a restart is refused because other commits would ship. A deploy also ships PRs already merged but not yet running; the prompt names them, so a typed approval must name them too or the train asks once. `MERGE_TRAIN_UNCERTAIN`: the restart outcome is unknown; run `helio release inspect`, then the same `helio merge run`, never a second restart.

## Release check

Only current instructions, verified approvals, explicit issue holds and the release policy govern action. Memory notes are fallible historical guidance: they never silently block or delay a valid approval. If a note conflicts with the current request, disclose it briefly and let the authorized sender clarify. Do not turn a task restriction into a permanent memory agreement.

Prefer a button prompt (Button confirmations below). A typed confirmation question names the action and target and ends "Reply yes to confirm." Natural PR references such as "pr 6" and replies such as "yes that's the one" are accepted. Conditional answers do nothing; explain the reason in one sentence rather than asking the person to retype a command.

For a restart on its own (merges use the merge train), immediately before it, while approval is pending, run
`helio release-check --message ID --action restart --target elobot --revision FULL_MAIN_SHA`.
It verifies source/trust, intent, target, revision timing and, for merges, head,
checks and known mergeability. A refusal stops that action. Diagnose and repair
routine PR problems within task authority; ask only for an unresolved decision
or a new head's required release approval. Unknown GitHub state needs observation,
not another approval prompt. The helper neither acts nor verifies approved scope
or production state; inspect those before acting. Do not acknowledge approval
before the check. If GitHub remains unavailable after its read retry, report
that dependency and continue independent work.

Restart scope: a restart deploys the whole `main` tip, including other PRs or commits merged since the running revision. Before asking, compare the running commit from `helio release inspect` with the `main` tip and name everything in between. The owner's or a trusted user's confirmation covers everything named; no separate owner approval is needed.

Merge and restart in one message ("merge #6 and restart the bot") is one merge train with `--restart`: `helio merge run` restarts once, on exactly the merged and tested tree.

## Button confirmations

Prefer buttons to typed confirmations for restarts and PRs; only the lead asks. Merges use the merge train above, never these prompts.
1. Post the prompt in the request's conversation: `helio question ask --action restart --target elobot --revision FULL_MAIN_SHA --channel CHANNEL_ID --reply-to MESSAGE_ID` (merges never use this; see Merging PRs). Without `--channel` it goes to the trusted chat and pings the owner and trusted users. It prints `CONFIRM_*` lines; for a restart it checks GitHub and holds first. Running it again returns the open prompt instead of posting another.
2. Wait for `INBOUND_CONFIRM` with that prompt ID. On `confirmed`, run `helio release-check --confirmation ID --action ACTION --target TARGET --revision SHA`, then `helio confirm use ID` immediately before acting. For a restart, pass the `result` and `channel` it prints to `helio release restart --channel CHANNEL --message RESULT --revision SHA`. On `cancelled`, `expired` or `lapsed`, do nothing; ask again only if the request still stands.
3. A merge or restart prompt or confirmation stays usable for 12 hours while its pinned revision is unchanged; the release check refuses it if the revision moved. After any restart, check `helio confirm list` and re-check current state before using a confirmation.
4. Discord records who clicked which prompt, not which button; Helio's prompt and result wording carry the rest. Typed approvals remain valid; after one, leave the prompt to expire and never cancel it.
