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
| Browser | Chrome profile **Helio**, controlled through BrowserSkill |
| Default QA hosting clan | Balloon Moon (`#2RY0QP8GY`) |

The owner authorized choosing a configured clan as the QA default. This is a runbook default, not a change to production command defaults. Check the clan and slot are actually free before each start; beta database availability alone does not establish that the shared real clan is unused.

Before invoking a command, verify every side-effect destination: announcements, match channels/threads, audit messages, logs, and notifications. Keep them within the authorized test scope using beta-specific routing. Do not change production routing to make a test pass.

## 2. Launch Elo Beta

First inspect existing processes and their owners; do not start a second copy or replace another lane's process.

```bash
cd {{HELIO_PROJECT}}
"$HELIO_PROJECT/.venv/bin/python" --version
pgrep -fl 'beta\.py|main\.py|watchdog\.py'
```

Inspect `beta.py` and `common/constants.py`: the beta token must come from `BOT_BETA_TOKEN`, `DATA_BASES["beta"]` must be `elo_beta`, and `BETA_SYNC_FROM_MAIN` must remain `False`. Never print `.env` values. Do not run `main.py` or `watchdog.py`.

If an existing beta process belongs to this test run and matches the intended code, reuse it. Otherwise coordinate with its owner. Once no conflicting beta process exists, launch it through a persistent background terminal/monitor using the commands in the "Starting beta" section of `~/.dori/elobot/work-policy.md`.

Keep the returned process/monitor handle. Subscribe to startup and error output rather than sleeping or repeatedly polling. Confirm the startup log's `Logged in as` identity/ID is Elo Beta, database initialization succeeded, cogs loaded, and beta database sync is disabled. A launched process or `Starting bot...` alone is not readiness. Record the current source revision and owned process handle with the test evidence.

When ordinary beta startup and testing with existing beta data are authorized, and what must be verified first, is also stated in that "Starting beta" section. The WSL worktree links to the private beta-only environment and uses the shared `.venv`. If credentials, MongoDB, CoC, Helper, or designated test resources are unavailable, report the specific missing gate. Never substitute production.

## 3. Connect Chrome through BrowserSkill

Open Chrome with profile **Helio** solely to expose its BrowserSkill extension. Once open, use BrowserSkill for browser work, not desktop clicks/keystrokes or OmO's unrelated built-in preview. Do not launch a fresh profile, copy session data, or extract tokens.

When Chrome is fully closed and an approved QA task needs it, Helio may open
the existing dedicated WSL Helio profile using:

```bash
helio browser ready
```

This command opens the dedicated WSL profile and waits for the BrowserSkill extension to connect. A closed browser before running it is normal, not a blocker.
Do not close other Chrome windows or use a new data directory. If the
extension does not connect, is disabled, or access is denied, stop and ask the
owner to resolve it; do not substitute another profile.

New Helio lead and worker sessions source `~/.dori/elobot/browser-env` to
set the existing daemon's `BSK_HOME` and expose the installed `bsk` executable
through `BSK_BIN` and `PATH`. Existing processes need to be restarted before
they inherit a changed environment.

Read the installed `browser-skill` instructions and run `bsk doctor --json`. It must report a connected Chrome browser. If several browsers are connected, choose the verified Helio instance explicitly.

Use the installed browser-skill instructions and `bsk` CLI for the current version. Select the verified Helio browser, retain the session ID, and always stop the session after use.

The installed BrowserSkill requires a cooperation context for shared-tab actions. Some older OmOWright method wrappers do not pass it; use the supported BrowserSkill CLI for those operations, not another input engine.

### One window per test account

Discord keeps one login per Chrome profile, so tabs in one profile are always the same account. Multi-account tests use the dedicated test profiles instead of the account switcher: `qa-a` is always the Elo Manager account (Dominik), and `qa-b` and `qa-c` hold other test accounts (see `helio browser accounts`). Open as many as the test needs, `helio browser ready --accounts N`: 1 for a single-user command, 2 for a match, 3 for a match plus a host or helper. Start one BrowserSkill session per profile with `bsk session start --browser <instance-id from ~/.dori/elobot/qa-accounts.json> --json` and keep each `session_id` with its role (participant A, participant B, manager). Moving between accounts is moving between sessions; nothing logs out. Check each window's account once at its first sync, not after every action. Close them with `helio browser close --all`. If a profile is not set up yet, ask the owner once to run `helio browser setup <profile>`, and use the single Helio profile with the account switcher meanwhile.

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

Discord's message composer is a structured Slate editor. Do not use BrowserSkill `fill` on it: in the observed session it replaced the editor's child structure with plain text, so Discord did not open the command picker. Focus the empty composer, send `/` as a real keypress and observe the picker before typing the command name with keypresses. Choose the explicit **Elo Beta** result. If the editor has already been damaged, reload only after ensuring there is no user-owned unsent draft; recheck the channel and account afterward. `fill` worked for the ordinary quick-switcher search field.

Helio's bot is in the main server but cannot read the test channel. Its REST API returning 403 for that channel is expected and is not a prerequisite or failure of browser QA. Use the authorized real test accounts to interact with Elo Beta. Do not try to solve this by inviting Helio, changing permissions, reading browser tokens, or using a different bot token. Only a missing permission of the actual test user or Elo Beta blocks the affected live scenario.

## 4. Verify accounts and permissions

Inventory the supplied QA accounts through Discord's visible account UI, without reading credentials. Record each account's visible identity, confirmed test role, and access to the permitted channel. The older guide mentions Crystal Wolf, Tergum, and Dominik, but that is not proof of current login or roles.

Use the account switcher only when available and authorized. Verify the active account after every switch and before the first action in each tab. Tabs in one profile are not independent login sessions; recheck affected tabs after switching.

Use at least two distinct participants for cross-user behavior and a verified manager/non-manager pair where the command has permission gates. A third nonparticipant is needed for scenarios such as betting on other players' matches. Do not grant permissions just to make a test pass. Ask the owner to complete missing logins/verification.

Sequential switching is acceptable when it exercises the same persisted interaction. A simultaneous-session scenario needs additional owner-approved isolated sessions; one account or several same-profile tabs do not prove it.

Read `~/.dori/elobot/beta-maintenance-workflow.md` before any beta database preparation.

## 5. Prepare labelled beta fixtures

Inspect existing beta state first. No beta record is protected: if existing data blocks a test, change or remove it (see `beta-maintenance-workflow.md`) and carry on; do not stop to ask because beta records already exist. Record the IDs you create or change, and remember that a database change does not undo Discord effects.

For bugs, reproduce the failure before changing its owner and capture the failed outcome plus relevant state/logs. For features, record the approved acceptance criteria. Seed through existing test/setup paths only when necessary; clearly distinguish seeded setup from actions exercised through Discord.

Run the focused regression checks for the changed behavior. Run the repository-required full suite at integration:

```bash
cd {{HELIO_PROJECT}}
"$HELIO_PROJECT/.venv/bin/python" -m unittest discover -v tests
```

Compare existing failures with a fresh pre-change baseline by test identity. Never weaken tests, claim skipped checks passed, or use the production database for integration.

## 6. Exercise real commands and controls

**Fastest way to enter a command: a mention posted where it runs.**

1. Check where the command can run: `helio beta commands list` shows every Elo Beta command with `where`. `anywhere` commands run in the Test thread. `bound` commands (match base, result, war, set, schedule, start and abort, `self host` and `self store`, `match resubmit`, `thread delete`, `open-raid-post`) only work inside their match thread or required channel, and `why` names the check in Elo Bot's code. `unknown` means the command is not in the checked-out source; read its code before using it.
2. Post the mention: `helio beta commands mention "<command>"` for the Test thread, or add `--channel <match thread ID>` for a bound command. Elo Beta posts the mention and the tool prints its `link` and `message_id`. A bound command is refused in the Test thread.
3. Navigate to that link and make sure the message box is empty first: Discord keeps an unsent draft per channel, and clicking a mention while a command draft is in the box does nothing. Clear it with `bsk press --selector '[role=textbox][data-slate-editor]' Ctrl+A`, then the same with `Backspace`, and check the editor's text is empty. Then click the mention. It renders as a small `<span>` holding the command's last word inside `[id^=message-content]`; click that innermost element. Discord fills exactly Elo Beta's command into that channel's message box.
4. Run `helio beta commands delete` to remove the mention message; the filled command stays in the message box.
5. Fill the options and send. Discord has no way to pre-fill option values from a mention (removed on purpose; Discord points bots to buttons), so options are always entered in the browser. After the click the first option is focused; `Tab` accepts the current value and moves to the next option. For user, role, channel and autocomplete options, type with keypresses and press `Tab` only after the top suggestion is the intended one: `Tab` picks the top suggestion, and text inserted in one step (`insertText`) does not refresh the suggestions, so it silently picks whoever was listed first (verified 2026-11-03). Re-sync once if an action reports that the observation changed: the picker is still rendering. Escape does not remove a filled command: send it or replace it, never leave it half-filled at the end of a test.

Use the typed `/` picker below only if posting a mention fails.

In `{{HELIO_TEST_CHANNEL}}`, verify the channel, current user, and selected slash-command application. Explicitly choose **Elo Beta**, not the production bot with the same command name.

For each command:

1. Navigate through the test account's Discord UI to the approved test channel. Confirm its current identity and channel header/ID. Record the channel URL for the other test accounts.
2. Observe the message composer through BrowserSkill and focus that actual composer. Type `/` to open Discord's command picker, select Elo Beta's application, then choose the command under test. Do not paste a production command and assume the application is correct.
3. Fill the command's current option fields using the picker, selectors, and autocomplete. Use labelled beta fixture IDs and the intended supplied participants. Re-observe after each menu/modal change instead of reusing refs.
4. Review the selected application, options, actor, and destinations before pressing Enter to submit once. The response must belong to Elo Beta. An autocomplete suggestion or filled command draft is not an executed test.
5. Observe the actual response: success/failure, embed fields, attachment, ephemeral/public visibility, and enabled/disabled controls. Capture any relevant runtime error from the owned beta process. If Discord reports that the application did not respond, inspect the result and logs before retrying; do not blindly submit twice.
6. Operate the response's actual buttons/selects and modal fields through BrowserSkill. Complete the final confirmation when the scenario requires persistence; exercise Back/Cancel separately when it should leave state unchanged. Subscribe to the expected response/state change rather than waiting a fixed number of seconds.
7. Record the resulting message/fixture IDs and compare the relevant stored beta records with what the UI claims. Check additional permitted channels for expected announcements or match outputs. A successful log line is supporting evidence, not a substitute for the rendered response.
8. For a second-user check, switch to the intended supplied account using Discord's account UI, verify its identity and role, return to the same permitted channel/message, and perform that user's action. Verify foreign-control rejection or participant-specific controls as appropriate. Private previews must be inspected from the account that owns them, not another account.
9. Capture the final response and relevant intermediate/private states as screenshots, then report what actually passed, failed, or remained unverified. Keep the reproduction, command options, actors, fixture IDs, logs, and state evidence together so the next attempt starts from the known failure rather than rediscovering setup.

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

Use `docs/discord-qa.md`, `docs/bot-ui.md`, and `docs/copy-style.md` for interaction lessons and presentation conventions, with the current work-policy.md browser/channel rules taking precedence.

## 7. Build difficult tests from the code's state transitions

Do not treat a workflow as a list of unrelated slash commands. Read the current code, build its dependency graph, and execute the real path into the state being tested. For every step record: actor/role, prerequisite state, actual command/control, expected writes, expected response/destination, and the signal that permits the next step.

For a queue-to-match-to-helper scenario, start with this map in the current checkout and recheck it when code changes:

| Concern | Code to read |
|---|---|
| Queue eligibility, tier selection, district picker | `cogs/match_commands.py`: `queue_player`, `match_queue`, `_send_queue_district_picker`, `queued_district_action` |
| Opponent selection and durable match creation | `find_opponent`, `match_with_best_queue`, `initiate_match` |
| Participant confirmation and private thread publication | `_match_confirm_button`, `_confirm_match_participant`, `confirm_match` |
| Helper/host authorization and stale control checks | `host_match_button`, `check_match_control`, `update_match_control` |
| Stored bases, live start, results and cleanup | `match_base_store`, helper stored-start/Undo callbacks, `match_start`, result finalization and shared reservation helpers |
| Viewing/toggling the queue | `cogs/queue_commands.py` |
| Persistence contracts | `database_models/` models used by the handlers, and their shared writer/reconciliation functions |

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

Current routing constants also require attention: `COMMAND_CHANNEL=1220331873079922810` and `MATCH_CHANNEL={{DORI_DISCORD_CONTEXT_EXCLUDED}}`. They are not the user's primary slash-test channel. The code read does not establish their current category membership. Verify beta side-effect routing before executing the queue flow; do not assume typing `/match queue` in the right channel confines its DMs, fallback messages, or generated thread there.

On November 2, 2026, the signed-in Tergum account's Discord channel list placed both configured channels under the permitted `{{HELIO_TEST_CATEGORY}}` competitive category. Recheck once per test session. Other destinations, including the beta state's dashboard messages and any automated jobs, need separate checks. Normal `/match war start` and `/match start` use real configured clans even though they do not themselves invoke the automatic Helper hosting job; select an owner-designated test clan, not an arbitrary available clan.

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

Deliver the screenshots and a concise result summary with `bun ~/.dori/elobot/evidence.ts <request channel_id> <request message_id> --text-file <summary> [--owner-only] <screenshot>...`. It replies where the request was made (trusted chat or owner/trusted DM), or for a normal-chat request sends to the owner's DM, forwards that to a trusted requester's DM and leaves a note in place. Use `--owner-only` for anything only the owner may see (see Evidence and reporting in work-policy.md). Never hand-write an upload.

If any required live scenario is blocked, report it as unverified before calling the work fully tested. Passing unit tests do not replace missing browser/account/remote checks.

## 9. Finish and clean up

Commit and push only the verified in-scope working branch when authorized by the bug policy or feature request. PR creation requires an owner or trusted-user request; a PR merge and `elobot` restart remain separately confirmation-gated in `work-policy.md`; other production changes remain owner-only.

Stop the task BrowserSkill session, then run `helio browser close` to close the dedicated profile after browser work; if another BrowserSkill session remains active, defer closure until it finishes. Stop only a beta process started by this run, using its recorded handle. Never broad-kill Python or another lane's bot. Remove only owned disposable fixtures/resources, preserve evidence and unrelated state, stop the BrowserSkill session, and return borrowed tabs. Keep logins intact.

## Latest observed setup state

On November 2, 2026, Chrome's Helio profile and BrowserSkill were connected. Tergum, Crystal Wolf and Dominik each opened the exact Test thread, and Dominik's guild profile showed **Elo Manager**. Elo Beta started with sync disabled and identified itself as `1245032861245898783`.

In the Test thread, Tergum ran Elo Beta's `/help` and changed its private menu from Match to Base. Dominik ran Elo Beta's `/queue view`; all four displayed tiers were empty, matching a raw read of `elo_beta.queue`. The beta queue was enabled; Tergum and Crystal Wolf had registered beta players with Elo 1000 and 950. These are point-in-time observations, not guarantees for another run. Cropped screenshots were saved locally under `.omo/evidence/helio-live-20261102/`; attachment delivery was not verified.

Later that day, Tergum and Crystal Wolf queued and confirmed the same beta match. Crystal Wolf's DM confirmation saved successfully but returned an unexpected error because `ctx.guild` was `None`; the automatic confirmation sweep later created the private match thread. Dominik then used Elo Beta's `/match war start` for Crystal Wolf with Balloon Moon. The Discord message and beta match and clan records agreed on the host and clan. The match remained active with Tergum's side unstarted. The full evidence and exact IDs are in `.omo/evidence/helio-live-20261102/results.md`; screenshots were saved locally, not verified as delivered.

The owner authorized choosing a configured default; the QA default is Balloon Moon (`#2RY0QP8GY`), subject to the availability checks above. Helio's separate bot is not required for real-account browser QA.
