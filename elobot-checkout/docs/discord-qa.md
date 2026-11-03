# Elo Beta Discord testing

## Current workflow

Use `~/.dori/elobot/work-policy.md` and
`~/.dori/elobot/discord-qa-workflow.md` as the operational authority. The owner
confirmed on November 2, 2026 that Elo Beta is the isolated test environment.
Reuse this map instead of rediscovering the application; verify the few live
facts below before acting. The historical Firefox walkthrough later in this
file does not override the current Chrome Helio requirement.

| Concern | Verified configuration or source |
|---|---|
| Runtime | Python 3.12, `venv/bin/python -u beta.py`; never `main.py` or `watchdog.py` |
| Credentials | `BOT_BETA_TOKEN`; verify the connected bot is Elo Beta, application `1245032861245898783` |
| Database | `DATA_BASES["beta"] == "elo_beta"` in `common/constants.py` |
| Synchronization | `BETA_SYNC_FROM_MAIN = False` in `beta.py` |
| Browser | Existing Chrome **Helio** profile, attached BrowserSkill engine |
| Slash-command destination | **Test** thread `1315329739933618326` in guild `1033924790513311756` |
| Additional destinations | Must currently belong to category `1210854061050691654` |
| Supplied QA accounts | Tergum, Crystal Wolf, Dominik; recheck visible identities and roles rather than assuming their historical roles |

### Short preflight for each run

1. Inspect existing beta processes and ownership. Reuse an appropriate owned
   process; do not replace another lane's runtime. Confirm its selected bot,
   database and disabled synchronization before any command. Starting the bot
   also starts background jobs, so check their destinations before launch.
2. Run the installed browser skill's doctor, connect with
   the installed `browser-skill` CLI, and verify Helio
   and the active Discord account. Synchronize cooperation context before
   actions. Stop on denied access or a missing approved session; do not use
   another browser or API calls to execute slash commands.
3. Check current authoritative metadata for the input channel and every
   configured output destination, including the parent category. Beta database
   isolation does not establish current Discord permissions or channel scope.
   Read-only bot identity/channel metadata checks are distinct from command
   execution, which must use the real user's UI.
4. Read the relevant existing beta records before choosing a fixture. Preserve
   unrelated records and drafts. Use only supplied accounts and labelled
   fixtures. Capture and inspect current screenshots, record durable state,
   and retain owner-requested testing fixtures.

### Final setup and match-thread routing

This source map was checked on November 2, 2026:

| Step | Actual behavior |
|---|---|
| `/final start season:<number>` | Manager-only; opens registration for one existing, uniquely mapped completed season. Omitting `season` selects the latest completed archive. An active Final or an existing edition for that season blocks creation. |
| `/final add player:<user> nickname:<label>` | Adds an already registered beta player, up to eight entrants. Use a labelled QA nickname when preparing a test roster. |
| Bracket setup | Seeds, byes and pairing must be completed through the current `/final bracket` controls before a round is ready. |
| `/final round create` | Checks readiness only; does not create threads. |
| `/final round start` | Creates or resumes private match threads; does not start hosting. An entrant's unfinished match blocks provisioning. |

`cogs/final_commands.py:final_start` passes `FINAL_CHANNEL` into
`common/finals/lifecycle.py:start_final`, which persists it as
`EloFinal.channel_id`. `common/finals/matches.py:prepare_match` copies that
captured value to `Match.routing_channel_id`.
`cogs/match_commands.py:confirm_match` creates the private thread in that
channel for a Final match. Ordinary matches instead use `MATCH_CHANNEL`.
The command's input channel does not determine the new thread's parent.

In the checked configuration, `FINAL_CHANNEL` is `1392523333043617992` and
`MATCH_CHANNEL` is `1222942524839165982`. Resolve their current names and
category membership from authoritative metadata before the run. Existing
editions retain their captured `channel_id`; changing a constant does not
reroute those editions. Brackets and betting announcements use the Final's
captured channel too; result publication can fall back there from its thread.

On November 2, 2026, read-only Discord metadata verified the configured Final
destination as **elo-king-knockouts**, ordinary match destination as
**elo-matches**, and the Test thread's parent as **helper-chat**, all in the
permitted category. The beta credential identified **Elo Beta**. A direct
`elo_beta` read found an existing labelled **Beta QA** Season 13 Final:
`BRACKET_READY`, five entrants, QF1 decided, three byes, and both semifinals
ready. Its captured destination is **helper-chat**, not the current
`FINAL_CHANNEL` default. Preserve this edition; a second `/final start` would
conflict with it. These are dated observations, not authorization to change or
resume its matches.

The same run could not connect BrowserSkill: its doctor reported `no-cli`, no
daemon and no connected browser; `connectBrowserSkill()` failed with
`Executable not found in $PATH: "bsk"`. The usual local executable locations
were also absent. No local beta process was running. No slash command, fixture
write, runtime launch or screenshot capture occurred. Restore the approved
Helio BrowserSkill connection before attempting UI actions; do not install a
replacement profile or substitute API execution.

For a retained owner-testing tournament, first verify a qualifying completed
archive and no conflicting active edition in `elo_beta`. Select **Elo Beta**
explicitly in the Test thread's slash-command picker, then run `/final start`
with that archive's season number. Record the created edition and label its
test roster/evidence. Do not manufacture a completed production season or
cancel someone else's Final to satisfy setup. If no qualifying archive exists,
report that blocker before seeding anything.

The disposable integration fixture in `tests/integration/_final_fixture.py`
creates and drops separate `elo_final_it_*` databases with synthetic users.
It is not a setup script for live `elo_beta` or the supplied Discord accounts.

## Historical Firefox walkthrough

The notes below preserve prior observations. Their Firefox instructions and
older channel selection are superseded by the current workflow above.

Use the user's supplied Firefox sessions for a requested live walkthrough. The native Discord app previously contained a private message draft and was excluded from testing. Preserve drafts, account sessions and unrelated messages.

## Accounts and destinations

These accounts were observed during the earlier walkthrough. Recheck the active account and roles before acting; tab position alone does not establish identity.

| Account | Test role |
|---|---|
| Crystal Wolf | Player; profile, participant and betting checks |
| Tergum | Player/opponent; non-manager and foreign-control checks |
| Dominik | Third supplied account; the user gave it Elo Manager for setup and corrections |

Use a bettor who is outside the selected match. A manager account can still be a participant and must then be denied betting on that match. Do not change Discord permissions to make a test pass.

| Resource | ID / location |
|---|---|
| Guild | `1033924790513311756` |
| Beta slash-command channel, helper-chat | `1218071208197623880` |
| Main command channel | `1220331873079922810`; use the beta channel above for this walkthrough |
| Final betting announcements | `1392523333043617992` |
| Beta database | `elo_beta`, selected through `DATA_BASES[VERSION]` |

The beta command-channel correction came from the user. Deployment constants live in [common/constants.py](../common/constants.py). Beta and main share Discord channels; a separate database does not make every message in those channels disposable.

## Start a session

1. Read the current user constraints and inspect existing bot processes. Use Python 3.12 and run only `venv/bin/python -u beta.py`. Do not start `main.py` or `watchdog.py`, or replace a process you do not own.
2. Verify the runtime selects `elo_beta` and keeps `BETA_SYNC_FROM_MAIN = False`. Keep credentials in the existing configuration, out of commands, screenshots and reports.
3. Inventory the supplied Firefox tabs using the available browser/native UI tools. The earlier run used native computer control and unchanged Firefox screenshots. If a direct Firefox automation route is unavailable, use the native Firefox surface rather than silently moving to another browser.
4. Inspect the visible account, guild and channel before each command. Select the beta bot's slash command explicitly. Use the match's own thread for its participant controls.
5. Inspect existing beta state before setup. Reuse a labelled QA fixture where appropriate; record its season, match and participants. Do not overwrite an active bracket or unrelated bets. Capture relevant results, profiles, predictions, wallets, ledger and ordinary ranked state before mutations.

Firefox/Discord lessons: navigating once selected a shared login, so a tab's old contents were not reliable proof of its account. The saved-account switcher restored the intended account. Recheck all three sessions after navigation or account switching. Cached slash-command definitions also produced an outdated-command error; refreshing the affected tab resolved it. That error was not a passing command result. If the accessibility tree disappears, reacquire the native Firefox state before further clicks.

## Exercise the interactions

Check the response and persisted state together. Useful scenarios are:

| Scenario | What to observe |
|---|---|
| Manager setup and bracket | Registration, seeds/byes and pairing steps; Back/Next boundaries; the saved bracket and rendered attachment agree |
| Predictions | Full draft, Back/Next, review, submit and later view; manual closure rejects further submissions |
| Betting | Manager uses `/final betting announce match:QF1`; announcement reaches the Final channel; a nonparticipant confirms a stake, edits it and cancels it; wallet, ledger and pool agree |
| Ownership and stale controls | Another account cannot operate a public profile's owner-bound controls; duplicate/old confirmations are rejected without a second write |
| Profile and matches | Avg. labels, opponent/outcome/totals, latest official result once; arrows, counter, jump modal and disabled boundaries follow existing commands |
| Bases | `/match base submit base_link:<link> match:QF1 [base_ss:<attachment>]` saves the identified district; `/match base view match:QF1` shows all seven. The match option can be omitted in its thread |
| Results | Seven score lines per player; ephemeral preview; Cancel leaves state unchanged; Confirm saves once; manager correction repairs dependent state |
| Failure and recovery | Failed writes show failure; committed work with failed publication remains saved and visibly pending; retry does not duplicate work |

Ephemeral reviews belong to their originating account. Use that account to inspect and act on them; use public controls for cross-account UI checks. Synthetic scores must belong to a labelled beta fixture. Viewing a bet review does not prove confirmation, and clearing empty base fields does not prove valid game-base submission.

Real hosting and Helper checks require designated test resources. Use an isolated Helper backend/clans for the seven-district path. Without those resources, record the remote gate as unverified and continue independent checks. Mocked transport can verify ordering but cannot prove remote execution.

## Appearance and evidence

Inspect desktop and a narrow viewport. Earlier narrow checks used 768×1000 with the member pane hidden; that is not proof of a phone layout. Check wrapped titles, score rows, mentions, custom emojis, buttons, selectors and modal fields. Capture the relevant response, including private previews from their owning account. Restore viewport and sidebar settings afterward.

Save screenshots, scoped UI text, runtime/integration logs and before/after state under `.omo/evidence/elo-final/<dated-pass>/`. Keep one `ui-review.md` covering behavior, appearance and copy. Separate observed, failed and unverified scenarios. Payload assertions do not substitute for live screenshots, and old screenshots do not prove new rendering.

Earlier live evidence covered commands, predictions, betting edits/cancellation, result corrections and navigation. Setup/manual pairing had been seeded through services, some base checks used empty fields, and remote hosting/Helper, live spending/debt and the full narrow matrix remained unverified. See the [UI review](../.omo/evidence/elo-final/ui-review.md) for the exact boundaries. Existing beta logs also recorded dashboard edits against another bot's messages returning 403; identify the message author rather than changing permissions or using the main token.

Stop only processes and containers owned by the test run. Preserve the labelled fixture, other users' stakes, account sessions and unrelated work unless cleanup was requested.

## Automated checks alongside live QA

Run focused regressions for affected behavior. At required integration milestones, compare full-suite failures with a fresh baseline by test identity. Do not weaken tests to remove existing failures.

Final integration uses real Beanie models and a disposable loopback MongoDB replica set, with external transport mocked. The fixture creates unique `elo_final_it_*` databases and drops them afterward. Follow the setup in [the CI workflow](../.github/workflows/python-tests.yml); it enables MongoDB test commands for failpoint scenarios. Then run with an explicit URI for that disposable instance, for example:

```bash
FINAL_TEST_MONGO_URI='mongodb://127.0.0.1:27018/?replicaSet=elo-final-it&directConnection=true' \
  venv/bin/python -m unittest discover -v -s tests/integration -p 'test_final_*.py'
```

Never inherit production credentials for integration. Missing MongoDB, setup failure, zero collected tests or a skipped suite cannot count as a passing gate. Database tests and live Discord appearance are separate evidence. Documentation-only changes need link, command and convention checks, not application test runs.
