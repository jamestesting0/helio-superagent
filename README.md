# Helio

**A Discord-first software operator built on Dori, omo and herdr.**

Turn a community bug report into a clear issue, a tested change and an approved
release, while keeping the conversation, decisions and evidence together.

Helio is the always-on agent for EloBot. It answers questions, investigates
reports, coordinates coding sessions, tests against beta and follows work
through GitHub. People can report a problem without gaining permission to
deploy it. Owners and trusted contributors can authorize work without repeating
the same decision at every step.

This repository packages the operating stack around that agent: Discord
intake, persistent work state, instructions, a maintained Dori fork, installers,
diagnostics and isolated-runtime services.

## What Helio adds to Dori

Dori supplies the always-on lead, herdr lanes and verified-completion protocol.
Helio builds an application and community operations layer around that
foundation:

| Capability | What changes in practice |
|---|---|
| **A shared-server Discord workflow** | Owner, trusted-user, ordinary-member and evidence-only bot roles have distinct scopes. Channel/thread policy, reply context, attachments and burst handling let Helio participate without treating every message as an instruction. |
| **Conversations that finish the right request** | Separate topics retain context. Final answers, progress reports and requester questions have distinct states, so an old bot reply does not leave a completed request waiting or start an inappropriate reminder. |
| **GitHub issues that stay current** | Helio clarifies reports, checks existing work and maintains the issue body as the current scope. Public comments record changes without becoming new instructions to the bot. |
| **Fewer repeated approvals** | An authorized implementation request includes the verified PR. A clearly scoped merge-and-restart request can be one decision. Choices use Discord buttons; custom answers come through ordinary replies. |
| **Native Discord administration** | Direct commands open private panels for status, conversations, lanes, blocks, trust, channels, settings and audit. Current permissions are checked on every action; administration does not wait for the lead model. |
| **Bounded coding sessions** | Worker caps, host guards and a durable priority queue control concurrency. Authenticated engine observations distinguish active work from passive monitors. Eligible idle sessions can release capacity while retaining their checkpoints and unfinished work. |
| **Recovery and long-run upkeep** | Durable delivery, catch-up gaps, reply receipts, startup reconciliation, retention rules, session archives and coordinated backups keep interrupted work inspectable. |
| **Controlled application operations** | The isolated profile separates the agent from host credentials. Beta maintenance and production restart use narrowly scoped services, with conflict checks, protected preimages and approval checks. |
| **Direct operational diagnostics** | `helio doctor --json` exposes versions, queues, monitor processes, recovery and lane failures from either shell. Intake writes its own readiness receipt, tied to its process identity. |

The generic changes made to Dori are recorded in
[`vendor/dori-mode/FORK.md`](vendor/dori-mode/FORK.md). Helio still uses Dori,
omo and herdr; each has a distinct role in the stack.

## From a Discord report to verified delivery

1. **Understand the request.** Read the permitted context, clarify uncertainty
   and distinguish a bug, feature idea or question from action approval.
2. **Establish the facts.** Inspect the running revision and existing
   issues/PRs, then maintain one current issue body.
3. **Authorize the work once.** An owner/trusted implementation request covers
   implementation, verification and its PR. Requested plan mode waits for
   approval before building.
4. **Implement and test.** Run the work in a tracked lane with a concrete Done
   criterion, bounded resources and beta-only test access.
5. **Approve the consequential step.** Merge and production restart stay
   tied to the authorized target and revision.
6. **Verify and report.** Read back the result, update the issue and notify
   the requester in the permitted destination.

Small confirmed bugs can use the bounded standing-autofix path through
`helio autofix check|submit`. Size, path, rate and regression-proof gates apply;
uncertain or larger changes and feature ideas remain reviewable issues until
authorized.

## Built to survive interruptions

Helio preserves unfinished work across restarts and checks current outcomes
before acting on recovered messages.

- Messages are staged before slow enrichment. Reaction and conversation upkeep
  run separately from the delivery queue.
- System events, currently ignored channels and fully unsupported-only input
  settle quietly without strikes, replies or owner reports. Short human
  requests and readable parts of mixed input remain eligible; operational
  failures and accepted work are not silently discarded.
- Catch-up counts eligible messages and records unread gaps when limits cut a
  scan short. Live intake, replay, source reads, replies and reactions share
  current channel boundaries. Unavailable policy evidence withholds work;
  learning retains its separate allowlist.
- Durable reply receipts recover interrupted delivery and local completion.
  Final delivery closes only the covered topic revision after every required
  route succeeds; newer input and explicit holds remain protected. A restart
  does not turn an old request into fresh approval.
- Only an explicit outstanding requester question starts the courtesy timer.
  Durable notice ownership and nonce readback handle concurrent upkeep,
  restarts and Gateway events arriving before the send response. Notices do
  not advance conversation activity, and an unknown send is not blindly retried.
- Owner-managed and automatic blacklist policies retain moderation evidence.
  Durable ping limits bound repeated requests.
- Retention distinguishes raw conversation content, unresolved work and
  idempotency receipts. Session archives retain activity age; cleanup explains
  why a worktree must be kept.
- Housekeeping begins with a preview. An abandoned lane retains its worktree
  and an explicit reason, without announcing that its work was completed.
- Idle-worker reclamation requires authenticated execution and session ownership,
  including on retries after an interrupted terminal close. Missing observations,
  active work, queued input, questions and explicit pauses keep the worker
  protected. Hibernation retains the session, worktree and original job authority;
  it does not claim completion or authorize new work.
- Bounded lifecycle repair previews exact records, then rechecks evidence
  before applying changes through their existing owners. Repeated apply uses
  durable receipts; accepted or changed work is preserved. Historical replies
  and closed issues alone do not prove a mixed topic or live worker is complete.

The regression suites exercise these failure boundaries: interrupted updates,
store reopen/replay, concurrent admission, notice and completion races, failed
wakes, retained open file descriptors, missing installation payloads and stale
readiness evidence. Local receipts do not make Discord and separate databases
one atomic transaction. See the
[startup recovery runbook](agent/runbooks/startup-recovery-workflow.md) for
bounded repair procedures.

The instructions keep authorization and privacy explicit while leaving routine
implementation choices to the agent. Applicable runbooks and passing checks
are reused until relevant evidence changes, rather than becoming repeated
reading, approval or verification steps.

## Clear boundaries for consequential work

The isolated runtime uses a dedicated Linux account, Bubblewrap namespaces and
network restrictions. Host SSH credentials, the production environment and
Windows interop paths are outside that workspace.

Beta runs use `elo_beta`. Protected single-record maintenance stores an actual
BSON preimage and applies a compare-and-set update; that backup service does
not intercept ordinary application database writes. The production restart
broker holds the Oracle SSH credential separately and rechecks live approval,
revision and checkout state. GitHub operations also follow the project's sender,
scope and approval policy.

Diagnostics distinguish observations from guarantees. A live monitor process
does not prove its subscription is unpaused. A readiness receipt or timestamped
Oracle observation does not establish current gateway connectivity. Doctor
reports unprobed dependencies and unknown data explicitly.

See [architecture](docs/architecture.md) and the
[operator guide](docs/operator-guide.md) for the boundaries and procedures.

## Get running

Helio is the EloBot deployment kit. Adapting it to another application requires
its own policy, environment and deployment integration.

The supported host is **Windows with WSL Ubuntu 22.04 and systemd**. Native
Windows execution is unsupported.

| Dependency | Role |
|---|---|
| **omo** | Runs the lead and coding sessions |
| **herdr** | Holds the terminal workspace and lane panes |
| **This repository's Dori fork** | Provides the `dori` CLI and operating contract |
| Bun, Python 3.12, GitHub CLI and Node 24 | Run intake, helpers, GitHub operations and omo integrations |
| Discord bot and BrowserSkill setup | Supply the messaging and browser QA surfaces |

Follow **[the setup guide](docs/setup.md)** for dependencies, configuration,
accounts and isolated-runtime provisioning. Installing the owner prompt files
alone does not provision the isolated runtime.

Everyday settings live in **`~/.config/helio/helio.env`**, generated initially
with `python3 scripts/helio_config.py init`. The
[`helio.env.example`](helio.env.example) template documents the settings.
`helio update` renders installed configuration and prompts; edit the source
configuration rather than generated files.

After provisioning the root services, install the current protected helper
bundle with [`scripts/helio_root_bundle.py`](scripts/helio_root_bundle.py):
preview its changes first, then use `--apply`. Root-owned helpers have a
separate update boundary from routine managed-file deployment.

Once setup is complete:

```sh
helio start                 # foreground lead and workspace

# From another normal WSL terminal:
helio doctor
helio doctor --json
helio version
```

## Everyday operation

| Command | Purpose |
|---|---|
| `helio start` / `helio resume` | Start a new lead or resume the previous session |
| `helio doctor [--json]` | Inspect startup, queues, recovery and work-state warnings from the host or inside Helio |
| `helio version` | Compare source, installed and running revisions, including pending restarts |
| `helio update --preview` / `helio update` | Preview or apply managed updates to the owner installation |
| `helio deploy [--restart]` | Update both installations and report the required reload; optionally restart the lead |
| `helio restart` | Replace the lead while preserving the sandbox, network and lanes |

Inside Helio, the workflow commands cover issues, plans, questions,
conversations, blacklists, housekeeping, health, beta and release inspection.
Start with [day-to-day workflow](docs/workflow.md); use
[the operator guide](docs/operator-guide.md) for details.

### Discord administration

Use `/status`, `/conversations`, `/lanes`, `/blocks`, `/trusted`, `/channels`,
`/timeouts`, `/settings` and `/audit` in the configured server or a bot DM.
Panels use native selectors, autocomplete and confirmation controls. Owner and
trusted-user access follows current policy; trust, channel policy, settings and
abandonment remain owner operations.

The protected controller synchronizes bot-DM and configured-server commands
automatically during startup and updates. It reports those outcomes separately.
Saved settings, deployed payloads and running consumers also have separate
receipts, so a saved value is not presented as active before it is applied.
Initial host activation is explicit; see
[administration setup and operation](docs/helio-admin.md).

### Worker status and recovery

Inside the configured Helio runtime, `dori sync` shows recorded work state
separately from authenticated engine execution. An open terminal or a process
label saying “working” does not establish that a turn is running. A paused goal
with passive monitors remains paused.

Use `dori reclaim KEY` to release an eligible idle worker's slot while retaining
its resumable session and files. The watcher also reclaims eligible idle workers
after the configured idle window or when queued work needs capacity. Unknown
ownership is a refusal, and legacy records need their original session/brief
evidence before adoption. Hibernation is distinct from verified completion or
owner-requested abandonment.

Worker incident reports must name the affected task, unfinished obligation,
current evidence, impact and recommended repair. When a decision is missing,
they must explain the proposed action, retained resources and next check rather
than leave an unexplained blocker “for review.”

Check monitor startup through the linked `dori` executable. Running its source
through Bun can hide a missing executable bit. Managed updates repair this kit's
own linked entrypoint; owner updates and isolated deployment remain separate
from loading changed code into running processes.

## Repository map

| Path | Responsibility |
|---|---|
| [`agent/`](agent/README.md) | Installed prompts, profile overlays, runbooks, launchers and helpers |
| [`discord-inbound/`](discord-inbound/) | Authorization, delivery, replay, conversations, moderation and interactions |
| [`vendor/dori-mode/`](vendor/dori-mode/FORK.md) | Maintained Dori skill and CLI fork |
| `scripts/`, [`isolation/`](isolation/README.md) | Configuration, installation, diagnostics, host boundary and privileged services |
| [`omo/`](omo/README.md) | Configuration installed into the application checkout |
| `tests/` | Offline Python regressions alongside the colocated Bun suites |
| [`docs/`](docs/) | [Setup](docs/setup.md), [workflow](docs/workflow.md), [architecture](docs/architecture.md), [migration](docs/migration.md) and [operation](docs/operator-guide.md) |

Instructions have three main layers: the generic Dori contract, the
lead-only prompt, and the policy shared by lead and workers. Owner/isolated
profile overlays supply the differences. Installer payloads are explicit and
updates check their managed-file baseline.

Credentials, runtime state and the private `memory/` snapshot stay local.
Provision them separately; never include them in a public commit.

## Test the operating boundaries

```sh
PYTHONDONTWRITEBYTECODE=1 ~/PythonProjects/elo-bot/.venv/bin/python -m unittest discover -s tests
(cd discord-inbound && bun test --timeout 60000)
(cd vendor/dori-mode/scripts && bun test)
```

The Python suite needs the project's test dependencies, including `pymongo`.
Installed-helper tests use a throwaway home:

```sh
(
  set -eu
  test_home="$(mktemp -d)"; trap 'rm -rf "$test_home"' EXIT
  test_home="$(cd "$test_home" && pwd -P)"
  mkdir -p "$test_home/.agents/skills"
  cp -R vendor/dori-mode "$test_home/.agents/skills/dori-mode"
  python3 scripts/install.py --profile isolated --home "$test_home" --apply
  HOME="$test_home" bun test "$test_home/.dori/elobot/"{browser-env,thread-target,reply}.test.ts
)
```

Offline tests use disposable state and fixtures. Keep real bot tokens,
production services and live Discord messages out of those suites.
