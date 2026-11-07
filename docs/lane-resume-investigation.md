# Lane resumes its goal but keeps the session stopped

Investigated read-only on November 6, 2026. No lane commands, messages, or runtime
state changes were issued during this investigation.

The reported lane is `final-prediction-live`, session
`57503b10-fc15-4539-bf2c-986f149a81e8`. The supplied screenshots show the original
stop, the lead's subsequent resume acknowledgment, and a goal marked active.
An active goal does not prove an active agent turn.

The exact session transcript is:

```text
/var/lib/helio-agent/home/.omo/agent/sessions/--home-james-.dori-elobot-state-worktrees-final-prediction-live--/2026-11-06T18-15-52-908Z_57503b10-fc15-4539-bf2c-986f149a81e8.jsonl
```

All times below are UTC on November 6, 2026:

| Time | Recorded event |
| --- | --- |
| 18:17:17.890 | Stop adds `session_hold:1`, pause sequence 1. |
| 19:18:04.165 | Input releases that session hold. |
| 19:18:04.178 | The same hold is restored, now pause sequence 2. The lifecycle is `paused`, with no active run. |
| 19:18:04.869 | The lane registry records `working`, note `resumed by the lead`. |
| 19:34:38.416 | The freshness nudge releases the hold. |
| 19:34:38.493 | The lifecycle becomes `running`, with an active run. |

There is no model turn between the nominal resume and the freshness nudge. Later
worker activity therefore does not invalidate the original report.

`vendor/dori-mode/scripts/src/pause.ts` sends `/goal resume` and confirms only a
new `Goal active` line. It then records the lane as working. That confirmation
proves the goal command ran; it does not prove the session's execution hold ended.

The installed Senpi source explains the restored hold:

- `core/extensions/builtin/goal/command-registration.js` updates the goal and
  schedules its continuation.
- `core/extensions/builtin/goal/index.js` dispatches that continuation
  asynchronously.
- `core/agent-session.js` treats a handled extension command as a UI action,
  without admitting a model turn.
- `core/engine-turn-input.js` restores a released Stop hold when that input
  settles without an admitted turn.
- `core/extensions/builtin/goal/lifecycle-helpers.js` retains a goal wake when
  engine turns are held.

The durable hold/lifecycle events prove this happened in the reported session.
The precise asynchronous scheduling interleaving should be covered by a
reproduction in Senpi before changing its admission contract.

Proposed follow-up, requiring separate implementation approval:

1. Reproduce Stop -> `/goal resume` in the agent runtime, asserting both an
   admitted continuation and release of the observed Stop hold.
2. Make explicit goal resume participate in the runtime's session-resume
   admission contract. Preserve a newer Stop and any inherited run hold.
3. Change Dori resume verification to check execution admission, not only the
   goal notification, before recording a working lane.
4. Cover no-goal lanes, already-running lanes, a second Stop during resume,
   inherited holds, and a failed or ambiguous continuation.

Do not add a periodic retry or rely on the 17-minute freshness nudge. The
administration interface must distinguish goal acknowledgment from verified
execution until the underlying fix is implemented.
