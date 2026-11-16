# Helio

**A Discord-first software operator for EloBot, built on Dori, omo and herdr.**

Helio turns a community bug report into a clear issue, a tested change and an
approved release, and keeps the conversation, decisions and evidence together.
It answers questions, investigates reports, coordinates coding sessions, tests
against beta and follows the work through GitHub. Anyone can report a problem;
only owners and trusted contributors can authorize work.

This repository is the deployment kit for Helio: Discord intake, persistent work
state, agent instructions, a maintained [Dori fork](vendor/dori-mode/FORK.md),
installers, diagnostics and services for the isolated runtime.

## Highlights

- **Role-aware Discord intake.** Owner, trusted, member and bot roles have
  separate scopes. Channel policy, reply context, attachments and message
  bursts are handled so that ordinary chat is not treated as an instruction.
- **Report to release in one flow.** Helio keeps one up-to-date issue per
  request, implements it in a tracked lane, verifies it on beta and opens the
  PR. Merging and restarting production require approval tied to the exact
  revision.
- **Fewer repeated approvals.** One authorized request covers implementation,
  verification and the PR. Choices are offered as Discord buttons.
- **Native Discord administration.** Slash commands such as `/status`, `/lanes`,
  `/trusted` and `/settings` open private panels, and permissions are
  rechecked on every action.
- **Bounded concurrency.** Worker caps, a durable priority queue and
  authenticated execution checks limit how many sessions run. Idle workers
  can release their slot without losing their session or files.
- **Built to survive interruptions.** Durable delivery, catch-up for missed
  messages, reply receipts and startup reconciliation preserve unfinished
  work. A restart never turns an old request into a new approval.
- **Isolated runtime.** Helio runs under a dedicated Linux account with
  Bubblewrap namespaces and network restrictions. Beta maintenance and
  production restarts go through narrowly scoped services that hold the
  credentials, so the agent never has them.
- **Diagnostics that separate observation from proof.** `helio doctor --json`
  reports versions, queues, monitors, recovery state and dependencies it could
  not check.

## How it works

1. **Understand.** Read the permitted context and tell a bug report, feature
   idea or question apart from an approval to act.
2. **Establish facts.** Check the running revision and existing issues and PRs,
   then keep one current issue body.
3. **Implement.** Work in a tracked herdr lane with a concrete done criterion
   and beta-only test access.
4. **Approve.** Merge and production restart stay bound to the authorized
   target and revision.
5. **Verify and report.** Read back the result, update the issue and notify the
   requester.

Small confirmed bugs can go through a gated standing-autofix path
(`helio autofix`), which limits change size, paths and frequency and requires
proof of the fix.

## Quick start

Supported host: **Windows with WSL Ubuntu 22.04 (systemd enabled)**. Requires
omo, herdr, Bun, Python 3.12, Node 24, the GitHub CLI and a Discord bot.

```sh
python3 scripts/helio_config.py init   # create ~/.config/helio/helio.env
python3 scripts/install.py             # preview the installation, then add --apply
helio start                            # start the lead and workspace
helio doctor                           # check health from another terminal
```

The [setup guide](docs/setup.md) covers accounts, provisioning the isolated
runtime and the root helper bundle. All settings are in
`~/.config/helio/helio.env` (see [`helio.env.example`](helio.env.example)).

| Command | Purpose |
|---|---|
| `helio start` / `helio resume` | Start a new lead or resume the last one |
| `helio doctor [--json]` | Inspect startup, queues, recovery and work state |
| `helio version` | Compare source, installed and running revisions |
| `helio update [--preview]` | Apply managed updates to the owner installation |
| `helio deploy [--restart]` | Update both installations, then optionally restart |
| `helio restart` | Replace the lead and keep the sandbox and lanes |

## Documentation

| Guide | Covers |
|---|---|
| [Setup](docs/setup.md) | Dependencies, configuration and isolated runtime |
| [Workflow](docs/workflow.md) | Day-to-day use inside Helio |
| [Operator guide](docs/operator-guide.md) | Procedures, workers and recovery |
| [Administration](docs/helio-admin.md) | Discord slash commands and panels |
| [Architecture](docs/architecture.md) | Components and trust boundaries |
| [Startup recovery](agent/runbooks/startup-recovery-workflow.md) | Bounded repair after interruptions |
| [Migration](docs/migration.md) | Memory snapshot export and restore |

## Repository layout

| Path | Contents |
|---|---|
| [`agent/`](agent/README.md) | Prompts, profile overlays, runbooks, launchers and helpers |
| [`discord-inbound/`](discord-inbound/) | Intake, authorization, delivery, replay and interactions |
| [`vendor/dori-mode/`](vendor/dori-mode/FORK.md) | Maintained Dori skill and CLI fork |
| `scripts/`, [`isolation/`](isolation/README.md) | Configuration, install, diagnostics and privileged services |
| [`omo/`](omo/README.md) | Configuration installed into the EloBot checkout |
| `tests/` | Offline Python regression tests |

## Testing

```sh
PYTHONDONTWRITEBYTECODE=1 ~/PythonProjects/elo-bot/.venv/bin/python -m unittest discover -s tests
(cd discord-inbound && bun test --timeout 60000)
(cd vendor/dori-mode/scripts && bun test)
```

<details>
<summary>Installed-helper tests (disposable home)</summary>

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

</details>

Offline suites use disposable state and never touch live Discord or production
services.

Credentials, runtime state and the private `memory/` snapshot stay local and
must never be committed.
