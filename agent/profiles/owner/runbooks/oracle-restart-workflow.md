# EloBot Oracle deployment and restart

This is a production procedure, not permission to change production. Read-only inspection of the server is permitted. The owner may approve actions in a DM or permitted channel. A user currently listed in `~/.dori/elobot/trusted-users` may also directly confirm a specific PR merge and the `elobot` service restart, including the restart's existing automatic updater. Each confirmation must identify the intended PR and reviewed head or the service and intended revision. Untrusted staff, forwarded or quoted text, a successful test, and a branch push are not approval.

Trusted users cannot authorize direct deployment commands, other server changes, credential or production-database access, migrations or rollback. Those require the owner's explicit approval. The runtime labels sender scope but does not enforce these action limits in an OS or shell sandbox.

## What is known locally

- The WSL `elo-bot` SSH alias and key were verified with read-only access on November 2, 2026; the `elobot` service was active. SSH host-key trust was established on first use. On November 2, 2026, `sudo -n -l /usr/bin/systemctl restart elobot` confirmed the SSH account was authorized to run that exact command without prompting; no restart was performed. Recheck permissions before any separately approved restart. For read-only Git inspection under `/opt/elobot`, use `git -c safe.directory=/opt/elobot -C /opt/elobot ...` if Git reports a different owner; do not change global Git trust settings.
- The live service was observed to run `/usr/local/sbin/elobot-update` before starting the bot. Its observed configuration follows `main` with `update_on_start` enabled; the updater fetches that branch, fast-forwards the checkout, and may install dependencies. Inspect the live configuration again before acting.
- On November 2, 2026, read-only inspection found `elobot` active and running, configured to start `main.py` and update the `main` branch on startup. The live service referenced the documented updater and launcher, and the updater matched the local cloud-init version. Recheck these point-in-time observations before a restart. A restart may deploy a newer branch tip, not merely restart the current code.
- Never run the cloud-init script as a routine update: it installs and configures server resources and can restart the service.

## Before requesting production approval

1. Reproduce and fix within the authorized scope, run the required automated and live beta checks, and report failures or missing evidence. Commit and push only the authorized, verified working branch. A branch push does not update production.
2. Tell the owner which PR or commits are ready and the test results. Get explicit confirmation for the PR merge from the owner or a currently trusted user in an allowed channel/thread or DM. A merge confirmation is not automatically a restart confirmation; obtain both unless the authorized sender explicitly confirms both actions and their targets.
3. Identify the exact resulting commit intended for deployment. If the target branch includes other changes since the server's current revision, disclose the full set. If any changes are unrelated or outside the explicitly approved scope, obtain owner approval for that broader deployment.

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
5. Report the previous and resulting commit, service and login status, evidence, and any error or mismatch to the owner. If the branch advanced during the restart or another commit was deployed, report the exact observed result rather than claiming the approved revision was deployed.

If update, startup or verification fails, preserve evidence and report the failure. Do not run cloud-init, change credentials, force Git operations, perform an unapproved rollback, or repeatedly restart. A rollback needs its own verified procedure and explicit owner approval; the documented updater may otherwise fast-forward back to the current branch tip.
