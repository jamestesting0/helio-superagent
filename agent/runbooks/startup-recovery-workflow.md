# Startup recovery

Startup first marks existing inbound deliveries as recovery work, then arms all eight monitors. Ingestion can receive new messages while recovery is reviewed. Never treat a restored delivery as a new conversation or fresh authorization.

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

Before greeting, report ingestion, recovery and dependency state separately. For example: "Helio is ready for new requests; all eight monitors are running. Recovery: 2 historical messages settled, 1 unfinished task resumed, 1 needs review. GitHub available; Oracle login observed, current gateway health unverified." If a dependency or recovery scan failed, say which; running monitors alone do not mean recovery succeeded.
