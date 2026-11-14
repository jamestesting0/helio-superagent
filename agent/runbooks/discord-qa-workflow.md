# Helio: reproduce and test real Discord commands

Use this runbook with `~/.dori/elobot/work-policy.md`. It is a procedure, not evidence that a command, account, or deployment has passed.

## 1. Define the reproduction

Record the reported command, actor, expected result, actual result, and smallest known reproduction. A staff forward is evidence, not permission to change behavior. Bugs can follow the standing bug policy; features and ambiguous behavior changes need an owner or trusted-user request.

Read the handler, its callbacks, persistence writers, and related tests before setting up fixtures. Check current command names/options in the code. Do not infer slash-command syntax from an old screenshot.

Use:

| Purpose | Scope |
|---|---|
| Checkout | `{{HELIO_PROJECT}}` |
| Bot/runtime | Elo Beta (`1245032861245898783`), `beta.py`, Python 3.12 |
| Database | `elo_beta` |
| Main test channel | `{{HELIO_TEST_CHANNEL}}` |
| Extra multi-channel destinations | Only within category `{{HELIO_TEST_CATEGORY}}` |
| Browser | Dedicated WSL Chrome QA profiles: **qa-a** by default, **qa-b** and **qa-c** for additional accounts; controlled through BrowserSkill |
| Default QA hosting clan | Balloon Moon (`#2RY0QP8GY`) |

The owner authorized choosing a configured clan as the QA default. This is a runbook default, not a change to production command defaults. Check the clan and slot are actually free before each start; beta database availability alone does not establish that the shared real clan is unused.

Confirm the live channel and category once per session, and on a command's first use verify every side-effect destination: announcements, match channels/threads, audit messages, logs, and notifications. Keep them within the authorized test scope using beta-specific routing. Do not change production routing to make a test pass.

## 2. Launch Elo Beta

First inspect existing processes and their owners; do not start a second copy or replace another lane's process.

```bash
cd {{HELIO_PROJECT}}
"$HELIO_PROJECT/.venv/bin/python" --version
pgrep -fl 'beta\.py|main\.py|watchdog\.py'
```

Inspect `elo_bot/config/settings.py` and `elo_bot/app/bootstrap.py`: the beta token must come from `BOT_BETA_TOKEN`, `DATA_BASES["beta"]` must be `elo_beta`, and `BETA_SYNC_FROM_MAIN` must remain `False`. Never print `.env` values. Do not run `main.py` or `watchdog.py`.

If an existing beta process belongs to this test run and matches the intended code, reuse it. Otherwise coordinate with its owner. Once no conflicting beta process exists, launch it through a persistent background terminal/monitor after reading `~/.dori/elobot/docs/beta-maintenance-workflow.md` for the profile-specific start commands.

Keep the returned process/monitor handle. Subscribe to startup and error output rather than sleeping or repeatedly polling. Confirm the startup log's `Logged in as` identity/ID is Elo Beta, database initialization succeeded, cogs loaded, and beta database sync is disabled. A launched process or `Starting bot...` alone is not readiness. Record the current source revision and owned process handle with the test evidence.

The profile-specific Beta data rules in `~/.dori/elobot/work-policy.md` determine authorization; the beta maintenance runbook supplies the procedure. The WSL worktree links to the private beta-only environment and uses the shared `.venv`. If credentials, MongoDB, CoC, Helper, or designated test resources are unavailable, report the specific missing gate. Never substitute production.

## 3. Connect Chrome through BrowserSkill

Use `helio browser` to open the dedicated QA profiles; it selects Wayland when the sandbox exports `WAYLAND_DISPLAY`. Do not launch Chrome directly. Once open, use BrowserSkill for browser work, not desktop clicks/keystrokes or OmO's unrelated built-in preview. Do not launch a fresh profile, copy session data, or extract tokens.

When Chrome is fully closed and an approved QA task needs it, Helio may open
the existing dedicated WSL qa-a profile using:

```bash
helio browser ready
```

This command defaults to qa-a and waits for its registered BrowserSkill extension to connect. A closed browser before running it is normal, not a blocker. qa-b and qa-c are additional accounts selected with `--accounts N` or `--profile`. Never fall back to the legacy Helio profile when a QA profile is unavailable.
Do not close other Chrome windows or use a new data directory. If the
extension does not connect or readiness fails, inspect `helio doctor` and the installed browser-skill CLI before asking the owner to resolve it. A real denial still requires the owner; do not substitute another profile.

New Helio lead and worker sessions source `~/.dori/elobot/browser-env` to
set the existing daemon's `BSK_HOME` and expose the installed `bsk` executable
through `BSK_BIN` and `PATH`. Existing processes need to be restarted before
they inherit a changed environment.

Read the installed `browser-skill` instructions and run `bsk doctor --json`. It must report a connected Chrome browser. Bind each session to the verified QA profile's instance in `~/.dori/elobot/qa-accounts.json`; a connected browser alone does not establish its account.

Use the installed browser-skill instructions and `bsk` CLI for the current version. Select the verified QA browser, retain the session ID, and always stop the session after use.

The installed BrowserSkill requires a cooperation context for shared-tab actions. Some older OmOWright method wrappers do not pass it; use the supported BrowserSkill CLI for those operations, not another input engine.

### One window per test account

Discord keeps one login per Chrome profile, so tabs in one profile are always the same account. `qa-a` is always the Elo Manager account (Dominik), and `qa-b` and `qa-c` hold other supplied test accounts (see `helio browser accounts`). Open as many as the test needs, `helio browser ready --accounts N`: 1 for a single-user command, 2 for a match, 3 for a match plus a host or helper. Start one BrowserSkill session per profile with `bsk session start --browser <instance-id from ~/.dori/elobot/qa-accounts.json> --json` and keep each `session_id` with its role (participant A, participant B, manager). Moving between accounts is moving between sessions; nothing logs out. Check each window's account once at its first sync, not after every action. Close only profiles this task opened, as described in section 9. If a profile is not set up yet, ask the owner once to run `helio browser setup <profile>` and complete its login and instance mapping; report the affected live check as unverified until then.

### Links instead of clicks

Navigate by URL, never through the server list or folders: Test thread `https://discord.com/channels/1033924790513311756/{{HELIO_TEST_CHANNEL}}`, any channel or thread `https://discord.com/channels/1033924790513311756/<channel_id>`, a message `.../<channel_id>/<message_id>`. A new match thread is opened from the link or channel mention in Elo Beta's announcement.

A new session starts on a blank tab, and BrowserSkill cannot read a blank tab. So the first command after starting the session is a plain navigation to the verified channel, and only then the first sync:

```bash
bsk navigate --session "$session_id" "$verified_channel_url" --json
bsk cooperate sync --session "$session_id" --json --max-tokens 4000
```

Inspect the returned `state`, `context_id`, `observation_id`, and current page. If the human is editing or holds control, do not act. Never reuse a stale ref or replay an uncertain action. Later navigation, once a page is loaded, passes the fresh context and observation from the latest sync:

```bash
bsk navigate --session "$session_id" \
  --context "$context_id" --observation "$observation_id" \
  "$verified_channel_url" --json
```

The shell variables above are values from the current session/sync and the verified channel, not saved IDs from a previous run.

`permission_denied` with `Could not establish connection. Receiving end does not exist.` is not an access problem: the tab has no page BrowserSkill can read yet (a blank tab, or a page loaded before the extension connected). Navigate or reload that tab to the verified URL and sync again; do not ask anyone about it. Report a real access problem only when `bsk doctor --json` shows no connected browser, Discord itself refuses the page, or the human stops you.

After each navigation or large page change, sync again and inspect the rendered page. A successful navigation response can precede Discord's client-side redirect. Verify the actual tab URL and channel header before any input.

The confirmed guild ID is `1033924790513311756`. The authorized ID `{{HELIO_TEST_CHANNEL}}` is the **Test** thread under helper-chat, not a top-level channel. Open `https://discord.com/channels/1033924790513311756/{{HELIO_TEST_CHANNEL}}`, allow Discord's client to finish loading, and verify the final URL, **Thread: Test** header and active account before input. An early redirect or stale account display is not a completed navigation.

If a server-folder click reports `target_covered`, inspect the page and use Discord's **Find or start a conversation** quick switcher instead; the warning is a pointer hit-test failure, not proof of a Discord permission error. Do not dismiss or bypass a real covering dialog. Re-sync after switching tabs or accounts.

Never type into Discord's message composer: it is a structured editor, and keypress typing or `fill` breaks its command picker. Commands go through `helio beta qa run` (section 6); only the manual fallback there touches the composer. `fill` is fine for ordinary inputs such as the quick-switcher search field.

Helio's bot is in the main server but cannot read the test channel. Its REST API returning 403 for that channel is expected and is not a prerequisite or failure of browser QA. Use the authorized real test accounts to interact with Elo Beta. Do not try to solve this by inviting Helio, changing permissions, reading browser tokens, or using a different bot token. Only a missing permission of the actual test user or Elo Beta blocks the affected live scenario.

## 4. Verify accounts and permissions

Inventory the supplied QA accounts through Discord's visible account UI, without reading credentials. Record each account's visible identity, confirmed test role, and access to the permitted channel. The older guide mentions Crystal Wolf, Tergum, and Dominik, but that is not proof of current login or roles.

Keep one supplied account signed into each QA profile. Change accounts by selecting the corresponding profile's BrowserSkill session, not Discord's account switcher. Verify the active account before the first action in each session. Tabs in one profile are not independent login sessions.

Use at least two distinct participants for cross-user behavior and a verified manager/non-manager pair where the command has permission gates. A third nonparticipant is needed for scenarios such as betting on other players' matches. Do not grant permissions just to make a test pass. Ask the owner to complete missing logins/verification.

A simultaneous-session scenario needs distinct approved QA profiles and identities; one account or several same-profile tabs do not prove it. If a required profile lacks login or access, report that gate instead of substituting the legacy Helio profile.

Read `~/.dori/elobot/beta-maintenance-workflow.md` before any beta database preparation.

## 5. Prepare labelled beta fixtures

Inspect existing beta state first and apply the runtime profile's Beta data boundary in work-policy.md. Only the isolated profile grants the exception allowing any beta record to be changed or removed; the owner profile reads only. Read `beta-maintenance-workflow.md` before preparing fixtures. Record the IDs you create or change, and remember that a database change does not undo Discord effects.

For bugs, reproduce the failure before changing its owner and capture the failed outcome plus relevant state/logs. For features, record the approved acceptance criteria. Seed through existing test/setup paths only when necessary; clearly distinguish seeded setup from actions exercised through Discord.

Run the focused regression checks for the changed behavior. Run the repository-required full suite at integration:

For work submitted by `helio pr submit`, the helper runs that integration suite for the final
revision. Reuse its passing result; do not run the same suite immediately before and after
submission. A code change or a failure requires the affected checks again.

```bash
cd {{HELIO_PROJECT}}
"$HELIO_PROJECT/.venv/bin/python" -m unittest discover -v tests
```

Compare existing failures with a fresh pre-change baseline by test identity. Never weaken tests, claim skipped checks passed, or use the production database for integration.

## 6. Exercise real commands and controls

**Use `helio beta qa` for every command and control.** It does the browser mechanics in one call each and prints one JSON line; you decide what to test and judge the result.

```bash
helio beta qa start --profile qa-a                    # opens the profile if needed, verifies account and Test thread
helio beta qa run "leaderboard" --opt lb_type=Hitrate --screenshot "$EVIDENCE/lb.png"
helio beta qa select --message <id> --menu "Overall" --option "Good"
helio beta qa click --message <id> --button "▶"
helio beta qa form --field "<field>=5"                # a field name from the modal result's "fields"
helio beta qa read [--message <id>]                   # look again, no input
helio beta qa where <channel id>...                   # routing check over REST instead of browsing
helio beta qa stop --all                              # in your cleanup path
```

- `run` posts Elo Beta's command mention, clicks it, fills options from Elo Beta's registered schema (IDs for user/channel/role options; choice and autocomplete values must match the top suggestion exactly), reads the message box back, sends once and returns Elo Beta's answer. `helio beta commands list` shows which commands are `bound`; pass `--channel <match thread>` for those.
- A second account is `--profile qa-b` (its own `start`); nothing logs out.
- Results: `state` is `done`, `failed` (Discord: the application did not respond), `modal` (fill it with `form`) or `pending`. Printed text is trimmed; `full` is the path of the complete extraction for exact checks and evidence.
- Exit 2: refused before any input (wrong account or channel, option mismatch, `QA_NOT_SENT`, out of scope, element not found); fix the cause and run again. Exit 3: input was sent but no answer was seen; never resend, follow up with `read`. Exit 4: a person is using the tab; wait. Run `helio beta qa doctor` first in a session, and if it reports `drift`, Discord's page changed: report it rather than clicking by hand.
- If `run` reports `QA_MENTION_FAILED`, the manual fallback is: focus the empty composer, paste `/<command>` once with `bsk evaluate … "$(helio beta commands paste '/<command>')"`, choose the **Elo Beta** entry in the picker, then continue with `select`/`click`/`form`. Never type it key by key.

For anything the helper does not cover, use BrowserSkill directly and keep reads small: `bsk step --action … --until-visible <selector>` (act and wait in one call), `bsk wait-for-element --selector … --timeout 10s`, `bsk cooperate sync --max-tokens 2000`, `bsk view <saved.json> --find <text>` instead of re-syncing, and `bsk get-html --ref @eN`.

For each command, judge the result: it must come from Elo Beta; inspect success/failure, embed fields, visibility and enabled controls; compare the stored beta records with what the UI claims and check other permitted channels for announcements; for a second user, run the same steps with that profile and verify foreign-control rejection; capture private previews from their owning account; record message and fixture IDs with the evidence.

Drive the actual slash command and its relevant buttons, selects, modals, pagination, and confirmations. For each step, read fresh BrowserSkill state, act once, and inspect the resulting UI and committed beta state.

Cover applicable cases, not an unrelated exhaustive checklist:

- Happy path with valid data, including the final confirmation.
- Invalid input and expected permissions/ownership denial.
- A different account operating another user's controls.
- Duplicate/stale confirmations and retries without duplicate writes.
- Back/Cancel leaving state unchanged; pagination boundaries.
- Private responses visible only to the intended account.
- Multi-channel outputs reaching exactly the authorized destinations.
- Required failure/recovery behavior, including persistence/publication disagreement.

An opened form is not submission, a preview is not confirmation, an API mock is not live execution, and a success embed is not proof of committed state. Inspect all required writes and the response ordering. Refresh outdated slash-command definitions only in the intended test session; an outdated-command error is not a passing result.

Use the checkout's `docs/bot-ui.md` and `docs/copy-style.md` for presentation conventions, with the current work-policy.md browser/channel rules taking precedence.

## 7. Build difficult tests from the code's state transitions

Do not treat a workflow as a list of unrelated slash commands. Read the current code, build its dependency graph, and execute the real path into the state being tested. For every step record: actor/role, prerequisite state, actual command/control, expected writes, expected response/destination, and the signal that permits the next step.

For a queue-to-match-to-helper scenario, start with this map in the current checkout and recheck it when code changes:

| Concern | Code to read |
|---|---|
| Queue eligibility, tier selection, district picker | `elo_bot/extensions/match/queue.py`: `match_queue`, `_send_queue_district_picker`, `queued_district_action`; `elo_bot/features/queue/matching.py`: `queue_player` |
| Opponent selection and durable match creation | `elo_bot/features/queue/matching.py`: `find_opponent`, `match_with_best_queue`; `elo_bot/features/matches/lifecycle.py`: `initiate_match` |
| Participant confirmation and private thread publication | `elo_bot/extensions/match/lifecycle.py`: `_match_confirm_button`, `_confirm_match_participant`; `elo_bot/features/matches/lifecycle.py`: `confirm_match` |
| Helper/host authorization and stale control checks | `elo_bot/extensions/match/hosting.py`: `host_match_button`; `elo_bot/features/matches/controls.py`: `check_match_control`, `update_match_control` |
| Stored bases, live start, results and cleanup | `elo_bot/extensions/match/base_store.py`: `match_base_store`; helper stored-start/Undo callbacks; `elo_bot/extensions/match/hosting.py`: `match_start`; result finalization in `elo_bot/features/results/` and shared reservation helpers in `elo_bot/features/base_store/` |
| Viewing/toggling the queue | `elo_bot/extensions/queue.py` |
| Persistence contracts | `elo_bot/db/` models used by the handlers, and their shared writer/reconciliation functions |

`docs/commands.md` in the checkout maps every command, callback and task to its handler; use it to find a flow that is not listed here.

Read the relevant decorators, checks, shared preflight, callback body, and existing regression tests. A command's description or visible button label does not establish its permission rules or persistence behavior. Helper commands do not all have identical authorization.

### Behaviors traced in the current checkout

These are source-derived checkpoints, not live test results. Re-read the named functions after code changes:

| Source | Actual branch to account for |
|---|---|
| `queue_player` | Checks blacklist, disabled queue, registration, duplicate membership, and occupied state before matching. Existing mixed-tier candidates are checked with a 200 Elo window. If still unmatched and the bot ID differs from production `BOT_ID`, the beta branch saves the player into the mixed queue and returns `BETA_QUEUED`. |
| `find_opponent` | Rejects self and incompatible Elo; repeat-opponent restrictions have a mixed-tier exception. Occupied queued candidates are removed from that queue. Two logged-in accounts alone do not guarantee a match. |
| `queued_district_action` | Binds controls to owner ID and queue attempt ID. Before matching, district changes clear selection confirmation; Confirm validates all three and saves confirmation. After matching, the same attempt can resolve to the created match; after a thread exists these queue controls are retired. |
| `initiate_match` | Inserts `Match` before calling the matched-queue removal callback. Presets or a confirmed queue selection can make participants already confirmed. Each participant receives a DM; Forbidden delivery falls back to `COMMAND_CHANNEL`. If both are already confirmed, `confirm_match` is called immediately. |
| `_confirm_match_participant` | Saves that participant's confirmation first. With only one confirmed it waits; with both it calls `confirm_match`. In the November 2 live test, the DM update accessed `ctx.guild` and raised before the thread call; the confirmation remained saved and the user saw an unexpected-error response. The automatic confirmation sweep later published the thread. Inspect current state and logs rather than clicking Confirm repeatedly or assuming immediate publication. |
| `confirm_match` | Ordinary matches use `MATCH_CHANNEL` as the parent for a private thread. It saves the thread/district state, publishes/binds/pins the announcement, and returns the thread ID. The initial announcement has Submit Result; it is not the message that produces a Host button. |
| `match_war_schedule` | `/match war schedule` requires `LVL2_ROLES`, a valid match thread, and an accepted timestamp. It writes `is_war=True`, the selected side's time, and an empty host, appends a helper task, then publishes the side message with Host/Store Result/Abort and clan selection. |
| `host_match_button` | Operates on a current side message bound by `old_msgs[player]`. It checks `STAFF_ROLE`, `SEN_ROLE`, `MODERATOR_ROLE`, or `ADMIN_ROLE`, rejects the targeted player's own hosting and ended sides, conditionally writes `hosts[player]`, and publishes the updated message. This is not the same permission set as every `LVL2_ROLES` command. |
| `match_base_store` / `match_base_autostore` | Both resolve the match from the current thread, but their participant checks differ. Manual store rejects either participant except the bot owner; autostore has an opposing-side/LVL2 exception. Do not copy the expectation from one command onto the other. |
| `match_start` / `_start_live` | `/match start` requires `LVL2_ROLES`. Preflight rejects missing/finished matches, existing start/host state, and participating hosts except the bot owner; fetches the linked CoC accounts and rejects town halls >=6; checks scout data when requested, clan availability, and available stored slots. Raid-weekend special handling is additionally conditional on the production bot ID. |

Current routing constants in `elo_bot/config/ids.py` also require attention: `COMMAND_CHANNEL=1220331873079922810` and `MATCH_CHANNEL={{DORI_DISCORD_CONTEXT_EXCLUDED}}`. They are not the user's primary slash-test channel. The code read does not establish their current category membership. Verify beta side-effect routing before executing the queue flow; do not assume typing `/match queue` in the right channel confines its DMs, fallback messages, or generated thread there.

On November 2, 2026, the signed-in Tergum account's Discord channel list placed both configured channels under the permitted `{{HELIO_TEST_CATEGORY}}` competitive category. Recheck once per test session. Other destinations, including the beta state's dashboard messages and any automated jobs, need separate checks. Normal `/match war start` and `/match start` use real configured clans even though they do not themselves invoke the automatic Helper hosting job; select an owner-designated test clan, not an arbitrary available clan.

### Final tournament setup and routing

| Step | Actual behavior |
|---|---|
| `/final start season:<number>` | Manager-only; opens registration for one existing, uniquely mapped completed season. Omitting `season` selects the latest completed archive. An active Final or an existing edition for that season blocks creation. |
| `/final add player:<user> nickname:<label>` | Adds an already registered beta player, up to eight entrants. Use a labelled QA nickname for a test roster. |
| Bracket setup | Seeds, byes and pairing go through the current `/final bracket` controls before a round is ready. |
| `/final round create` | Checks readiness only; does not create threads. |
| `/final round start` | Creates or resumes private match threads; does not start hosting. An entrant's unfinished match blocks provisioning. |

`elo_bot/extensions/final.py:final_start` passes `FINAL_CHANNEL` into `elo_bot/features/finals/lifecycle.py:start_final`, which persists it as `EloFinal.channel_id`; `elo_bot/features/finals/matches.py:prepare_match` copies it to `Match.routing_channel_id`, and `confirm_match` creates a Final match's private thread there. Ordinary matches use `MATCH_CHANNEL`. The command's input channel never decides the thread's parent. Existing editions keep their captured `channel_id`, so changing the constant does not reroute them; brackets, betting announcements and result fallbacks use that captured channel too. Resolve its current name and category before the run.

For a retained owner-testing tournament, first verify a qualifying completed archive and no conflicting active edition in `elo_beta`; a second `/final start` conflicts with an existing one. Record the created edition and label its roster and evidence. Do not manufacture a completed production season or cancel someone else's Final to satisfy setup; if no qualifying archive exists, report that blocker before seeding anything.

Use a bettor outside the selected match: a manager who is also a participant must be denied betting on that match. Useful Final scenarios: bracket setup (saved bracket and rendered attachment agree), predictions (draft, Back/Next, review, submit, closure rejecting later submissions), betting (`/final betting announce`, a nonparticipant confirming, editing and cancelling a stake with wallet, ledger and pool agreeing), and results (seven score lines per player, ephemeral preview, Cancel unchanged, Confirm once, manager correction repairing dependent state).

`tests/integration/_final_fixture.py` creates and drops disposable `elo_final_it_*` databases with synthetic users; it is not a setup script for live `elo_beta`. It needs a loopback MongoDB replica set started as in the checkout's CI workflow:

```bash
FINAL_TEST_MONGO_URI='mongodb://127.0.0.1:27018/?replicaSet=elo-final-it&directConnection=true' \
  "$HELIO_PROJECT/.venv/bin/python" -m unittest discover -v -s tests/integration -p 'test_final_*.py'
```

Missing MongoDB, zero collected tests or a skipped suite is not a passing gate.

### Example: two participants queue, create a match, then a helper acts

1. **Choose distinct actors.** Use A and B as the two participants. A positive helper/host test needs a separate nonparticipant C with the code-required roles; assigning a helper role to A does not make A eligible to host their own match. Add an unprivileged actor only where a distinct negative case requires it. Record actual roles and IDs, not assumed historical account labels.
2. **Check prerequisites from code.** A/B must have valid beta `Player` records, be eligible for the enabled queue, not be blacklisted or occupied, and meet opponent-selection rules. Inspect existing queue entries so the fixture does not match unrelated people. Use controlled, compatible beta Elo values and district preferences; do not broaden matchmaking rules to force the test.
3. **Queue A through Discord.** In channel {{HELIO_TEST_CHANNEL}}, select Elo Beta's `/match queue`. Inspect its private result and district-selection controls as A. Verify the persisted queue membership, attempt/selection identity, and no duplicate membership. The inspected beta path adds an unmatched player to the mixed queue for instant matching; do not wait the production queue's advertised hours.
4. **Complete A's intended district choices.** Read and use the current picker. Track whether choices are confirmed/locked before matching. Do not assume default preferences always leave the match unconfirmed: `initiate_match` can derive confirmation from presets or a confirmed queue selection.
5. **Queue B through Discord.** Switch accounts, verify B, use Elo Beta's `/match queue`, and inspect the actual outcome. Observe the expected `Match` creation and removal of matched queue entries. Record one match token and its two participant IDs. If matching fails, investigate queue/tier/Elo/occupancy/history preconditions and logs before clicking again. Do not insert a finished match directly and call the queue path tested.
6. **Inspect each participant's actual match UI.** Follow only the test match's own DM/announcement/control context. DMs may be unavailable for a test account; inspect the current publication/fallback code and report that path honestly. Select any missing districts and confirm as the owning participant. Check the first participant's saved confirmation, then the second's, rather than assuming a confirmation embed means both are done.
7. **Verify creation/publication once.** Check the same durable match token, both confirmation states, created private thread ID, bound announcement message, and participant access. Match data may commit before publication completes; report incomplete publication rather than creating another match. Before entering or acting in the new thread, verify its parent is within the authorized testing scope. The parent for ordinary matches comes from routing such as `MATCH_CHANNEL`; launching commands in the test channel alone does not establish safe output routing.
8. **Test participant behavior.** As A and B, use the controls intended for them and inspect each private response with its owning account. Test a foreign/stale control where applicable and verify no unauthorized state change. Preserve the match token, selected districts, and relevant message IDs across account switches.
9. **Select the helper branch before changing its prerequisites.** The new match announcement does not have a Host button. Use a fresh owned match for each incompatible branch below; in particular, scheduling a war side sets `is_war` and a start time, so do not then treat that fixture as an untouched live-start match.
10. **Exercise the actual branch as C.**
    - **Scheduled war-side/host-claim test:** as an account with `LVL2_ROLES`, run Elo Beta's `/match war schedule` with the current player selector and a valid controlled timestamp in the match thread. Verify the side's saved time, war flag, empty host, helper task, and published side message. Only then click that message's Host button as the eligible helper, verify `hosts[player]` and the rendered host field, and exercise stale/ended/permission/targeted-player denials on appropriate fixtures. Read the current scheduling tasks so the fixture timestamp does not trigger unplanned remote work.
    - **Manual war-start test:** as an eligible nonparticipant, invoke Elo Beta's `/match war start` in the exact match thread with the intended player and designated test clan. Verify `is_war`, the selected side's time, host, clan and bound message, the clan's beta availability record, and the published controls. This manual command is not an automatic Helper hosting job.
    - **Manual live-start test:** on a fresh confirmed match, invoke Elo Beta's `/match start` as a permitted nonparticipant C with the designated test clan and scout option. Satisfy and observe the actual CoC account, town-hall, scout, clan, slot, and match-state preflight. Do not first claim a war-side host and assume `/match start` will still pass its empty-host/time gate.
    - **Stored-base test:** invoke Elo Beta's `/match base store` with the actual player/clan/slot selectors in the match thread, then verify the reservation and publication. If the issue is `/match base autostore`, test that distinct handler and its different participant/role rules rather than substituting manual store. Test its Start/Undo controls only after their required storage state exists.
    - Keep external Helper API, linked CoC accounts, and hosting clans on designated test resources. If those resources are missing, mark the affected branch unverified; do not fabricate a success or use real users' clans.
11. **Follow through to the reported failure.** Continue the relevant base, start, result, retry, or Undo path, preserving the real state created by earlier steps. Verify both user-visible outcomes and required match/player/base/helper bookkeeping. Keep stored-slot reservations until a valid lifecycle release condition holds; Start, Abort, autowin alone, or one participant's result is not a reason to clear them.
12. **Check recovery, then finish the fixture.** Use separate owned fixtures for cancellation versus successful completion when one path would destroy another's prerequisites. Verify stale/duplicate callbacks do not create duplicate matches, host assignments, results, or releases. Record cleanup and any autoqueue preference of the test participants; do not leave them unintentionally queued or remove unrelated queue entries.

The same method applies to other difficult flows: derive prerequisites and role boundaries from their real writers/callbacks, exercise the transitions through Discord, observe the matching durable state, and carry the scenario through its actual failure/recovery branch. Seeded state, mocks, or role bypasses cannot replace an untested transition.

## 8. Capture and deliver evidence

Save current screenshots, a short test matrix, scoped runtime logs, and before/after state evidence under the lane's `.omo/evidence/` directory. Record the source revision, account/role, channel ID, fixture ID, exact scenario, expected/observed outcome, and PASS/FAIL/UNVERIFIED.

Capture private previews from their owning account. For UI changes include before/after screenshots and the relevant desktop/narrow views. Inspect images for unrelated content, secrets, personal data, and local desktop chrome before sending.

Workers return results and evidence paths privately to the lead. The lead sends the completion:
`bun ~/.dori/elobot/evidence.ts <request channel_id> <current request message_id> --event completion
--text-file <summary> [--owner-only] <screenshot>...`. Use the current request ID, including when
reusing an older lane. Do not also announce it from the worker or another claim/report callback.
The event shares a durable receipt with reply.ts; rephrasing cannot create another completion.
Later substantive facts use distinct events such as `ci:FULL_SHA`. Each routed destination is
resumable independently; shareable and owner-only parts remain separate. Follow work-policy.md
for privacy/routing, never hand-write uploads, and never call paths or stale screenshots delivery.

If any required live scenario is blocked, report it as unverified before calling the work fully tested. Passing unit tests do not replace missing browser/account/remote checks.

## 9. Finish and clean up

Commit and push only the verified in-scope working branch when authorized by the bug policy or feature request. PR creation requires an owner or trusted-user request, an approved plan or a recorded work authorization (`helio work authorize`), submitted through `helio pr submit` (issue-plan-workflow.md), or standing autofix authorization through `helio autofix submit`; a PR merge and `elobot` restart remain separately confirmation-gated in `work-policy.md`; other production changes remain owner-only.

Always use a finally/cleanup path, including failures. Stop the task BrowserSkill sessions, then close only profiles opened by this task through `helio browser close --profile qa-a` (or the corresponding qa-b/qa-c profile). Unqualified `helio browser close` targets qa-a. Preserve profiles already open for the owner or another task; if another BrowserSkill session remains active, defer closure until it finishes. Stop only a beta process started by this run, using its recorded handle. Never broad-kill Python or another lane's bot. Remove only owned disposable fixtures/resources, preserve evidence and unrelated state subject to the isolated Beta data exception, and return borrowed tabs. Keep logins intact.

## Latest observed setup state

On November 2, 2026, Chrome's Helio profile and BrowserSkill were connected. Tergum, Crystal Wolf and Dominik each opened the exact Test thread, and Dominik's guild profile showed **Elo Manager**. Elo Beta started with sync disabled and identified itself as `1245032861245898783`.

In the Test thread, Tergum ran Elo Beta's `/help` and changed its private menu from Match to Base. Dominik ran Elo Beta's `/queue view`; all four displayed tiers were empty, matching a raw read of `elo_beta.queue`. The beta queue was enabled; Tergum and Crystal Wolf had registered beta players with Elo 1000 and 950. These are point-in-time observations, not guarantees for another run. Cropped screenshots were saved locally under `.omo/evidence/helio-live-20261102/`; attachment delivery was not verified.

Later that day, Tergum and Crystal Wolf queued and confirmed the same beta match. Crystal Wolf's DM confirmation saved successfully but returned an unexpected error because `ctx.guild` was `None`; the automatic confirmation sweep later created the private match thread. Dominik then used Elo Beta's `/match war start` for Crystal Wolf with Balloon Moon. The Discord message and beta match and clan records agreed on the host and clan. The match remained active with Tergum's side unstarted. The full evidence and exact IDs are in `.omo/evidence/helio-live-20261102/results.md`; screenshots were saved locally, not verified as delivered.

The owner authorized choosing a configured default; the QA default is Balloon Moon (`#2RY0QP8GY`), subject to the availability checks above. Helio's separate bot is not required for real-account browser QA.

## Browser lifecycle

Use section 3 for readiness and profile/session connection, section 4 for accounts and section 9 for cleanup. Do not follow macOS launch recipes.

## Live beta testing

Follow sections 1-7 and the profile-specific beta maintenance runbook; shared work-policy.md retains test scope, credentials and authority boundaries.

## Evidence and reporting

Follow section 8 for capture/delivery and section 9 for cleanup. Save command, expected/observed result and pass/fail/unverified status with the current evidence; report failures and missing live checks before committing/pushing as verified.
