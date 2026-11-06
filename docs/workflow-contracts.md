# Workflow contracts

An accepted implementation or PR revision is one task, including the necessary
commits and ordinary branch updates. Explicit publication holds remain binding.
Source/trust checks and separate production authority remain real boundaries.

Closed issues remain historical. Triage still uses their evidence and links,
but new unresolved scope gets a new issue through `helio issue followup`.
Its body contains a canonical predecessor reference; the old issue is not
reopened or edited by creation. Repeated delivery of the same request resolves
the same new issue. Raw paginated API reconciliation recovers an uncertain
successful creation; an unresolved write never triggers a blind second POST.
New scope gets current authorization and PR closing metadata. Old plans and
approvals do not transfer. An existing open PR can be safely rebound to a
verified linked issue; merged/closed PRs remain history. Pending legacy reopen
intents are retired locally without reverting already completed external changes.

Routine PR repair belongs to that same task. Workers integrate owner pushes to
main in their own worktree, resolve compatible conflicts by intent, inspect and
fix task-caused CI failures, and resubmit without another commit/push question.
The submit gate checks main again after testing and PR publication; if it moved,
the worker verifies the updated tree through the same gate. It never force-pushes.
An unresolved product conflict, access failure, explicit hold or scope expansion
still needs the appropriate human decision after independent work is complete.

Inspect a published PR with:

```sh
helio pr check --number 14
```

This is read-only. It reports the observed head/main pair, ancestry, mergeability,
and CI as `FOLLOWUP_PR_READY`, `FOLLOWUP_PR_WAIT` or `FOLLOWUP_PR_REPAIR`.
The existing five-minute follow-up watcher inspects canonical `helio/` PRs after
workers close, so a later main push or failed check returns to the existing job.
The pointer grants no authority; current source, holds and the original PR/autofix
gate still apply. A pending/unknown check is not success. Release checks also
require known mergeability, and head-pinned approvals do not survive repairs.

For delegated work, the lead owns the public completion. Workers return results
and evidence privately. `evidence.ts` defaults to a `completion` event and shares
its durable delivery owner with `reply.ts --event completion`. Identity is the
destination, current request message and event, rather than the text. Use the
current request ID for follow-ups in an old lane. A later CI result uses a
different event, such as `ci:FULL_SHA`. Replies without an event keep legacy
text identity for ordinary answers and progress.

Each privacy destination is independently resumable. Shareable and owner-only
parts have separate private receipts; a repeated public routing note is omitted.
Pending delivery retains its original text only while reconciliation needs it;
settled receipts retain identity, not response text, for 180 days.

Run the deterministic installed transport scenarios with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_workflow_delivery.py -v
```

These install into disposable homes and exercise actual helper CLIs against an
offline HTTP fixture: concurrent different-worded producers, attachments,
partial routed delivery, uncertain sends, private parts, new requests and CI.
The existing PR/approval tests exercise real disposable Git repositories and
preserve negative authority cases.

The submission and watcher regressions use disposable Git repositories and
external GitHub fixtures. They cover main pushes during verification/publication,
owned conflict resolution, failed/running CI, unknown mergeability and isolation
from unrelated/fork work. They do not create real GitHub conflicts.
`test_issue_followup.py` exercises real operation storage with a GitHub adapter:
historical immutability, concurrent/repeated creation, new-request separation,
uncertain success, unknown absence and malformed lineage. No real issues are
created for these tests.

Run the model decision checks with an already configured subscription:

```sh
python3 scripts/check-workflow-model.py --output /tmp/workflow-model.json
```

This uses the source-default lead/worker models and effort levels (currently Terra),
rendered isolated-profile policy and relevant runbooks. No tools, saved session,
project context discovery or extensions are enabled. Runtime configuration
overrides and a full running session's accumulated context are not reproduced.
It is a stateless semantic
contract exercise, not an end-to-end agent run or a productivity benchmark.
Expected actions are independent scenario requirements; model prose is not
matched. The report records prompt and case hashes, actual decisions and errors.
`--source-root PATH` compares another source tree using the same cases.

Instruction edits follow the official OpenAI prompt-engineering and latest-model
guides checked November 6, 2026, including the GPT-6.1 Terra section: clear role and
authority, instructions separate from evidence, conditional procedures,
follow-through within scope, and proportionate verification. The guides are at
`https://developers.openai.com/api/docs/guides/prompt-engineering` and
`https://developers.openai.com/api/docs/guides/latest-model`. No model/provider
migration or universal performance improvement is claimed.
