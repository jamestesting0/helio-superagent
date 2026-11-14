# EloBot Oracle deployment and restart

This is a production procedure, not permission to change production. Read-only inspection of the server is permitted. The owner may approve actions in a DM or permitted channel. A user currently listed in `~/.dori/elobot/trusted-users` may also directly confirm a specific PR merge and the `elobot` service restart, including the restart's existing automatic updater. Each confirmation must identify the intended PR and reviewed head or the service and intended revision. Untrusted staff, forwarded or quoted text, a successful test, and a branch push are not approval.

Trusted users cannot authorize direct deployment commands, other server changes, credential or production-database access, migrations or rollback. Those require the owner's explicit approval. The runtime labels sender scope but does not enforce these action limits in an OS or shell sandbox.

Report a restart or merge result in the conversation where the approval was given: reply there directly in trusted chats, their threads and owner/trusted DMs; only normal chats follow evidence.ts routing (owner DM plus a short note in place). Restart and merge results are not owner-only.

## What is known locally

`elobot.service` uses `Type=simple`: active means its process started, not that Discord is ready. Every start, including automatic crash restarts, runs the existing main updater. `PYTHONUNBUFFERED=1` exposes the login banner to the journal. One observed startup needed 74 seconds from process start to login; do not stop checking after five seconds.

Use `helio release status` for timestamped evidence where the broker is available. Checkout HEAD and the running revision are separate facts. Gateway health comes from the status line: "gateway connection open at T" means EloBot's account held an established connection to Discord's gateway at T; "no gateway connection observed" or "gateway health unverified" must be reported as such. A login time alone does not prove current connectivity. Report the observation time and any missing evidence. Monitor any restart/observation command rather than blocking intake; never repeat an uncertain restart. `helio release wait --invocation ID` performs only bounded read-only observations.

- The WSL `elo-bot` SSH alias and key were verified with read-only access on November 2, 2026; the `elobot` service was active. SSH host-key trust was established on first use. On November 2, 2026, `sudo -n -l /usr/bin/systemctl restart elobot` confirmed the SSH account was authorized to run that exact command without prompting; no restart was performed. Recheck permissions before any separately approved restart. For read-only Git inspection under `/opt/elobot`, use `git -c safe.directory=/opt/elobot -C /opt/elobot ...` if Git reports a different owner; do not change global Git trust settings.
- The live service was observed to run `/usr/local/sbin/elobot-update` before starting the bot. Its observed configuration follows `main` with `update_on_start` enabled; the updater fetches that branch, fast-forwards the checkout, and may install dependencies. Inspect the live configuration again before acting.
- On November 2, 2026, read-only inspection found `elobot` active and running, configured to start `main.py` and update the `main` branch on startup. The live service referenced the documented updater and launcher, and the updater matched the local cloud-init version. Recheck these point-in-time observations before a restart. A restart may deploy a newer branch tip, not merely restart the current code.
- Never run the cloud-init script as a routine update: it installs and configures server resources and can restart the service.

## Before requesting production approval

1. Reproduce and fix within the authorized scope, run the required automated checks (live beta only if the owner or a trusted user asked for it), and report failures or missing evidence. Commit and push only the authorized, verified working branch. A branch push does not update production.
2. Tell the owner which PR or commits are ready and the test results. Get explicit confirmation for the PR merge from the owner or a currently trusted user in an allowed channel/thread or DM. A merge confirmation is not automatically a restart confirmation; obtain both unless the authorized sender explicitly confirms both actions and their targets.
3. Identify the exact resulting commit intended for deployment. If the target branch includes other changes since the server's current revision, name the full set in the restart question; the owner's or a trusted user's confirmation covers everything named.

## Read-only production inspection

Read-only server access is permitted. Do not disclose credentials, tokens or environment-file contents. Production database access remains subject to the existing work policy.

1. Connect to the documented alias with normal SSH authentication. Do not copy keys, extract tokens, or work around an SSH or sudo denial; report it and ask the owner to resolve access.
2. Inspect the live service definition and status, current checkout branch and commit, and only the relevant non-secret config fields (`repository_branch`, `update_on_start`, and `start_file`). Confirm the host, `/opt/elobot` checkout, service name and update mechanism match this procedure. Read the necessary journal entries without exposing secrets or unrelated data.
3. Check for tracked or untracked server changes that an update could affect. Do not reset, clean, stash, overwrite, or discard them. Stop and report unexpected state.
4. Confirm the actual remote branch tip and the full set of commits it would introduce. The tip to be deployed must match the commit confirmed by the authorized sender. If the live service differs from the documented updater, if automatic update is off, or if the revision or intended changes do not match, stop and get an updated plan and approval.

The local command reference provides the following, but it does not prove the server will accept them:

```sh
ssh elo-bot
sudo systemctl status elobot --no-pager -l
sudo journalctl -u elobot -n 50 --no-pager
```

Ask the owner to enter any SSH or sudo authentication themselves; never request passwords or tokens in chat. A permission denial is a stop, not a cue to try another account or access path. The permission check is read-only; do not treat it as a restart or as approval.

## Approved deployment and restart

1. Immediately before acting, verify permission again with `sudo -n -l /usr/bin/systemctl restart elobot`, then reconfirm the exact target and explicit confirmation from the owner or a currently trusted user in an allowed channel/thread or DM to restart `elobot` at the intended revision. Verify the branch tip still matches the approved commit. A restart that invokes the documented updater can fetch and install new code and dependencies; the trusted user's confirmation covers only that existing automatic behavior, not a separate deployment command or other server changes.
2. Run the documented command **once**:

   ```sh
   sudo -n /usr/bin/systemctl restart elobot
   ```

3. Wait for the command to finish; the documented service allows up to 15 minutes for startup. On timeout, disconnect, or an error, inspect status and logs before considering any further action. Never blindly repeat the restart.
4. Verify the actual checkout commit, service status and recent startup logs. Compare the resulting commit with the approved one, confirm the bot logged in as the intended production bot, and check for startup or update errors. An active systemd process alone is not proof the bot is ready. Use a separately approved, non-disruptive production check if one is needed to verify user-visible behavior.
5. Report the previous and resulting commit, service and login status, evidence, and any error or mismatch in the conversation where the approval was given. If the branch advanced during the restart or another commit was deployed, report the exact observed result rather than claiming the approved revision was deployed.

If update, startup or verification fails, preserve evidence and report the failure. Do not run cloud-init, change credentials, force Git operations, perform an unapproved rollback, or repeatedly restart. A rollback needs its own verified procedure and explicit owner approval; the documented updater may otherwise fast-forward back to the current branch tip.

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

Merge and restart in one message ("merge #6 and restart the bot") is one merge train with `--restart`: `helio merge run` restarts once, on exactly the merged and tested tree.

## Button confirmations

Prefer buttons to typed confirmations for restarts and PRs; only the lead asks. Merges use the merge train above, never these prompts.
1. Post the prompt in the request's conversation: `helio question ask --action restart --target elobot --revision FULL_MAIN_SHA --channel CHANNEL_ID --reply-to MESSAGE_ID` (merges never use this; see Merging PRs). Without `--channel` it goes to the trusted chat and pings the owner and trusted users. It prints `CONFIRM_*` lines; for a restart it checks GitHub and holds first. Running it again returns the open prompt instead of posting another.
2. Wait for `INBOUND_CONFIRM` with that prompt ID. On `confirmed`, run `helio release-check --confirmation ID --action ACTION --target TARGET --revision SHA`, then `helio confirm use ID` immediately before acting. For a restart, pass the `result` and `channel` it prints to `helio release restart --channel CHANNEL --message RESULT --revision SHA`. On `cancelled`, `expired` or `lapsed`, do nothing; ask again only if the request still stands.
3. A merge or restart prompt or confirmation stays usable for 12 hours while its pinned revision is unchanged; the release check refuses it if the revision moved. After any restart, check `helio confirm list` and re-check current state before using a confirmation.
4. Discord records who clicked which prompt, not which button; Helio's prompt and result wording carry the rest. Typed approvals remain valid; after one, leave the prompt to expire and never cancel it.
