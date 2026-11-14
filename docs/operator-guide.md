# Helio: the EloBot Dori

Helio is an always-on agent (Dori mode) that you talk to on Discord. It answers questions, runs EloBot jobs in their own omo sessions (lanes), and reports back in threads. It runs while WSL and its herdr session are running.

The agent's rules live in `agent/prompts/lead.md` (lead only) and `agent/prompts/policy.md` (lead and every worker), plus a profile overlay in `agent/profiles/<profile>/`. This guide covers operation; it doesn't restate those rules.

## Runtime profiles

Helio installs in one of two profiles. Most of this guide applies to both; differences are marked **Owner** or **Isolated**.

| | Owner | Isolated |
|---|---|---|
| Runs as | Your WSL user, in your normal home | A separate isolated WSL runtime with its own user, home and EloBot checkout |
| EloBot checkout | Your WSL clone and shared venv | An isolated copy of your WSL checkout, not synced automatically |
| Oracle restart | Direct `ssh elo-bot` with verified non-interactive sudo for `systemctl restart elobot` | Only through the `helio release` broker; the agent has no Oracle SSH key |
| Beta maintenance | Mutation path not enabled; no new beta process or beta data writes until the prerequisites are verified | Protected `helio beta` service enabled for single-record edits |
| Starting beta | `"$HELIO_PROJECT/.venv/bin/python" -u beta.py` | `helio beta run --check`, then `helio beta run` |

## Who can do what

| Where | Who | Can |
|---|---|---|
| DM to Helio | You (653894110884921366) and configured trusted users | You: request work. Trusted users: request verified-fix commits and pushes, PR creation, and issue closure; new work after closure gets a linked new issue. They explicitly confirm PR merges and `elobot` restarts. Other DMs are dropped. |
| Trusted chat and its threads | Anyone who can post there, except bots | Every explicit human @Helio ping receives a response, even if only a brief out-of-scope boundary; an unrelated reply to Helio gets none. User authority is unchanged. |
| Normal chats and their threads | Anyone who can post there, except bots | Read messages explicitly pinging Helio, plus a person's answers while Helio has an open conversation with them there; help with EloBot bugs, user-facing problems, quality-of-life improvements and feature requests, and ignore irrelevant pings. Reporting does not authorize a PR, merge or restart. |
| Anywhere else | Nobody | Dropped before Helio sees it |

One bot exception is configured by `inbound`: Elo Bot
`1212767017917218876` in exact channel `1566842840716152962` is delivered as
`BOT_BUG_REPORT` / `evidence-only`. The channel must also be directly in the
inbound allowlist. This does not allow that bot's DMs, child threads, other
channels, webhooks, or Helio's own messages, and it never grants owner or
trusted-user authority. Other bots remain excluded from inbound.

Trusted chat: `1218071208197623880` (EloBot helper-chat). Normal chats: `1199770187738644652` and `1220331873079922810`. The separate evidence-only report channel is `1566842840716152962`. Channel trust changes response behavior, not sender authority. Questions about codebase files or implementation are out of scope in shared chats; the owner and trusted users retain their existing DM workflow. The inbound configuration lists individual channels, not a category-wide grant. Helio's access check for the evidence-only report channel returned Discord HTTP 403 on November 2, 2026; adding an ID to the allowlist does not grant Discord permissions.

Learning channels: only direct text/announcement channels under EloBot category `1210854061050691654`, excluding `#elo-matches` (`1222942524839165982`) and normal chats. Bot and webhook messages are not learned. Category `888075523044040728` is excluded. No other categories, threads, or forum posts are read for learning. Reading is read-only; replies remain limited to the separate inbound allowlist. Helio runs `~/.dori/elobot/context --loop` as one persistent monitor, refreshing immediately and every 30 minutes.

## Files

| Path | What |
|---|---|
| `~/.config/helio/helio.env` | The one file you edit: secrets, channel and people IDs, paths, models. `helio update` generates the files below from it |
| `~/.dori/elobot/env` | Token, channels, paths and models for every Helio process (mode 600); generated from `helio.env` |
| `~/.dori/elobot/beta.env`, `beta-mongo.env` | Beta bot and restricted beta database credentials (mode 600); generated from `helio.env`, read only by the beta launcher |
| `~/.dori/elobot/config.json` | Dori settings: state folder, lane folder, lane command, thread hooks |
| `~/.dori/elobot/start` | Starts the lead in the current herdr pane |
| `~/.dori/elobot/browser-env` | BrowserSkill executable path for newly started lead and worker sessions |
| `~/.dori/elobot/inbound` | Discord watcher with the filter and catch-up; the lead runs it as a monitor |
| `~/.dori/elobot/trusted-users` | Comma-separated Discord user IDs with the trusted scope; generated from `HELIO_TRUSTED_USERS` |
| `~/.dori/elobot/report-channels` | Channel IDs whose human staff can report bugs and features for GitHub issue creation; generated from `HELIO_REPORT_CHANNELS` |
| `~/.dori/elobot/release-approvers` | IDs allowed to approve releases; generated from `HELIO_RELEASE_APPROVERS` |
| `~/.dori/elobot/context` | Read-only reader of the learning channels (`DORI_DISCORD_CONTEXT`) |
| `~/.dori/elobot/ack` | Inspect pending messages or acknowledge completed handling |
| `~/.dori/elobot/reply.ts` | Reply to an exact inbound owner message and ping its author |
| `~/.dori/elobot/setup-prompt.md` | Lead instructions loaded automatically by `start`; built from `agent/prompts/lead.md` plus the profile overlay |
| `~/.dori/elobot/work-policy.md` | Authorization and beta QA rules loaded into lead and workers; built from `agent/prompts/policy.md` plus the profile overlay |
| `~/.dori/elobot/docs/` | Installed agent runbooks; the previous root paths remain compatibility links. This guide is not installed. |
| `~/.dori/elobot/docs/beta-maintenance-workflow.md` | Profile-specific beta maintenance procedure |
| `~/.dori/elobot/docs/discord-qa-workflow.md` | Step-by-step beta launch, multi-account real-command testing, screenshots, and cleanup |
| `~/.dori/elobot/docs/oracle-restart-workflow.md` | Approval-gated Oracle production inspection, deployment and restart procedure |
| `~/.dori/elobot/state/` | Lane registry, fetch cursors (`discord-inbound.json`, `discord-context.json`), durable pending deliveries (`discord-delivery.sqlite`) |
| `~/.dori/discord-inbound/` | Filter code and tests (`bun test` there) |
| `~/PythonProjects/elo-bot/` | **Owner:** WSL clone and shared Python venv. **Isolated:** isolated copy of the WSL EloBot checkout and venv. Workers use worktrees and the private beta-only environment. |

## Permissions

Trusted users, report channels and release approvers are edited in `~/.config/helio/helio.env` through `HELIO_TRUSTED_USERS`, `HELIO_REPORT_CHANNELS` and `HELIO_RELEASE_APPROVERS`. Run `helio update` afterwards. Don't edit the generated files under `~/.dori/elobot/` directly. Adding a channel ID doesn't grant Discord permissions; Helio's role still needs access in Discord.

## Start

**Owner:** in Ubuntu, run `helio` to open the `elobot` Herdr session. In a Herdr pane, run `helio start` for a new lead session or `helio resume` to reopen the latest Helio lead session. Exit an already-running lead before resuming. It loads the setup instructions and automatically asks the lead to start or recover its monitors. Check its readiness report and verify Discord communication.

**Isolated:** the isolated EloBot checkout is a separate copy of your original WSL checkout, created from the same revision and pointing to `jamestesting0/elo-bot`. Changes do not automatically appear in the original checkout; use Git fetch, push and pull as appropriate. Helio's memory and sessions in the isolated home are likewise separate after migration.

**Isolated:** in a normal Ubuntu shell, run `helio start` for a new lead session or `helio resume` to reopen the latest Helio lead session. The isolated Herdr workspace opens and the lead initializes or recovers its monitors. Check its readiness report and Discord communication. `helio` without arguments opens the isolated Herdr workspace without starting the lead.

Keep Windows and WSL running while Helio is in use.

## Stop

- Pause one job: tell Helio "wait" or "hold" in its thread, or run `dori pause <key>` (resume with `dori resume <key>`).
- **Owner:** exit omo in the lead pane, then close the herdr session. Close lanes first if any are still working (`dori sync` lists them).
- **Isolated:** pause individual work first if needed. To close the isolated workspace, press `Ctrl+B`, then `Q`, or close the terminal. The private Herdr server, lead, workers and monitors stop with it. Start again with `helio resume` when you want to continue the last session; use `helio start` after a configuration change.

## Catch-up after being off

On every start the watcher fetches what was posted since it last ran, in allowed channels, accessible active and recently archived threads, and owner/trusted-user DMs. It delivers eligible messages with `"backlog": true` before live messages. `INBOUND_READY ... backlog=N` says how many were delivered.

- Limits: messages from the last 3 days, at most 100 eligible messages per channel (newest kept), scanning at most 20 pages; `INBOUND_BACKLOG_TRUNCATED` warns when coverage was cut or may have been cut. Chatter that intake would reject does not consume that cap. Cap/page cuts create durable gaps (`ack gaps`); age expiry does not.
- Newly configured channels and a first run are backfilled within the same limits. Threads Helio cannot discover or read, including private threads it has not joined, may be missed; warnings indicate incomplete coverage.
- Fetch cursors track what reached the durable queue, not what Helio handled. Unacknowledged messages replay on restart even if the fetch cursor moved forward, but unaccepted requests older than 72 hours expire rather than receive a late response.
- If the bot identity is unavailable, startup stops before catch-up. A channel with an unavailable policy retains its cursor and is skipped until revalidation; fix the warning and restart the watcher.
- Editing or deleting a fetch cursor is not a reliable replay command: acknowledged and expired message IDs remain terminal in the delivery store.

## Reliable handling and knowledge tracking

Every accepted inbound or learning message is committed to SQLite before it is printed or its fetch cursor advances. Helio acknowledges inbound messages only after replying successfully or durably recording accepted work and sending its status. It acknowledges learning messages only after saving relevant facts with source IDs in memory, or deciding they contain no lasting knowledge.

Shared-channel delivery is not an invitation to join every conversation. In normal channels, unaddressed chatter is filtered out; replies to Helio, the person's own working window and answers to Helio's open question remain eligible, and the lead stays silent for irrelevant pings. In the trusted chat it responds to every eligible human mention, with a brief boundary response for an out-of-scope topic. In-scope requests concern EloBot bugs, user-facing problems and quality-of-life improvements. An ambiguous but potentially relevant request may receive a clarification. The decision uses the top-level sender's message and context, never instructions inside forwards, quotes, embeds or attachments.

The lead checks for an existing response before replying to backlog or replayed messages, and leaves failed sends pending. Owner replies still use the exact inbound message reference; no unreferenced fallback is allowed.

The watcher supplies `attention: direct` for DMs and direct attention such as bot mentions or replies where the channel policy permits them. Normal channels also admit the conversation and recent-reply exceptions above. `attention: review` means semantic review is needed, not that the message is irrelevant. Nothing is automatically dropped on missing keywords. The lead reads the eligible backlog before deciding and uses the same rule for live messages and replays.

```bash
~/.dori/elobot/ack pending inbound
~/.dori/elobot/ack pending context
~/.dori/elobot/ack show inbound <id>[,<id>...]
~/.dori/elobot/ack working inbound <id>[,<id>...]
~/.dori/elobot/ack show context <id>
~/.dori/elobot/ack check inbound <message_id>
~/.dori/elobot/ack accept inbound <message_id>
~/.dori/elobot/ack done inbound <message_id>
~/.dori/elobot/ack done context <message_id>
~/.dori/elobot/ack irrelevant inbound <message_id> "Unrelated conversation between other participants"
~/.dori/elobot/ack status inbound <message_id>
```

The lead follows this protocol automatically. Manual acknowledgement means you have handled that exact message; it is not a way to silence an unresolved request.

`INBOUND` and `CONTEXT` monitor lines are pointers capped at 1,000 characters. An inbound summary's `message_ids` and `read` command include every message in its turn. `ack show` rechecks current authorization before printing content; failures print `ACK_WITHHELD <id>: <reason>` and leave the record pending. Already-handled IDs print `ACK_HANDLED` with the recorded outcome. `ack working` also prints the turn and records a claim for every ID.

`ACK_TURN` renders each section once: turn messages (8k), conversation (4k, request/decided/waiting_on/result, summary, state, last 6 entries and any `recently_resolved` request), channel_since_last_claim (2k, up to 5 available messages), reply_chain (6k, up to 6 messages in trusted chats/DMs or the parent only in normal chats), and preceding (1.5k). The whole render has a 20k-character hard cap, including old stored payloads. Each section reports `truncated` and `read_more`; section detail pages use `ack show inbound <ids> --section <section> --offset N`. Learning details use `ack show context <id> --offset N`. Detail pages contain a slice of serialized JSON in `content`; concatenate the slices to recover the complete detail.

Pending listings stay within 50 KB per page. Follow `ACK_PENDING ... next="ack pending <stream> --after <id>"` until no next command remains. Independently of reaction upkeep, the inbound watcher checks every five minutes and prints one `INBOUND_PENDING count=N oldest=<id>` for aged pending messages without a claim or accepted work; it stops at zero. An intake monitor overflow means run `ack pending inbound`; read other monitors' overflow files.

The working receipt is a persistent claim, separate from its reaction. An explicit ping in a DM, the trusted chat or its threads is claimed on arrival. All other messages, including normal-chat pings and open-conversation chatter, receive a reaction only after `ack working`. A ping opens an invisible intake window; claims also admit additions from that person in that channel for up to 30 minutes. Unclaimed chatter and reply-guard rows cannot anchor additions. Replies (including covered messages), done, irrelevant, expiry, deletion and two-hour abandonment finish claims. Only `syncReceipts` changes reactions, after claims/finishes and at startup/upkeep; failed operations converge on persisted state. Reaction 403s are silent, and 429s wait for the next upkeep. No Discord request holds a database transaction.

`helio status` and the startup greeting distinguish unclaimed pending messages, claims in progress and conversations waiting on Helio. A claim counts even when Discord forbids its reaction.

## Conversations

A topic is one subject, named by the message it started from (its topic ID), and can involve several people in several channels. Open one when asking someone a question. People join only when Helio's topic reply answers or covers them, or through `join`; a passing message joins nothing. In normal chats, answers to Helio's delivered question in that channel and replies into a topic's messages are admitted without a ping. New participant messages need Helio; otherwise structured `waiting_on` identifies who owes the next reply, and `on_hold` carries its reason and suspends timers. Each person may have two open topics they opened. A topic shows each place only what its audience may see.

```bash
helio conversation open ANCHOR_MESSAGE short title
helio conversation list [--channel C] [--user U] [--offset N]
helio conversation show TOPIC [--offset N]
helio conversation set TOPIC --request TEXT --decided TEXT --waiting-on TEXT --result TEXT [--issue URL]
helio conversation note TOPIC --text-file PATH
helio conversation join TOPIC USER [--message ID]
helio conversation leave TOPIC USER
helio conversation merge FROM_TOPIC INTO_TOPIC
helio conversation hold TOPIC reason
helio conversation resume TOPIC
helio conversation close TOPIC answered
helio conversation close TOPIC issue --issue https://github.com/OWNER/REPO/issues/N
helio conversation reopen TOPIC
```

`list` includes state, participants, age, idle time and summary, with at most 25 rows per page and a byte budget. `show` pages the complete transcript, participants and issue deliveries. `join --message` adds a useful message that needs no answer; `leave` stops a person's closing and issue pings. Linking an issue another active topic already tracks merges the newer topic into the older one. `note` saves at most 600 characters from the existing playback. A claim ends a hold; resume preserves the last real activity and existing nudge record.

While waiting on the requester, upkeep sends one native nudge after 24 hours and a close notice after 72 hours, then resolves with `timed_out`. `INBOUND_CONVERSATION_NUDGE` and `INBOUND_CONVERSATION_TIMEOUT` report notices already sent; do not reply again. Waiting-on-Helio and held conversations never time out. `INBOUND_CONVERSATION_WAITING` lists requests waiting on Helio for at least 24 hours once per UTC day. A deleted anchor, a deleted notice target or a departed server member resolves silently with `other`.

Resolution deletes full transcript text and keeps topic, summary (falling back to topic), outcome and issue. For 7 days `recently_resolved` offers context, and Helio explicitly chooses `reopen` for the same request or `open` for a new one. A claim never reopens automatically. After 7 days rows archive; they disappear 30 days after resolution. Commands default to the latest active topic; use `--topic ANCHOR` for another. Replies route to the topic they answer. Issue follow-ups keep their existing workflow.

Every TypeScript writer applies the conversations rebuild in one immediate transaction guarded by `PRAGMA user_version=1`. Closed and timed-out rows become resolved, preserving outcomes; timeout becomes outcome `timed_out`. Working rows gain `claimed_at` and `intake_at`, separating claims from invisible windows. Transcript columns stay the same; its key includes the conversation so one covered reply can belong to two participants. The `followups` table is preserved, including the Python writer's independent `announcement` migration. The first watcher startup silently resolves legacy open conversations without a post-migration claim as `other` with their topic as summary, listing each as `INBOUND_CONVERSATION_MIGRATED`. Existing pending deliveries, context cursors and lane registry formats are unchanged.

Questions and follow-ups use the same summary contract: `helio question show <id>` and `helio followups show <issue>` read details with optional `--offset N`. `helio question list` returns `items` and `next`; `helio followups list` prints a `FOLLOWUP_PAGE next=...` when needed. Both listings accept `--offset N`. Answered questions recur as one `QUESTION_PENDING count=N status=answered` per check until `helio question ack <id>`. Announced follow-ups recur as one `FOLLOWUP_PENDING count=N` per check until `helio followups done --issue N --user U`. Follow-up details are cached durably before announcement; reading them does not contact GitHub or production.

Fresh installs set `terminal.monitorMaxCharsPerInjection=16384` in the project's `.omo/settings.json`; updates manage only that key and preserve other settings. Roll out the summary protocol, lead instructions and pending reminder together, with one lead restart, to avoid mixing old and new formats.

`irrelevant` is a separate terminal handling disposition: the lead reviewed a shared-channel message and deliberately chose not to respond. It requires a nonempty reason (up to 500 characters). An out-of-scope direct ping in a normal channel may be marked irrelevant; an explicit trusted-chat human ping and the evidence-only bot report may not. One call may dismiss a turn's IDs. Ambiguous intent and failed work stay pending.

The reason, disposition and handling time are committed transactionally with removal from the pending queue. Failure rolls back the decision. `status` also distinguishes `accepted` work and `expired` requests. `check` verifies current authorization and age before a side effect; `accept` records that work has been durably accepted and should not expire just because its request ages. Cleanup happens after commit and can be retried if it fails. The separate handling tables let an already-running watcher continue staging without overwriting another process's decisions.

For owner replies, the lead runs `bun ~/.dori/elobot/reply.ts <channel_id> <message_id> --text-file PATH` with the top-level IDs from the specific inbound owner payload, reading text from a UTF-8 file, never interpolating it into a shell command. It uses Discord's native message reference and reply-author ping, suppresses other mentions, and prints `SENT <reply_id>` only on success. `reply_to` and forwarded source IDs are not the owner message being answered. Missing references or permissions fail without an ordinary-send fallback; the message stays pending. The original stays pending for explicit acknowledgement; covered messages are marked handled. Humans in configured report channels may report bugs and request quality-of-life improvements for GitHub issues; ordinary sends and lane hooks use no-preview GitHub links.

Delivery is at least once. A crash after replying or saving memory but before acknowledgement can replay a completed message. Helio must check existing replies and lane records before repeating actions. A crash before recording irrelevance also replays the message for review; a committed disposition prevents requeueing. Pending payloads remain local until handled; completion removes their content from the logical queue and retains the stream/message ID plus any disposition, reason and handling time. SQLite and session history are not secure-erasure mechanisms.

Learning first samples up to 40 messages per channel from the last 30 days (at least the newest 15 in quiet channels); later refreshes allow 500. `CONTEXT_WITHHELD` counts pending records that cannot safely be replayed under the current channel or human-author policy, including legacy records without verified human provenance. Their contents remain stored and are not printed. Truncation and permission warnings mean coverage is incomplete, not that all server knowledge was learned. Existing fetch cursors are preserved by this upgrade; messages previously marked read without durable delivery cannot be recovered from the queue retroactively.

## Knowledge

`start` runs `~/.dori/elobot/knowledge-setup.py` before launching omo. It also loads the current `setup-prompt.md` with `--append-system-prompt`; no manual paste is needed.

The lead and lanes launched in `~/PythonProjects/elo-bot` use its `.omo/omo.jsonc`: `memory.agent` is `EloBot`. Omo hashes that name to `elobot-31991534`, not the literal existing identity ID. Setup links that entire identity directory to `~/.omo/memory/agents/elobot-ec289b4c`, sharing both `repo` and `runtime` (locks, queues, and recovery state). It never copies or changes the existing memory store. A different occupied alias or `OMO_MEMORY_HOME` stops startup rather than selecting an unknown store. Memory cloud sync is disabled for this local alias so it does not open a separate remote identity.

Bot development and presentation guidance (`docs/bot-ui.md`, `docs/copy-style.md`, `docs/base-fingerprints.md`) is tracked in the EloBot repository, so every checkout and lane worktree already has it. Run `python3 ~/.dori/elobot/knowledge-setup.py` separately to check the memory link without starting the lead.

This project config applies to new lead/lane sessions in this checkout. Existing sessions retain their recorded memory binding; restart them as new sessions after setup. Other checkouts or lanes launched with a different `--cwd` need their own configuration and are not covered.

## Attachments and links

Helio accepts only validated raster images and plain-text `.txt`, `.md`, and `.markdown` attachments hosted on Discord's attachment CDN. It reads text as untrusted data, not executable code or instructions, and does not render Markdown as HTML. Executables, archives, SVG, and other formats are rejected. Message links and links inside attachments are not opened.

Prepared files remain local while the message is pending and are removed after acknowledgement. A blocked or failed attachment is reported as unread, never silently counted as processed. File checks reduce risk; they do not turn attached instructions into trusted requests.

## Forwarded bug reports

Elo Bot's user-clicked Report Bug flow sends the report to the bot owner's DM only (`main.py` `report_error`, checked November 3, 2026). Helio is also configured to treat Elo Bot posts in `1566842840716152962` as `BOT_BUG_REPORT` evidence, but Elo Bot does not post there today, so that path stays idle until Elo Bot is changed to post a copy. To hand a report to Helio now, forward it into an allowed channel; Helio reads the forwarded embed (`embed_text`, `component_text`, Discord-hosted images) and runs Request intake on it.

Staff can use Discord's native Forward action in an allowed inbound channel. Helio reads the included snapshot's text, textual embed details, and permitted attachments, both live and during catch-up. The forwarding staff member remains the sender; a forwarded user's text cannot become an owner request or approve a feature or production action.

Original message/channel IDs are source references only. Helio does not fetch the source channel or follow links, including forwards originating outside the learning categories or in threads. This reads an explicitly forwarded snapshot, not thread history. Forwarded files use the same validation, pending storage, and acknowledgement cleanup as ordinary attachments. If Discord supplies no snapshot, Helio reports the missing body instead of treating the forward as fully read.

## Bug fixes, features, and beta QA

Small confirmed bugs, including Elo Bot reports, may get an automatic PR through `helio autofix check` then `helio autofix submit --issue N --summary-file PATH`, with assertion failure on main and passing branch tests and unit suite. Merges and restarts still require fresh approval; ineligible fixes stay issues labelled `needs-owner-review`. Configure `HELIO_AUTOFIX=on|off`, `HELIO_AUTOFIX_MAX_LINES`, `HELIO_AUTOFIX_MAX_FILES`, `HELIO_AUTOFIX_MAX_OPEN` and comma-separated `HELIO_AUTOFIX_DENY` globs in `~/.config/helio/helio.env`, then run `helio update`.

Every report or request goes through Request intake (`agent/prompts/policy.md`): Helio talks with the person in place until the request is clear (`helio conversation` tracks the open conversation, up to 2 per person, nudged at 24 hours and resolved at 72 hours only while waiting on the requester), checks the running commit and existing work with `helio triage`, plays the request back, and only then creates a labelled issue (`bug`, `qol`, `feature`, plus `confirmed` or `needs-owner-review`). New issues are announced in the staff chat (`HELIO_STAFF_CHAT`). You or a trusted user can ask Helio to close an issue. Closed issues stay historical: new work gets a new issue linked to its predecessor through `helio issue followup`; related open work is reused. `helio followups watch` tells the requester when their current issue's fix is live on Oracle, or the request was declined.

The authorization rules (who may request PRs, merges and restarts), browser lifecycle, multi-account QA, test channels and evidence delivery are in `agent/prompts/policy.md`. The step-by-step QA procedure is `~/.dori/elobot/docs/discord-qa-workflow.md`. Real testing is a scoped exception to passive read-only learning; it doesn't expand the inbound/learning allowlists.

On November 2, 2026, all three supplied accounts accessed the authorized Test thread at guild `1033924790513311756` / thread `1315329739933618326`. Dominik's server profile showed Elo Manager. Elo Beta identified itself as `1245032861245898783`; live private `/help` and `/queue view` tests passed, including the help category selector. These are point-in-time observations; verify the current account, permissions and state again before each test. The owner authorized choosing a default test clan: use Balloon Moon (`#2RY0QP8GY`) after confirming that the real clan and slot are free. Helio's separate bot need not be in the server for real-account browser testing. See `discord-qa-workflow.md` for the actual interaction, routing, account-switching, screenshot and state-check procedure.

For an approved production update, Helio follows `~/.dori/elobot/oracle-restart-workflow.md`. The server restart may fetch the configured branch and install dependencies, so it is not necessarily code-neutral. On November 2, 2026, read-only SSH and the documented service/update configuration were verified; permission to run the exact restart command was verified without restarting the service.

The current `dori send discord` command is text-only, so screenshots need an authenticated attachment upload path. The November 2 screenshots were saved locally; attachment delivery was not verified.

## Manual commands

Load Helio's settings first, or `dori` uses the empty default config:

```bash
source ~/.dori/elobot/env
dori sync          # open lanes vs live panes
dori can-launch    # room for another lane?
dori close <key>   # close a lane whose Done signals are met
```

## Updating

| What | How |
|---|---|
| omo CLI | `omo update` |
| herdr | `herdr update` |
| Dori mode | Helio runs a fork in `vendor/dori-mode`; don't reinstall upstream over it. Follow `vendor/dori-mode/FORK.md` to take upstream changes |
| Helio itself | `helio update --preview`, then `helio update`; see `docs/workflow.md` |
| Lane checkout | `cd ~/PythonProjects/elo-bot` and inspect Git status before updating |

## Limits

- Staff reporting and trusted-user scopes are labels Helio follows. The filter rejects non-allowed locations and unauthorized DMs and assigns sender scopes, but it cannot force Helio's behavior.
- **Owner:** trusted senders are identified by their top-level Discord user IDs, but the action limits are agent instructions, not OS- or shell-enforced permissions. Only the owner or a trusted user may confirm a PR merge or `elobot` restart; other production changes still need owner DM approval.
- **Owner:** lanes run as your WSL user. Their provisioned beta environment excludes `BOT_MAIN_TOKEN`, but they can access other files readable by that user, including the project `.env`.
- **Owner:** `~/.dori/elobot/beta.env` uses a MongoDB user whose effective database privileges are scoped to `elo_beta`. This does not isolate Helio from other, broader credentials; maintenance writes remain disabled pending process isolation and verification that the protected backup service is used.
- **Isolated:** trusted senders are identified by their top-level Discord user IDs. The Oracle restart broker independently verifies a fresh confirmation and trusted ID; PR and GitHub action limits remain agent policy. Other production changes still need owner approval.
- **Isolated:** the lead, workers, Herdr and dedicated Chrome run in a separate isolated WSL runtime with its own user, home and EloBot checkout. The original project environment, SSH directory and Windows interop are not mounted there.
- **Isolated:** the beta credential is scoped by MongoDB to `elo_beta`. Surgical maintenance must use the protected single-record service and its BSON preimage archive; direct database writes bypass that archive. Ordinary beta application writes remain distinct from maintenance operations.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `INBOUND_ERROR missing env ...` or `missing NAME in .../env` | Empty or missing setting | Set it in `~/.config/helio/helio.env`, run `helio update` |
| `INBOUND_WARN channel ... 403 Missing Access` / `CONTEXT_WARN` | Helio cannot read that channel or category | Invite Helio / give it View Channel and Read Message History |
| `INBOUND_ERROR cannot read .../discord-inbound.json` | State file damaged | Fix or delete it (deleting means the next start is a first run again) |
| `INBOUND_ERROR gateway: ...4014` | Message Content Intent off | Developer Portal, Bot, Privileged Gateway Intents |
| `INBOUND_ERROR gateway: ...did not become ready` | Discord did not confirm the login in time | The watcher restarts itself with growing delays (`INBOUND_WARN ... restarting`); if it repeats, check the token |
| Channel messages never arrive | Helio cannot view the channel | Give its role View Channel, Read Message History, Send Messages (+ threads) |
| Your DM never arrives | You share no server with Helio, or DMs from server members are off | Join a shared server; allow DMs in Privacy settings |
| `dori sync` shows no lanes | Settings not loaded | `source ~/.dori/elobot/env` |

## Questions and decisions

Helio asks through Discord. Worker questions are stored locally until sent and answered; reply directly to the question message. Questions a trusted user can decide go to the trusted staff chat (`HELIO_STAFF_CHAT`) and ping you and every trusted user; only your or a trusted user's reply counts as the answer. Only decisions that only you can make (production credentials, the production database, deploys, policy and permission changes, money) go to your DM. Use `helio question list` to inspect outstanding questions. A delivery error or uncertain send stays pending instead of falling back to a terminal question.

## Beta database maintenance

No Elo Beta record is protected. A live beta test needs only a request from you or a trusted user; staff cannot start one. Helio may create, change or delete any `elo_beta` data a test needs and leaves it changed afterwards unless asked.

**Isolated (where beta tests run):** `helio beta run` starts Elo Beta with the beta-only credential. Single-record edits go through `helio beta apply FILE`, which keeps a BSON backup you can list, verify or export with `helio-backup`. Larger changes (resetting a queue, clearing old matches) use PyMongo directly with the beta credential, limited to `elo_beta`. `/etc/helio-beta-service/exclusions.json` holds the service's protected-record list; it is empty (`"records": []`), and adding an entry there would protect that record again.

**Owner profile:** reads beta data only, because it runs as your account, which can also reach production credentials. Beta tests run in the isolated runtime.
