# Helio administration acceptance evidence

Date: 2026-11-07. Status: source/offline gates APPROVED, including direct DM commands. The owner explicitly
deferred live testing and corrected the account mapping: none of the three QA
accounts is the Helio owner. Two reviews rejected seven initial omissions and
three additional failure paths. Their corrections now have targeted regressions
and final integration receipts below. Native Discord behavior
remains unverified, and host activation requires separate authorization. This record
does not authorize activation, account changes, messages, or mutations of existing
work. The November 7 request adds DM command support and authorizes DM command
registration. It does not authorize host installation or service activation.
The subsequent naming correction removes `/helio`: the nine command families
register directly, with the same 27 operations, options, and permissions.

The contract is `helio-admin-commands-plan.md`; installation and operation are in
`helio-admin.md`. Preserve existing source changes, browser profiles, sessions,
and runtime work while gathering evidence.

## Final source verification

The latest source includes DM parsing, configured-server permission scope,
DM registration independent of guild access, and usable DM input guidance.
Native client execution remains unverified.

| Transcript line | DM-capable source verification |
| --- | --- |
| 3234 | Full Python suite: 473 tests, OK, exit 0 |
| 3521 | Final full inbound suite with direct command names: 650 passed, zero failed, 67 files; strict TypeScript check of 76 files passed; exit 0 |
| 3509 | Final installed helper/admin paths: 93 passed, zero failed, eight files, with frozen offline dependencies; exit 0 |
| 3495 | Final controller preview: 177 modules; SHA-256 `f1e088da1d2b90dea92267e7a141f2c6404b752d3a305ebd46acab42f8d106d1`; applied false; patch whitespace check exit 0 |
| 3103 | Read-only Discord preflight: application `1566777045478801458` has guild/user installation types, no Interactions Endpoint URL, and no existing global `/helio` at inspection time |

DM regressions exercise top-level `user`, absent guild/member fields, both
documented channel shapes, actor revocation, autocomplete, owner confirmation,
DM message binding, and server-scoped runtime requests. Registration tests use
the actual SDK at its HTTP boundary and prove DM availability without reading
an inaccessible guild catalog. DM guidance emits no guild-only member/channel
menus. A deterministic expired-budget test proves that DM policy resolution
cannot cause a late runtime dispatch; the supplied timeout covers both legs.
Registration and live response status are recorded separately below.

The direct-name amendment flattens the former `/helio` command into nine root
commands without changing its 27 operations. Registration creates/upserts all
nine before deleting the legacy prefix in that scope, preserves unrelated
commands, and reports readiness only for a complete catalog. SDK-boundary tests
cover replacement failure and incomplete catalogs; controller fixtures now use
the direct Discord payload grammar. The November 7 naming addendum in the plan
supersedes its historical prefixed examples.

## Actual DM registration and remaining activation

On November 7 the authorized registration was applied to application
`1566777045478801458`. Raw transcript line 3604 records successful direct-command
registration. Independent GET readback at line 3618 verified:

- Nine roots: `/status`, `/conversations`, `/lanes`, `/blocks`, `/trusted`,
  `/channels`, `/timeouts`, `/settings`, and `/audit`.
- All 27 operations, bot-DM context `[1]`, and installation types `[0,1]`.
- No legacy type-1 `/helio` command remains.
- All three DM channel inputs use string-ID autocomplete.

This proves registration, not a successful native invocation. The same readback
found the expected installed controller and broker socket absent. Replies still
require the separately authorized root/controller installation, managed runtime
deployment, initial workspace restart for the new mounts, and administration
service activation described in `helio-admin.md`. None of those host actions was
performed, and no live domain mutation, user message, or code commit was made.
Native Discord interaction and live namespace/application behavior remain
unverified under the recorded testing deferral.

## Verification before DM support

All code changes preceded these runs. Raw lines refer to the session transcript
identified below; these receipts cover the preceding gate corrections.

| Transcript line | Final verification |
| --- | --- |
| 3000 | Full Python suite: 473 tests, OK, exit 0 |
| 2998 | Full inbound suite: 633 passed, zero failed, 66 files; strict TypeScript check of 74 files passed; exit 0 |
| 2958 | Actual temporary-home installed helper/admin paths: 76 passed, zero failed, seven files, after frozen offline dependency installation; exit 0 |
| 2972 | Controller preview: 176 modules; SHA-256 `42eed1835aa06d1c5348f33bec5603d1cfb25f15260b99222742a413df132de5`; applied false; chained patch whitespace check exit 0 |
| 2982 | Final root bundle parses with Python 3.12; isolated issue/update helpers parse with Python 3.10; exit 0 |

Unchanged Dori source and service definitions retain their earlier 174-test and
unit-verification receipts. Live UI and namespace checks remain deferred. No
code commit, production/host installation, command registration, service start,
or restart was performed.

## Recorded offline evidence before gate corrections

The completed runs in this implementation session reported:

| Boundary | Evidence | Result and scope |
| --- | --- | --- |
| Python regressions | `tests/`, full discovery run | 469 passed; offline configuration, privileged routing, issue synchronization, installation, and adjacent behavior |
| Inbound regressions | `discord-inbound/`, full Bun run | 609 passed; fixture-based intake, conversation, moderation, administration, and adjacent behavior |
| Dori regressions | `vendor/dori-mode/scripts/`, full Bun run | 174 passed; lifecycle/configuration contracts |
| Installed helper layout | Temporary-home installation, cache pack/unpack, frozen offline dependency installation, then installed helper tests | 35 passed; exercises the installed paths rather than source paths |
| Fresh-install correction | `tests/test_install.py`, after supplying default lane settings | 14 passed |
| Managed update | `tests/test_sync.py`, `tests/test_legacy_sync.py` | 22 and 4 passed |
| Controller build | `scripts/helio_admin_install.py`, preview only | 176 modules; SHA-256 `a90312f454e30472cdd434bba2ecc95a65260c6e7ca95177655f4708da8c39c5`; not installed |
| Service definitions | `systemd-analyze verify` on both new administration units | Exit 0; no unit was activated |
| Target Python syntax | Parse all `helio_root_bundle.py:BUNDLE` scripts with the service Python 3.12 | Exit 0; does not prove live namespace execution |
| Unix peer boundary | Disposable root-owned socket using real owner and isolated UIDs | Owner accepted; isolated UID denied despite filesystem access; oversized frame rejected before dispatch |
| Patch hygiene | `git diff --check` | Exit 0; unrelated working-tree changes preserved |

These are recorded test results, not native-client screenshots. The passing
administration transport and strict TypeScript checks also preceded the final
controller build. Do not count fixture responses as successful live commands.

The raw evidence is in the local session transcript
`~/.omo/agent/sessions/--home-james-PythonProjects-helio-superagent--/2026-11-06T17-26-59-694Z_01a1b1e6-416e-7ab0-a4de-c7a506053825.jsonl`.
Monitor completion records are `custom_message` entries. Original line references:

| Transcript line | Evidence |
| --- | --- |
| 1470 | Corrected administration tests and TypeScript boundary check: 20 tests, exit 0 |
| 1517 | Dori: 174 tests, exit 0 |
| 1533 | Inbound: 609 tests, exit 0 |
| 1551 | Python: 469 tests, OK, exit 0 |
| 1739 | Final controller preview build and hash, exit 0 |
| 1767 | Final temporary-home cache transfer, offline install, and 35 helper tests, exit 0 |
| 1809 | Disposable real-UID socket authorization and framing, exit 0 |
| 1868 | Root-bundle Python 3.12 parse check, exit 0 |

## First correction verification

The raw transcript identified above contains the new receipts:

| Transcript line | Corrected implementation evidence |
| --- | --- |
| 2642 | Full Python suite: 472 tests, OK, exit 0 |
| 2640 | Full inbound suite: 625 passed, zero failed, exit 0 |
| 2612 | Temporary-home installation, frozen offline dependencies, and 68 tests across installed helpers and administration modules; zero failed, exit 0 |
| 2612 | Controller preview: 176 modules; SHA-256 `73926fccccbc5364a40f4d8a207a158073f85777694e505a56ae04690f718b5d`; not installed; patch whitespace check exit 0 |
| 2666 | Final isolated lane timestamp presentation regression: one passed; strict TypeScript check of 74 files passed |
| 2652 | Root bundle parses under Python 3.12; updated isolated issue/update helpers parse under Python 3.10; exit 0 |
| 2638 | Real journal API with disposable SQLite state: late refusal/disconnect cannot regress an authoritative settled receipt |
| 2458 | Real issue command adapter with mocked process boundary: write stage reaches failure classification; comment-write timeout remains uncertain |

For that review, the only code change after the full integration/installed-layout runs formatted
isolated lane activity as native Discord timestamps; line 2666 covers that delta.
It did not change that owner controller bundle. Subsequent corrections and their
final receipts are recorded above. Dori source and service units
have not changed since their earlier passing 174-test and unit-verification
receipts. No production or host installation was changed.

## Live prerequisites

A read-only host check in this session found that the administration broker
script and controller bundle are not installed, and the administration socket
does not exist. The root-bundle preview lists the new administration helpers,
units, policy/configuration helpers, launcher/deployment helpers, and template;
it made no changes.

The owner home has no dedicated QA account map or `qa-a`/`qa-b`/`qa-c` directories.
The isolated home does have existing profiles and a map:

| Profile | Recorded account | Recorded BrowserSkill instance |
| --- | --- | --- |
| `qa-a` | Dominik | `7e9ce15e` |
| `qa-b` | Crystal Wolf | `9b84acd9` |
| `qa-c` | Tergum | `44c9102e` |

The map proves configured identities, not current sign-in, connectivity, or
Helio trusted roles. The owner confirmed that none is the Helio owner, superseding
the briefly supplied identification of Dominik as owner. Owner-only live scenarios
need a separately supplied owner login if live testing is resumed.
Inspect their visible Discord identities before use.
Use those existing isolated profiles; do not create owner-home replacements or
copy their sessions.

The owner-side browser doctor reported `no-daemon` with `BSK_AUTO_START=0`.
That observation does not establish the isolated daemon's state. Browser checks
must use the isolated profile's actual BrowserSkill environment.
The isolated `browser-env` selects `$HOME/.bsk` and `$HOME/.local/bin/bsk`.
A subsequent read-only scope check reported `helio-isolated.scope` inactive
with no control group. Its scoped namespace is therefore unavailable for a
daemon/extension check. Start the workspace only after the host activation is
authorized; do not start a substitute daemon against the owner home.

Before live execution, obtain separate current authorization for host
installation/deployment, the initial full workspace restart, guild command
registration, service activation, and Discord QA interactions. Confirm a
permitted channel accessible to the Helio application and the test accounts.
The Elo Beta Test-thread procedure does not establish Helio access or permission
to change that thread's access.

## Command execution matrix

Every row is **DEFERRED BY OWNER; UNVERIFIED LIVE**. For a future execution, retain the actor's verified
role, exact supplied options, selected application, response/capture, operation
ID where applicable, and independently observed result. Exercise unavailable
and unauthorized outcomes as well as the useful result.

| Command | Useful result and independent observation |
| --- | --- |
| `status` | Overview counts and problems match authorized runtime observations |
| `status dependency:github` | Timestamped read-only probe; failed synchronization remains visible |
| `conversations list` | Filtered authorized topics; stable IDs across pagination |
| `conversations show` | Exact selected topic and complete retained details/activity |
| `conversations hold` | Reason shown; requester timers suspended |
| `conversations resume` | Existing hold cleared and timers resumed |
| `conversations close` | One consequence preview; chosen outcome persisted; transcript removed |
| `conversations reopen` | Retained resolved topic reopened within capacity and retention rules |
| `lanes list` | Recorded lane states and reasons shown without inferring completion |
| `lanes show` | Registry, issue/PR evidence, and actual session execution remain distinct |
| `lanes pause` | Authorized existing lane paused with supplied reason |
| `lanes resume` | Existing unfinished lane resumes; acknowledgment alone is not reported as running |
| `lanes close` | Independent completion checks pass; surviving terminal reported as cleanup pending |
| `lanes abandon` | Owner-only preview; abandonment recorded and worktree retained |
| `blocks list` | Manual/automatic source and user filters preserved |
| `blocks show` | Exact stored entry, including departed users and full reason |
| `blocks add` | Authorized owner/trusted change; protected users excluded; cleanup effects observed |
| `blocks remove` | Exact stored block removed once |
| `trusted list` | Current canonical membership without invented grant history |
| `trusted add` | Owner preview and one canonical grant; application status observed |
| `trusted remove` | Owner preview and revocation reaching current consumers |
| `channels list` | Effective explicit/inherited policy and filters |
| `channels show` | Exact native channel selection; inherited/hard privacy distinguished |
| `channels set` | Owner finite preview; canonical lists and current application agree |
| `timeouts show` | Values, units, supported bounds, and application state |
| `timeouts set` | Owner integer edit validated and persisted canonically |
| `settings show` | Safe configuration and process-bound application receipts |
| `settings show section:github` | Same read-only GitHub facts as dependency detail |
| `audit list` | Authorized history with actor/action filters and actual operation outcomes |

Do not mutate shared active lanes or real trusted membership merely to produce a
screenshot. Live mutation scenarios need explicitly authorized disposable targets
and a restoration record; otherwise leave the affected row pending.

## Interaction and visual matrix

Capture every applicable screen at desktop and phone widths in both light and
dark themes. Keep screenshots, action transcripts, fixture identities, and
observations together. A pending row becomes PASS only with an artifact that
shows its actual result on the final deployed build.

| Scenario | Existing offline owner | Required live evidence | Verdict |
| --- | --- | --- | --- |
| Owner, trusted, unauthorized slash execution | `admin/controller.test.ts`, `tests/test_helio_admin_service.py` | Each verified identity executes or is denied; no leaked records | PENDING |
| Autocomplete and typed-ID validation | `admin/interaction.ts`, `admin/controller.test.ts`, `admin/backend.test.ts` | Authorized suggestions, empty search, 25-choice cap, filter and selected-record ranking; invalid submission denied | PENDING |
| Overview and all section destinations | `admin/render.ts`, `admin/controller.ts` | Native hierarchy, section switching, one panel edited rather than extra messages | PENDING |
| Lists with 0, 1, 8, 9, and 26 records | `admin/render.test.ts` | Empty/populated pages, disabled boundaries, no empty selector, stable first record on refresh | PENDING |
| Filters, Back, and section positions | `admin/controller.ts`, `admin/panels.ts` | Apply/Clear/Back, discarded drafts, preserved section filters and position | PENDING |
| Missing or newly hidden selected record | `admin/controller.test.ts` | Correct unavailable view; no action applied to a replacement record | PENDING |
| Details and long activity | `admin/render.test.ts` | Full retained text across Summary/Activity pages, Unicode and escaped Markdown; no unwanted mentions | PENDING |
| Native user/channel pickers and reason guidance | `admin/editor.ts`, `admin/controller.test.ts` | Finite selection completes; custom text gives exact usable slash inputs | PENDING |
| Preview, Cancel, changed target, success | `admin/controller.test.ts`, `admin/editor.ts` | One consequence/confirmation; Cancel leaves state intact; changed target requires fresh decision | PENDING |
| Duplicate and concurrent confirmations | `admin/controller.test.ts`, `admin/backend.test.ts`, canonical transaction tests | One persisted transition and one receipt; no duplicate write offered | PENDING |
| Unknown outcome and unavailable detail reload | `admin/controller.test.ts`, `admin/transport.test.ts` | Operation reconciliation; committed result retained when details cannot reload | PENDING |
| Expiry and controller restart | `admin/controller.test.ts`, `admin/panels.ts` | Controls removed; old confirmation cannot replay; no domain mutation | PENDING |
| Foreign actor and trust revocation | `admin/controller.test.ts`, `admin/backend.test.ts` | Foreign controls denied; revoked panel cleared; autocomplete/read/write denied | PENDING |
| Private DMs and channel visibility | `admin/backend.test.ts`, `admin/runtime-access.ts` | Another user's DM content and inaccessible-channel records remain hidden | PENDING |
| Saved, active, and application pending | `tests/test_helio_config.py`, `intake/runtime-policy.test.ts`, `admin/policy-records.ts` | Revision and live process identities agree, including mounted atomic replacement | PENDING |
| Persistence and manual configuration | Configuration, installer, synchronization, and policy regression suites | Slash/CLI changes survive managed update, deployment, and approved restart; moderation preserved | PENDING |
| GitHub failure, partial result, and recovery | `tests/test_helio_issues.py`, `scripts/helio_github_status.py` | Probe remains read-only; queue/history retained; no duplicate comments or recreated issues | PENDING |
| Keyboard, labels, focus, wrapping, and theme | Native Discord components; payload-budget tests | Named controls usable with keyboard; readable text cues; no clipping/overlap or repeated copy | PENDING |

Review Helio-controlled content separately from Discord's client behavior.
Native payload limits do not prove accessibility compliance. Apply the original
plan's native-screen contract; do not introduce a custom HTML renderer as a
substitute for Discord.

## Final gate

The first implementation review rejected the tree; its preserved evidence is
`.omo/evidence/helio-admin-commands-gate-review.md`. A new review must judge the
corrected tree after integration checks, rather than treating the earlier green
suite counts as coverage of those findings.
The second review is preserved at
`.omo/evidence/helio-admin-commands-gate-review-corrections.md`; it resolved the
original findings apart from two further cases and identified a separate
definite-refusal omission. Its F1/F2/F3 corrections are listed below. Both
historical REJECT reports remain unchanged. The final source/offline verdict is
APPROVE at `.omo/evidence/helio-admin-commands-gate-review-final.md`, including the
shared DM callback budget correction. This does not establish live replies or
authorize host activation.
The later naming delta is also APPROVED at
`.omo/evidence/helio-admin-commands-gate-review-direct-commands.md`. It preserves
the preceding approval and historical reports.
Provide the full goal, constraints, final diff, preserved shared-work boundaries,
and QA artifacts to one gate-review subagent. Live rows are excluded from the
current gate by the owner's explicit deferral; they remain unverified rather
than passed. An approving implementation gate does not establish native-client
acceptance or authorize deployment.

| Finding | Correction and regression owner |
| --- | --- |
| B1: private channel metadata | Discord visibility is checked independently of response policy; backend cases cover normal, trusted, ignored, excluded, and outside-scope channels |
| B2: missing legacy lane settings | Managed legacy updates initialize the missing projection; the legacy tests load the resulting configuration through real Dori code |
| B3: unresolved receipts | Canonical/runtime/domain reconciliation, retained read-only pending controls, and Audit recovery; root, backend, and controller regressions cover lost responses and restart |
| B4: ignored rules cannot be restored | Real channel ancestry is read through a metadata-only capability; message reads/writes remain blocked |
| B5: GitHub detail loses its result | Per-panel observations survive pagination/Refresh; an explicit Check GitHub replaces the snapshot |
| B6: incomplete sync outcomes | Classified failures, read/write stages, end times, due times, and review holds; queue/probe regression and offline command-adapter check |
| B7: incomplete lane evidence | Recorded Done/cleanup/checks retained, current GitHub/worktree/pane evidence and receipt binding shown; backend test proves arbitrary Done commands are not run |
| Additional unavailable-view contract | Policy/runtime outages retain Refresh without mutation controls; controller regressions |
| Recovery visibility | Pending Audit entries redact unverified targets; receipt inspection checks target access even without a runtime row |
| F1: combined review/write failure | Review eligibility is retained independently of error category across partial output, split stdout/stderr, and timeout capture; real queue tests prove no retry until explicit review |
| F2: ignored private threads | Exact actor-bound membership metadata is permitted; backend membership/ignore combinations and REST content/foreign-member/list/write refusals pass |
| F3: refused proposed values | Inputs survive direct/reconciled refusals and changed confirmations; Refresh reads the current target and creates a fresh explicit decision and operation ID; ambiguous/malformed replies retain read-only receipt recovery |
