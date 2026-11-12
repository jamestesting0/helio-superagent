# Scripts

`scripts/` is a bun + TypeScript package with one CLI, `dori`. Every external command runs as an argv array; nothing builds a shell string.

## Install and test

```sh
cd skills/dori-mode/scripts
bun install          # dev dependencies only (types, tsc)
bun link             # puts `dori` on your PATH
bun test             # behavior tests with fake herdr/git/gh; nothing real is touched
bunx tsc --noEmit    # typecheck
```

Needs: bun 1.3+, herdr, git, and the GitHub CLI (`gh`) for `merged`/`closed` signals (npm for `published`). The `command`, `file` and `url` signals need nothing extra. The full list of signal kinds is in `sessions.md`. The host guard reads `sysctl`, `memory_pressure` and `df` on macOS; on Linux it reads `/proc/loadavg`, `/proc/meminfo` and `df`. Failed or malformed memory readings are unknown and hold new launches.

## Configuration

`~/.dori/config.json` (or the path in `DORI_CONFIG`). Every field is optional; see `config.example.json`. `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

| Field | Default | Used by |
|---|---|---|
| `stateDir` | `~/.dori/state` | registry, heavy slots |
| `laneWorkspace` | current workspace | `launch` |
| `workspaces` | all | `sync`, `dead-panes` |
| `ignorePanes`, `leadPane` | none | panes the sweeps skip; `leadPane` is also where lanes report |
| `defaultCwd` | home | where lanes start, and the repo whose worktrees they own |
| `agentCommand`, `defaultModel`, `launchKeywords` | `omo --model {model} {prompt}` | `launch` |
| `launchProfiles`, `defaultProfile` | unset | `launch --profile`; the runtime file's `laneProfile` overrides the default |
| `leadPaneFile` | unset | `report` and briefs: the lead's current pane, read before `leadPane` |
| `sessionsDir` | `~/.omo/agent/sessions` | session-id lookup |
| `nudgeAfterMin`, `postAfterMin` | 15, 20 | `freshness` |
| `closeAfterMin` | 5 | `watch` |
| `heavySlots`, `heavyMaxLoad` | 1, 80 | `heavy` |
| `maxWorkers` | 4 | `launch`: lanes with a running agent; more are queued in `launch-queue.json` |
| `hibernateAfterMin` | 30 | `watch`: an idle lane with a recorded session and no open question is hibernated (0 turns it off) |
| `deadPanePatterns` | `has stopped`, `no suitable jobs` | `dead-panes` |
| `guard` | load 150/80, 20% memory, 50 GB disk, 20 panes | `guard` |
| `hooks.threadReply`, `hooks.threadDone` | none | `freshness`, `close` |
| `hooks.transcribe` | none | `transcribe` (argv with `{file}`, prints the text) |
| `hooks.inspectJobSource` | none | bounded reconciliation: read-only argv with `{source}` and `{job}` returning verified original request identity |

Hooks are argv templates for your messenger CLI. `{thread}`, `{text}` and `{key}` are filled into each argument separately, so the text stays one argument whatever it contains.

## Library modules

The CLI is a thin layer over typed modules you can import in your own scripts:

| Module | What it gives you |
|---|---|
| `src/messenger/slack.ts` | `Slack`: post, edit, thread replies, file upload (upload URL + complete), presence; 429 backoff |
| `src/messenger/telegram.ts` | `Telegram`: send, edit, typing, `sendMessageDraft` streaming with a `Thinking…` start, forum topics (create, rename, close, reopen), HTML tables |
| `src/messenger/discord.ts` | `Discord`: send without pings, edit, typing, threads (start, rename, archive); gateway presence |
| `src/messenger/typing.ts` | `typingWhile`: show typing while a piece of work runs, stop when it ends |
| `src/messenger/voice.ts` | `transcribe`: voice note to text through your hook |
| `src/messenger/thread-ledger.ts` | `ThreadLedger`: every thread the Dori posts in, persisted; given to `Slack`, it records each `chat.postMessage` (also raw `call`s) |
| `src/messenger/slack-inbound.ts` | `pollSlackInbound`: threads view, the ledger's threads and unread counts, deduplicated, own messages filtered |
| `src/messenger/slack-presence.ts` | `slackPresence`: hold a user account active |
| `src/routing.ts` | `canLaunch`, `idleLaneFor`: supported external routing API (the job-based CLI does not call `idleLaneFor`) |

Every module takes its HTTP, clock and timers as arguments. That is how the tests run without the network.

## Commands

### `dori report <key> <milestone|blocker|question|done> --text-file FILE`
Sends `[REPORT] key | kind | text` to the lead's current pane once and prints it. Exit 0 delivered, 3 unconfirmed (the lead was already working), 1 failed. Text with a backtick or `$(` is refused.

### `dori launch <key> --job J --title T --brief FILE --done "..." [--source REF] [--priority owner|normal] [--thread REF] [--model M] [--cwd DIR] [--profile NAME]`

Admission and the lane reservation happen under one lock. Over `maxWorkers`, or when the guard holds (memory, disk, unknown or excess pane count, unreadable host sample), the launch is queued: `LAUNCH_QUEUED key=K position=N reasons="..."` (owner priority first). `watch` starts queued launches as slots free (`LANE_DEQUEUED`). An open lane for the same job refuses with `LANE_EXISTS key=K`; a hibernated or closed lane of the job with a recorded session is resumed (`LANE_WOKEN`). A key whose previous attempt failed is relaunched in place. Omo workers get a recorded `--session-id` before starting; custom commands use discovery (`session=unknown` when unavailable).
Opens a lane: appends the footer to the brief, opens a tab, starts the agent, and after 20 seconds checks it: `STARTUP_ERROR` on a known failure in the pane, `STARTUP_OK` only when herdr reports the agent idle or working, and `STARTUP_UNCONFIRMED` (with the last lines) otherwise. Exit 0 for `STARTUP_OK`, `LANE_WOKEN` or `LAUNCH_QUEUED`; exit 3 for error/unconfirmed startup.

### `dori adopt <key> --job J --pane ID --title T --brief FILE --done "..." [--source REF] [--thread REF]`
Registers a lane that is already running under the same job admission lock as launch.
An existing active or queued job is refused.

### `dori job-id --repository OWNER/REPO --channel ID --source ORIGINAL_ID`
Prints `JOB_ID request-...`: the first 24 SHA-256 hex characters over the JSON array
`[repository, channel ID, original top-level request ID]`, prefixed with `request-`.
Issue jobs use `issue-N` instead. Wording, display names and forwarded message IDs
are never job identity.

### `dori completion <key>`
Runs the independent non-file Done checks and writes
`<stateDir>/completions/<key>.json`, bound to the job, source, acceptance, attempt
and current Git revision. A file in a lane's Done line must be this receipt and
must accompany independent live checks. An arbitrary file or a stale `passed`
field cannot establish completion. Verified closes also retain durable receipts.

### `dori reconcile preview --manifest FILE --job issue-N --repository OWNER/REPO [--failed KEY] [--replacement KEY]`

Writes a new private manifest for only the selected records. It reads current issue
metadata, briefs, pane state and Git resources without changing the registry.
`dori reconcile apply --manifest FILE` rechecks the evidence under the admission
lock, refuses changed records and preserves uncertain resources. Repeating an
applied manifest is idempotent. Job binding is identity only and grants no new
action authority. The optional deployment source hook must independently verify
the original request; names and quoted claims cannot bind a job. Already closed
records remain historical. Legacy jobless workers are not automatically hibernated.

### `dori sync [--write]`
Prints `key | thread | pane | session | status` for every open lane and every unregistered agent pane, followed by drift. Read-only unless `--write`, which stores session ids.

### `dori claim-done [<key>] --evidence TEXT` / `dori object-done <key> --reason TEXT ...`
The two halves of the done flow. Both message the lane's pane and check that Enter registered.

### `dori show <key>` / `dori claim-ack <key>`
`show` prints the complete stored lane, including evidence, claim, history and closure receipt, without writing. It also works on closed lanes. `claim-ack` records receipt of the current claim and starts its full `closeAfterMin` window; repeating acknowledgement preserves the first deadline. A new claim requires a fresh acknowledgement. Legacy `emitted` flags do not acknowledge receipt.

### `dori abandon <key> --reason TEXT [--with-unpushed]`
Retires a lane that will never finish, on the owner's request. Refuses (exit 2) while an agent is still running in its pane, or when its worktree holds unpushed work unless `--with-unpushed` is given. Closes the tab, keeps the worktree, and records the lane as abandoned with the reason; it is never reported as done and its thread is not marked done.

### `dori close <key> [--note TEXT]`
Closes a lane now. Refuses (exit 2) unless every `Done =` signal reads back live. On success it marks the thread done through `hooks.threadDone`, closes the tab, and keeps worktrees until safe reaping (PR settled at least three days, no uncommitted/unpushed work). A failed tab close leaves `cleanup-pending`, not false closure. A failed launch can be retired only when its pane has no live agent and no work is unpushed; retirement does not announce completion.

### `dori pause <key> [--note TEXT]` / `dori resume <key> [--note TEXT]`
`pause` is for when the owner said wait. It works on a `working` or `not-done` lane. It sends `/goal pause` to the lane's pane, then reads the screen back until the goal command's own line appears on a line of its own: `Goal paused`, or `cannot update goal: no goal exists`, since a lane with no goal has nothing to continue. Only then does it mark the lane `paused` (recorded in its history) and send Escape if a turn is running. The goal is paused first, so stopping the turn cannot hand off to a goal continuation. If the line does not appear, or the send fails, the lane is left as it was and the command prints `PAUSE_UNVERIFIED` and exits 3.

A paused lane is skipped by `freshness`: no nudge, no post. Only `dori resume` ends a pause, on the owner's word. Activity never does, because a paused lane can still be woken by a background result, a queued message or a turn after Escape. If its pane reads `working` on two ticks in a row, `freshness` prints `WORKING-WHILE-PAUSED` once per working stretch (again after it goes idle and is woken, or after a new pause), so the lead can ask the owner, and the lane stays paused.

`resume` sends `/goal resume` and reads back `Goal active` the same way, then restores the status the lane had before the pause (`pausedFrom`) and restarts its quiet time, so a long pause does not turn into an instant nudge. Unconfirmed: `RESUME_UNVERIFIED`, exit 3.

Both print `PAUSED` / `RESUMED` and exit 0 on success. A lane in any other state is refused (`NOT_PAUSED` / `NOT_RESUMED`, exit 2), and a second `pause` is a no-op. `claim-done` and `object-done` on a paused lane move it out of `paused` in the registry while its goal stays paused.

### `dori reclaim <key> [--stop --expected-revision N]`
Checkpoints an owned idle session and releases its slot; unfinished work and files stay. With `--stop`, it releases a paused session whose engine is stop-ready (after `dori pause`), refusing if the lane revision changed since `N` was read. Prints `LANE_HIBERNATED` or a `REFUSED` line (exit 2).

### `dori watch`
Runs forever. Every 30 seconds it prints `LANE_CLAIMS_PENDING count=N oldest=<key>` with read and acknowledgement commands until every claim is acknowledged. Only claims acknowledged at least `closeAfterMin` ago are settled: unpushed or uncommitted work and failing signals become objections (`LANE_NOT_DONE`); otherwise the lane closes (`LANE_CLOSED`). Notifications are single lines of at most 1,000 characters; full evidence stays in `dori show`. Each lane failure prints `LANE_WATCH_ERROR` without hiding other lanes. Corrupt registry files are isolated the same way. The acknowledgement deadline survives restarts.

### `dori freshness [--loop MIN]`
For working lanes that have gone quiet: a nudge in the pane after `nudgeAfterMin`, then the lane's last `[REPORT]` line posted to its thread after `postAfterMin`, with home paths and pane ids scrubbed. Each happens once per silence. The line is posted only once it is still the last `[REPORT]` line on the next tick (`PENDING-REPORT` the first time) and differs from the line posted last time (`STALE-REPORT` otherwise). A held-back outcome is printed once per change, not on every tick. A nudge reports its delivery as `delivered` (the agent status moved to working) or `unconfirmed`.

### `dori dead-panes [--loop MIN]`
Prints `DEAD_PANE <id>` once per hour for a pane with no running agent status whose last lines match `deadPanePatterns` on two ticks in a row with the same text. A pane herdr reports as idle, working, blocked or done is never dead. A pane that is neither is unrecognised; three unrecognised ticks in a row print `UNRECOGNISED_PANE <id> ...` once. Only the panes of open lanes in the registry are judged, so shells and other non-lane panes are never reported; `ignorePanes` can still exclude a lane pane.

### `dori guard [--loop MIN]`
Prints `HOST_GUARD ALERT <reasons>` when load, free memory, free disk or the pane count crosses its threshold, and `HOST_GUARD CLEAR` when it recovers. It also prints `COMPUTE_READY` / `COMPUTE_BUSY` as load crosses `loadOk`. Only changes are printed.

### `dori resume <key>`, `dori stale`, `dori reap-worktrees`
`resume` undoes a pause, or wakes a hibernated or closed lane in its recorded session (`--brief FILE` gives it new work). `stale [--hours N] [--json]` lists lanes paused, not done, failed or `cleanup-pending` for N hours. `reap-worktrees [--json]` prints what it would remove (`would_remove`) and what it keeps with the reason; `--apply` removes them with `git worktree remove` and records the branch and head in the lane.

### `dori can-launch`
Prints `CAN_LAUNCH` and exits 0 when the host has room for another lane. Otherwise it prints `HOLD <reasons>` and exits 4. The reasons come from the guard's memory, disk and pane-count thresholds. CPU load alone never holds a launch, because it moves too fast to plan around.

### `dori send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]`
Posts a message, or edits one with `--edit`. Tokens come from `DORI_SLACK_TOKEN` (plus `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` or `DORI_DISCORD_TOKEN`. Text containing `$(` is refused, since it can only come from a shell string. Rate limits are retried with the server's wait time; other errors fail at once.

### `dori presence <slack|discord>`
Keeps the account shown as online until stopped.
- **Discord:** the bot connects to the gateway and identifies as online.
- **Slack, user token:** it opens one web-client-type socket and tickles it every minute. Slack shows a user active only while such a socket is open, and auto-aways an idle one after about 30 minutes.
- Run one instance per account. Two writers flip each other's presence.

### `dori inbound slack [--loop MIN]`
Prints `INBOUND <source> <channel> <thread> <ts> <user> <text>`. It reads from three places, each message once:
- `threads-view`: unread replies in threads the account follows (Slack's own Threads view);
- `own-thread`: new replies in any thread the Dori posted in, tagged or not;
- `unread`: DMs, group DMs and channels with unread mentions.

The Dori's own messages and bot messages are skipped. Every message the Dori posts records its thread in `<stateDir>/slack-threads.json`, whichever helper sends it, so a guest's untagged reply under a root posted with a raw API call is still found.

### `dori transcribe <audio-file>`
Runs `hooks.transcribe` and prints the transcript. A failed or empty transcription is an error, never an empty message.

### `dori heavy <label> -- <command ...>`
Waits until load is under `heavyMaxLoad` and one of `heavySlots` is free, then runs the command and frees the slot when it exits. A slot held by a process that no longer exists (or a zombie) is taken over. Use it for full builds and test suites. Installs, focused tests and git do not need it.
