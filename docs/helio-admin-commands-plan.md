# Helio administration commands: revised plan

## November 7 command naming amendment

The user removed the redundant `/helio` prefix. The command families below now
register directly as `/status`, `/conversations`, `/lanes`, `/blocks`, `/trusted`,
`/channels`, `/timeouts`, `/settings`, and `/audit`. Their inputs, permissions,
effects, and acceptance requirements remain unchanged. This amendment supersedes
the older prefixed examples in the historical design below.

Date: 2026-11-06. Status: implementation authorized by the owner's subsequent
“proceed”; host installation, activation, and restarts remain separately gated.

Review: independent document-only gate approved on 2026-11-06 with no blocking
findings. Live Discord and visual verification remain implementation acceptance
requirements.

This replaces the command/UI proposal in the planning conversation. It preserves
the selected permissions: trusted users can manage blocks; only the owner can
change trusted membership, channel policy, or timing settings.

## Review findings and decisions

The original proposal identified operations but left their presentation and
navigation unspecified. It also needed explicit contracts for autocomplete,
changing results, expired panels, custom text, and configuration application.

Use one ephemeral panel per invocation, containing one rich embed and conventional
message action rows. This meets the requested embed presentation without an
incompatible mixture: Components V2 disables the message's `content` and `embeds`
fields. Conventional components remain supported. [D1]
The overview documentation also explicitly preserves legacy message behavior. [D5]

Opening a panel, inspecting an item, and moving through results must not create
additional messages. A new slash invocation opens an independent panel. Navigation
edits its panel; mutations update the relevant detail view with one result line.
`Close panel` dismisses only the interface; it never closes a conversation or lane.

Native UI is the presentation system. No custom HTML, artificial tables made with
spaces, decorative graphics, or new UI framework is required.

## Command catalog

All commands belong to the Helio application under `/helio`. Each displayed
command below is an actual subcommand, not an invokable group name.

| Command | Inputs and result | Permission |
| --- | --- | --- |
| `status` | Opens the overview; optional dependency choice opens GitHub diagnostics | Trusted or owner |
| `conversations list` | Optional state, channel, user; opens matching topics | Trusted or owner |
| `conversations show` | Topic autocomplete; opens that exact topic | Trusted or owner |
| `conversations hold` | Topic autocomplete, required reason | Trusted or owner |
| `conversations resume` | Topic autocomplete; resumes its timers | Trusted or owner |
| `conversations close` | Topic autocomplete, outcome choice; previews transcript removal | Trusted or owner |
| `conversations reopen` | Recent resolved topic autocomplete; respects retention and capacity | Trusted or owner |
| `lanes list` | Optional state; opens the lane list | Trusted or owner |
| `lanes show` | Lane autocomplete | Trusted or owner |
| `lanes pause` | Lane autocomplete, required reason | Trusted or owner |
| `lanes resume` | Lane autocomplete; only existing unfinished, authorized work | Trusted or owner |
| `lanes close` | Lane autocomplete; verifies completion before closing | Trusted or owner |
| `lanes abandon` | Lane autocomplete, required reason; previews abandonment | Owner |
| `blocks list` | Optional source and user; opens the block list | Trusted or owner |
| `blocks show` | Stored block-entry autocomplete | Trusted or owner |
| `blocks add` | Native user option, required reason | Trusted or owner |
| `blocks remove` | Stored block-entry autocomplete, including departed users | Trusted or owner |
| `trusted list` | Opens current membership | Trusted or owner |
| `trusted add` | Native user option; previews the privilege grant | Owner |
| `trusted remove` | Current membership autocomplete; previews revocation | Owner |
| `channels list` | Optional policy; opens effective channel policy | Trusted or owner |
| `channels show` | Native channel option | Trusted or owner |
| `channels set` | Native channel option; normal/trusted/ignored choice | Owner |
| `timeouts show` | Opens timing and limit settings with units | Trusted or owner |
| `timeouts set` | Setting autocomplete, integer value in the displayed unit | Owner |
| `settings show` | Optional section choice; safe configuration and application status | Trusted or owner |
| `audit list` | Optional actor and action; opens authorized change history | Trusted or owner |

No generic setting-name/value editor, role-based trust grant, production restart,
merge, bulk deletion, or arbitrary shell command is added.

Use the same operations behind slash commands and panel actions. Neither path
may implement a second version of a state transition.

## Inputs and discovery

- Use Discord's native USER and CHANNEL slash options for people and channels.
  Within panels, use their corresponding select components when choosing an
  entity is sufficient to continue the flow. [D1, D2]
- Use autocomplete for Helio records: topics, lanes, stored blocks, trusted
  entries, and mutable timing keys. Native user selection cannot replace a
  search of Helio's stored block records.
- A topic suggestion contains its short title, channel and requester; a lane
  suggestion contains its name, linked issue and state. Disambiguate duplicate
  names with a short stable identifier. Submit an opaque record identifier,
  never the display label.
- Search title/name prefixes first, then substrings and linked issue numbers.
  Respect already supplied filters. An empty query suggests relevant active
  records, ordered by the same priority as the list screen.
- Return at most 25 authorized suggestions. Suggestion names fit 100 characters.
  Empty results return an empty choices array, not a selectable fake item. [D2, D3]
- Fixed outcomes, states and channel policies use choices. A single option must
  not combine fixed choices with autocomplete. Autocomplete is a convenience,
  not validation: typed identifiers are checked again when submitted. [D2]
- Reasons and arbitrary numeric values use slash options. Do not introduce modal
  forms or a workflow that asks the user to reply to an ephemeral panel.
- Panel operations needing custom text reveal the exact slash command and its
  required inputs in a contextual action screen. They must not show a button
  that promises to complete an operation but has no way to collect its reason.
  The topic/lane autocomplete ranks the panel's selected record first for that
  actor, while still requiring an explicit, validated selection.

## Shared screen structure

The section selector contains Overview, Conversations, Lanes, Blocked users,
Trusted users, Channels, Timeouts, Settings, and Audit. Switching sections remains
inside the current panel. Each section restores its own filters and position.

Each screen has a single descriptive title. Show the most actionable information
first. Use full-width embed fields and short lines; do not depend on inline
columns remaining side by side on mobile.

### Overview

Show, in this order:

1. Problems requiring attention, if any.
2. Open conversation and lane counts on one line.
3. Running/deployed version mismatch or pending configuration application, if any.

Use the section selector, then `Refresh` and `Close panel`. Do not repeat counts
inside selector labels. Detailed monitor, dependency and version information
belongs in Settings/status detail, not a wall of fields on the overview.

### Lists

Show eight records per page. Each record has a short title and no more than two
summary lines. Summaries vary by section:

| Section | Summary facts |
| --- | --- |
| Conversations | Requester and channel; waiting state and next relevant timer |
| Lanes | Linked issue; recorded state and reason it remains open |
| Blocked users | User; manual/automatic source and short reason |
| Trusted users | User; scope, without inventing historical grant metadata |
| Channels | Channel; effective policy and source of inheritance |
| Timeouts | Setting; current value and unit |
| Audit | Actor and action; target, outcome and time |

The active filter line appears once, only when filters are applied. The footer
contains `Page 2 of 4 | 9-16 of 29` and the list snapshot time.

Component rows:

1. Section selector.
2. `Open item` string selector for records on this page.
3. `Previous`, `Next`, `Filters`, `Refresh`, `Close panel`.

Disable boundary navigation buttons. Do not render an empty item selector.
Lists without meaningful filters omit `Filters`. Selectors repeat only the short
entity label needed to choose an item; they do not repeat its full summary.

A filter screen replaces the list temporarily. It contains only the selectors
applicable to that section, preselected to the current values, followed by
`Apply filters`, `Clear filters`, and `Back`. Conversation filters can use one
state selector, one user selector and one channel selector. Including section
navigation, this remains within five action rows. Applying filters starts at
page one. Back discards unsaved filter edits.

### Details

Conversations show Topic, State, Requester/channel, Request, Decision, Waiting on,
Result, and Next timer only where those values exist. On-hold topics show the
reason instead of an active countdown. Retained history belongs in Activity.

Lanes distinguish the registry state from independently checked GitHub evidence.
Show linked issue/PR, last verified activity, completion claim, and the exact
condition preventing close or cleanup. Never infer completion from age.

Block details show the full reason, source, recorded actor if known, and time.
Channel details distinguish an explicit rule, an inherited rule, and a hard
privacy exclusion. Timing details show units, supported bounds and whether the
current value is active.

Details use section navigation, an optional Summary/Activity view selector,
an Actions selector containing only relevant operations, and a final row with
`Back to results`, `Open source` when available, `Refresh`, and `Close panel`.
Back restores the list's filters and page. Opening a source does not close or
replace the panel.

Activity is separately paginated at five entries per page. Do not pack a whole
transcript into one embed. A deleted or expired transcript shows its retention
state, rather than a fabricated empty conversation.

### Editing and results

Finite changes use native selectors and show current/proposed values before the
commit button. For example, changing a channel shows its selected channel,
`Normal -> Trusted`, and the effect on response behavior, followed by
`Save channel policy` and `Cancel`. Save is the confirmation; do not ask again.

Privilege grants/revocation, abandonment and transcript-removing closure show
their exact target and consequence once. Buttons name the action: `Grant trust`,
`Remove trust`, `Abandon lane`, or `Close conversation`. Cancel is secondary;
irreversible actions use the danger style. Never use an ambiguous `Yes`.

For simple reversible operations submitted with all required inputs, the slash
submission or explicit action is sufficient. Blocking still applies all existing
request/conversation cleanup effects, which the result reports succinctly.

After a mutation, replace the editor with the updated detail and one result
line. Clear the pending confirmation controls. Do not leave a success message,
toast, unchanged preview and duplicate audit paragraph stacked together.

## Pagination, ownership and lifetime

Store a panel's actor, guild, message identity, filters, selected stable record,
view revision, navigation position and expiry. Bind components to that panel;
do not place private record data or credentials into component identifiers.

Capture ordered record IDs when opening or refreshing a list. Read their current
values and permissions on each page request. Remove unavailable or newly hidden
records and clamp the page to a valid range. New matches enter on Refresh.
Refresh preserves the first visible record where it still matches, otherwise
chooses the nearest valid page. Use a stable identifier to break sort ties.

This keeps navigation predictable while data changes. Never apply an action
using an old list position. Recheck the selected object's revision and the
actor's current authority at commit time; a changed object gets an updated
preview instead of silently applying the old choice.

Serialize updates per panel and discard obsolete render results, so rapid clicks
cannot put an older page over a newer one. Durable mutation deduplication is
separate from page navigation.

Expire panels after ten minutes without interaction. Under normal operation,
remove their controls while the last interaction token is usable. If an outage
prevents that edit, a later click returns `Panel expired. Run /helio status.`
and performs no mutation. Restart does not authorize replay of a pending action.

Initial command replies are ephemeral. Each command and component interaction is
acknowledged within Discord's three-second deadline; slow work defers, then edits
the original response. Autocomplete returns choices directly and does not defer.
Use the fresh interaction token for later interactions; do not assume the first
token lasts forever. Discord documents a 15-minute token lifetime. [D3]

## Copy and presentation contract

- One fact, one location. Titles identify; body fields explain; the footer pages.
- No greeting, repeated command echo, generic instruction paragraph, decorative
  emoji, JSON dump, or raw infrastructure path in normal views.
- Use concise state labels: Waiting on Helio, Waiting on requester, On hold,
  Resolved, Hibernated. Do not collapse distinct states into "working".
- Use Discord timestamps for events/deadlines; provide an exact time where a
  precise deadline matters. Keep units beside numeric settings.
- Keep raw identifiers in Details when useful for disambiguation, not on every
  list row. Escape user-provided Markdown and suppress unsolicited mentions.
- Default to a neutral embed appearance. Status must be readable from its text,
  independent of theme or color. Reserve strong button styles for real actions.
- Target a maximum of ten fields and 5,000 total embed characters; individual
  fields remain within 1,024 characters and descriptions within 4,096. Use
  additional views/pages for complete long content. Platform limits remain the
  hard boundary, not the target content density. [D4]
- Conventional messages permit five action rows; each row holds up to five
  buttons or one select. String selects have at most 25 options. Keep these
  budgets explicit in renderer tests. [D1]

Example only, with illustrative records:

```text
Conversations
Waiting on Helio | #helper-chat

1. Waiting-time statistics
Dominik | Waiting on Helio | Updated 12 minutes ago

2. Match confirmation errors
Participant B | On hold: beta verification

Page 1 of 1 | 1-2 of 2 | As of 14:20

[Section: Conversations]
[Open item...]
[Previous] [Next] [Filters] [Refresh] [Close panel]
```

The first two buttons are disabled in this example. On the real screen, names,
channels and times use the appropriate Discord rendering.

## Permissions and safe failure states

Check owner/trusted membership before returning any records, counts, autocomplete
suggestions, or component views. Check record visibility independently, including
private DM history. A trusted user must not inspect another person's private DM
transcript. Hard privacy boundaries remain immutable through these commands.

The panel hides unauthorized mutations. A shared slash-command root may still
show owner-only subcommands in Discord's command picker; mark their descriptions
as owner-only and enforce that rule on the server. Do not promise per-subcommand
visibility that this design does not supply.

| Situation | Display and behavior |
| --- | --- |
| No records | `No open conversations.` with one relevant next step, if needed |
| No filtered matches | `No conversations match these filters.` and `Clear filters` |
| Missing/deleted item | `This conversation is no longer available.` and `Back to results` |
| Trusted user selects owner-only action | `Only the owner can change channel policy.`; no private detail |
| Actor loses trust | `You no longer have access to this panel.`; clear its sensitive content and controls |
| Changed target | Refresh its detail/preview; require a fresh decision for a pending mutation |
| Unavailable source | Name the affected subsystem and show `Refresh`; do not show a false empty list |
| Unknown write outcome | `Checking whether the change applied.`; reconcile by operation ID, do not invite a second write |
| Failed write | Preserve the proposed values and offer a new attempt only after proving no change committed |
| Applied write | One target-specific result line and updated detail |

No empty, error or expired state should leave active mutation controls for a
target that is no longer valid.

## Configuration and execution architecture

Keep the owner-side administration controller proposed in the earlier plan.
It receives authentic Discord administration events directly, owns the
`/helio` commands and a distinct component namespace, and performs only typed
operations. The sandbox's existing interaction handler ignores that namespace.
Prove that command and component dispatch have one executor before building
further screens; the lead model is not an administration command router.

Persistent settings use the owner-controlled `~/.config/helio/helio.env`.
Slash changes, CLI rendering and deployment share one lock, validation contract,
revision check and publication path. Publish a consistent policy snapshot through
a read-only directory mount, rather than individual file mounts whose old inode
can remain visible after replacement. Update the current authorization consumers,
including release authorization, rather than only the slash handler.

Conversations, moderation and lanes stay in their existing runtime stores.
Extract shared operations where the current CLI entry points contain the
operation; do not invoke a CLI with fabricated owner-message proof. Extend
moderation authority deliberately to current trusted users for this feature.
Preserve protected users and all existing block cleanup effects.

Configuration results distinguish:

- `Saved and active` when the relevant consumers acknowledge the committed revision.
- `Saved; intake update pending` when persistence succeeded but a consumer has
  not applied it. Show the affected consumer, not a generic success banner.
- `Not saved` when validation or the canonical write failed.

Revision, source and application diagnostics belong in Settings detail. Normal
success copy can remain as short as `#helper-chat is now trusted. Active now.`
There is no ambiguous "sync back" or second settings source.

Timing edits support conversation nudge/timeout, ping and automatic-block limits,
worker capacity and hibernation through explicit typed settings. Move the
applicable existing constants into validated configuration before offering an
editor. Preserve the conversation waiting/hold semantics and existing retention.

Installation must list all shipped files explicitly in `scripts/helio_payload.py`.
Update the renderer, wrappers, consumers, deployment classification and runbooks.
The new owner-side service and mount change require a separately identified host
installation and initial workspace restart; normal kit synchronization alone
does not install the root service. No such installation or restart is authorized
by the implementation approval.

## Implementation order and acceptance

1. Establish the typed operations, canonical revision transaction, publication,
   direct Discord administration dispatch, and one-executor routing.
2. Add durable GitHub synchronization outcomes and the read-only dependency probe
   described below; do not substitute a speculative network change.
3. Define the slash manifest, authorization and autocomplete projections.
4. Implement the shared panel renderer/navigation and read-only sections.
5. Add mutation screens, lifecycle operations, receipts and application feedback.
6. Integrate installation/migration, documentation and end-to-end checks.

The feature is accepted only after all of the following have evidence:

- Every command in the catalog reaches a complete useful result, including its
  unavailable/unauthorized state. Every visible action can complete its input
  flow without an unimplemented modal or an impossible ephemeral reply.
- Owner, trusted and unauthorized role checks cover slash execution,
  autocomplete, pagination, selectors, confirmations and mid-session revocation.
- Payload checks enforce embed, field, action-row, selector, label and custom-ID
  limits, including long Unicode names, escaped Markdown and missing entities.
- Pagination covers 0, 1, 8, 9 and at least 26 records; previous/next boundaries,
  filter changes, back navigation, changing records, and out-of-order responses.
- Mutation checks cover repeated clicks, duplicate events, changed revisions,
  uncertain responses, restart recovery and pending application receipts.
- Configuration changes survive update/deploy/restart; manual configuration
  changes use the same path; trust revocation reaches existing privileged
  consumers before their next action. No deploy overwrites runtime moderation.
- GitHub outage/authentication/rate-limit fixtures preserve the sync obligation,
  distinguish it from a pending write, and update durable attempt state. Recovery
  uses the existing queue and operation markers without duplicate comments or
  issue recreation. A successful connectivity probe cannot clear a failed sync.
- A sync returning `ISSUE_LOG_PENDING` remains visibly partial even if its process
  exits zero. A human-edit conflict stays unresolved until the current issue is
  reviewed; it must not be retried as a network failure.
- Real Discord captures show overview, populated/empty/filtered lists, details,
  a mutation preview, success, pending application and expiry at desktop and
  phone widths, in light and dark themes.
- Visual checks verify readable hierarchy, native wrapping, keyboard navigation,
  named controls, text-based state cues and no repeated prose. WCAG 2.2 AA is
  not claimed from a document or a payload test; review the app-controlled
  content separately from Discord's native-client behavior.
- Live checks use the Helio application in a channel it can access. Elo Beta
  command tests do not demonstrate that these Helio commands work.

Current live-QA prerequisites remain unresolved: the three dedicated QA profiles
and their mappings were not configured in the inspected installations, and the
existing profile's BrowserSkill extension needed approval for increased
permissions. This revised plan does not claim authenticated browser QA or visual
verification has occurred.

## GitHub connection investigation and recovery plan

The owner requested investigation of the warning for issue #4. This investigation
was read-only; no issue sync, GitHub edit, comment, login change, network change,
or restart was performed.

### Observed evidence

- The lead transcript recorded this monitor receipt on November 6, 2026 at
  18:10:24.679 UTC:

  ```text
  FOLLOWUP_WARN issue sync pending: issue=4:
  ISSUE_UPDATE_PENDING error connecting to api.github.com
  ```

- Starting at 18:13:52 UTC, probes inside the active isolated Helio runtime
  successfully resolved `api.github.com` and ran all four read-only commands:
  `gh api user`, REST retrieval of issue #4, `gh issue view 4` through GraphQL,
  and `gh api rate_limit`. Every command exited zero. Authentication identified
  `jamestesting0`; REST and GraphQL both reported issue #4 closed.
- The returned issue title was "Shorten match confirmation window and record
  confirmation timing"; its last GitHub update was 11:19:53 UTC that day.
  Retain this current title/state instead of inferring it from an old lane label.
- At the probe, the REST quota had 4,981 of 5,000 requests remaining and GraphQL
  had 4,997 of 5,000. Current quota exhaustion did not explain the healthy probe.
- A read-only query found zero incomplete issue #4 operations in
  `issue-updates.sqlite`. This rules out a currently recorded unfinished write,
  not an unsatisfied synchronization obligation.
- The tracked row contains an attempt/check timestamp and an empty
  `last_warning`, but no reliable last-success or transport-failure history.
- An earlier transcript also contains a TLS handshake timeout for issue #11 at
  16:38 UTC. That is evidence of another intermittent transport failure; it does
  not prove the underlying cause of issue #4's generic error.

Interpretation: GitHub access worked at the time of the later probes. The earlier
transport failure was intermittent, but its DNS/TCP/TLS/proxy cause is unproven.
Do not call the full sync repaired or verified complete: the diagnostic commands
only read GitHub and did not execute the potentially writing sync operation.

### Demonstrated reporting gaps

`scripts/helio_issue_sync.py:reconcile` advances `checked_at` before the attempt.
Nonzero exits emit transient warning text but do not persist that failure into
`tracked.last_warning`. That field is updated on successful calls using only
`ISSUE_LINK_REVIEW` output. Consequently, an empty value is not a durable
"last sync succeeded" indicator.

`scripts/helio-issue.py` can also emit `ISSUE_LOG_PENDING` after a milestone
notification fails while allowing the overall process to return zero.
The reconciler currently ignores that marker. A refreshed issue projection,
an unfinished issue write and an undelivered milestone are different outcomes.

### Planned changes

1. Persist attempt start/end, last fully successful sync, bounded sanitized error
   category/detail, partial stage, and next due time alongside the existing
   tracked issue. Keep the synchronization obligation separate from the
   operation journal, including failures before an operation is created.
2. Record transport, authentication, permission, rate-limit, human-edit-conflict,
   and unexpected failures distinctly. Preserve the exact available stderr
   detail and failed read/write stage without recording credentials.
3. Continue using the existing five-minute reconciliation queue and durable
   operation/comment markers. Add no independent retry loop, duplicate worker,
   replacement issue, or blind comment replay.
4. Mark full recovery only after the required sync stages succeed. Keep
   `ISSUE_LOG_PENDING` visible as partial. Do not clear history or pending sync
   status merely because `gh api user` works.
5. Provide a read-only GitHub detail view through `/helio status dependency:github`
   and Settings -> Integrations -> GitHub. Its `Check GitHub` button probes access
   from the isolated runtime, not just the owner-side administration service.
   It must never invoke a writing sync as a health check.
6. Show four distinct facts without a duplicated warning paragraph:
   `Access: reachable/unavailable (checked time)`, `Last full sync`,
   `Pending syncs`, and `Unfinished writes`. Affected issue details show the last
   failed stage/time and the queue's next attempt. Connectivity and synchronization
   must not share one ambiguous green "OK".
7. A probe result is timestamped evidence, not a continuing connectivity promise.
   Preserve the last known issue/lane facts with a stale label while GitHub is
   unavailable. Do not turn an unavailable request into an empty result.
8. If failures recur, use the persisted failing stage and full sanitized
   transport detail to reproduce the DNS, TCP or TLS failure in the same
   namespace. Propose a network correction only after identifying its cause.
   Do not disable certificate verification, replace credentials, or change the
   sandbox firewall merely to suppress the generic error.

Closed issue #4 stays closed. This investigation grants no authority to reopen
it, resume historical development, or publish a GitHub message.

## Sources

Official Discord documentation checked on 2026-11-06:

- D1, Component Reference: `https://docs.discord.com/developers/components/reference`
- D2, Application Commands: `https://docs.discord.com/developers/interactions/application-commands`
- D3, Receiving and Responding: `https://docs.discord.com/developers/interactions/receiving-and-responding`
- D4, Embed Limits: `https://docs.discord.com/developers/resources/message#embed-limits`
- D5, Component Overview: `https://docs.discord.com/developers/components/overview`

Local grounding: `discord-inbound/interactive/{handler,transport,text,cli}.ts`,
`discord-inbound/{inbound,conversation,blacklist}.ts`,
`discord-inbound/intake/{authorization,filter}.ts`,
`scripts/{helio_config,helio_payload,helio_owner_policy,helio_deploy_plan}.py`,
`scripts/helio_isolated_{launcher,admin}.py`, and the prior planning conversation.
GitHub grounding: `scripts/{helio_issue_sync,helio_issues}.py`,
`scripts/helio-issue.py`, the live read-only probes and SQLite queries described
above, and lead session
`2026-11-06T18-09-12-524Z_9831be0d-0fca-4035-9aba-1f4fff3dc7f4.jsonl:97`.
