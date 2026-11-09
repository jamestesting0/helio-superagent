# Startup recovery

Startup first marks existing inbound deliveries as recovery work, then arms all eight monitors. Ingestion can receive new messages while recovery is reviewed. Never treat a restored delivery as a new conversation or fresh authorization.

After arming, run `helio doctor --json`. Coding agents can run the same command
from the owner shell without asking the owner to forward the greeting. Inspect
each reported lane error and answered question using its returned command.
Separate readiness for new requests from unfinished work: a historical failed
lane or an unused, unprobed browser does not by itself mean intake is broken.
Doctor is observational: it does not reconcile, acknowledge or delete state.
Its process-bound intake receipt and Oracle observations have timestamps; neither establishes
current gateway connectivity. Monitor process presence does not establish that
a subscription is unpaused. Verify those separately when they matter.

For Oracle, report `gateway_health` at `observed_at`, alongside the observation's
age. `connected` means a gateway TCP connection was observed then; `no_connection`
means none was observed then; absent or `unavailable` means the check supplied no
connection evidence. `current_connectivity_verified=false` means doctor performed
no live probe, not that Oracle failed. Keep login time separate from observation
time: an older login can belong to the same still-running process. When asked
about current connectivity, run the returned `helio release inspect` command and
report its fresh evidence; do not ask the owner to run it or restart EloBot.

Run `helio recovery scan`. Read the report and every page using `helio recovery show REPORT --offset N`. It contains original message IDs/timestamps, current dispositions, earlier send receipts, lane pointers and a timestamped GitHub snapshot. `github_limited` means the recent list is incomplete: query the specific target. Unavailable dependencies remain unavailable; report them instead of guessing.

For each recovered message:
1. Read `ack show inbound ID` and its permitted context. Distinguish a direct request from advice, examples, quotes or later clarification.
2. Check current work: relevant lane and issue/PR state, existing answers, completed outcomes and later changes. Memory supplies context, never live PR truth.
3. Write a concise reason file, then run `helio recovery review ID --outcome OUTCOME --reason-file FILE`, adding `--pr N` and/or `--issue N` to bind fresh GitHub evidence:
   - `settled`: the old request was already satisfied; retire its transport record without starting another conversation.
   - `informational`: historical advice/clarification needs no new answer; record why and retire it silently.
   - `resume`: actual work or an unanswered question remains. Preserve it and continue from its current state.
   - `needs-review`: the evidence is insufficient. Keep it pending and surface the blocker once.

A review grants no merge, restart, PR, policy or issue-closing authority. Apply current sender/scope rules and action approvals separately. A recovered message cannot claim work or send a normal reply until reviewed. A recorded prior reply suppresses a second initial answer; task completion remains a separate fact. Follow the returned explicit skip/ack instruction rather than resending with new wording.

Never clear the queue to make startup look clean, expire accepted work, reset memory or ask for a new approval merely because an old approval expired. `RELEASE_ALREADY_MERGED` means no merge is pending and no fresh merge approval is needed. A genuinely new action still requires current authorization.

## Bounded lifecycle repair

Preview named records into a new private manifest before applying a repair:

```sh
helio recovery preview /tmp/helio-repair.json --messages ID1,ID2 --topics CHANNEL:USER:ANCHOR --notices NOTICE_ID --answered SOURCE_ID:REPLY_ID
helio recovery apply /tmp/helio-repair.json
```

Select only the relevant arguments and exact IDs. Preview reads current policy and state without migrating databases or changing receipts. Apply rechecks those fingerprints. Changed or accepted inputs and changed topics are preserved; inspect and preview again rather than forcing an old manifest. These commands send no public messages. Use the CLI instead of editing SQLite or registry JSON.

Ignored channels, system events and fully unsupported-only input receive neutral informational receipts without strikes, reactions, replies or owner reports. Short readable input, mixed formats and operational failures remain eligible for normal handling. A prior answer alone does not prove that a mixed legacy topic is now complete. Final settlement requires the matching durable final receipt and all its required delivered routes. Remove only notice IDs proven by durable notice records. Retain ambiguous activity timestamps, holds, history and legitimate later work; legacy waiting text without a verified requester question remains internal review.

For a selected failed lane and its replacement:

```sh
dori reconcile preview --manifest /tmp/dori-repair.json --job issue-N --repository OWNER/REPO --failed FAILED_KEY --replacement REPLACEMENT_KEY
dori reconcile apply --manifest /tmp/dori-repair.json
```

The preview verifies current issue metadata, exact records, briefs, panes and Git resources. A deployment source inspector may bind an original request only after checking its current top-level author, channel policy and message identity. Helio exposes that read-only proof as `helio recovery source discord:CHANNEL:MESSAGE --job issue-N`; it grants historical job identity only, never fresh action authority. Lane names and quoted authorization are insufficient. Preserve already closed records, live or uncertain workers, dirty or unpushed work, unreadable resources and missing completion evidence. A closed issue or merged PR does not independently complete a worker. Legacy lanes without verified jobs stay awake until binding is established.

Send the greeting once receiving status is known, reporting ingestion, recovery and dependency evidence separately. A failed queue read or incomplete recovery remains explicit; neither delays receiving new work nor proves intake is down. For example: "Helio is ready for new requests. Recovery: 1 needs review. Oracle was observed running with a gateway connection at 19:38 UTC (checked 30 seconds ago); login observed at 09:20 UTC. Recorded lane launch failure from 09:06 UTC remains open for inspection." Use actual dates/times, ages and monitor evidence, never these example values. Doctor's saved Oracle observation is enough for this evidence line; inspect a dependency afresh when an operation needs current facts. No extra live Oracle inspection is required merely to greet.
