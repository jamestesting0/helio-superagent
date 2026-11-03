# Helio

Helio is the EloBot Dori: an always-on agent you talk to on Discord. It
answers questions about EloBot, turns staff bug reports into GitHub issues,
runs coding work in its own omo sessions ("lanes") in herdr, tests changes on
the beta bot, and only merges or restarts production with explicit
confirmation.

This repository is everything needed to rebuild and update Helio: its
instructions, Discord intake, launchers, the forked Dori skill, the omo
configuration and the isolated-runtime services. Secrets live only in
`~/.config/helio/helio.env`, and the memory snapshot (`memory/`) stays on your
machine; both are gitignored. Never commit either.

## Quick start

On a fresh Windows laptop, follow **[docs/setup.md](docs/setup.md)**. The short
version, once WSL, Bun, omo, herdr and the Dori CLI are installed:

```sh
cd ~/PythonProjects/helio-superagent
python3 scripts/helio_config.py init         # creates ~/.config/helio/helio.env
nano ~/.config/helio/helio.env               # fill in the secrets
python3 scripts/install.py --profile owner --apply
install -m 700 scripts/helio-host ~/.local/bin/helio
helio start
```

Everyday use: **[docs/workflow.md](docs/workflow.md)**. Edit, then
`helio update --preview`, `helio update` and `helio start`.

## Configuration: one file

All settings live in **`~/.config/helio/helio.env`** (template:
[`helio.env.example`](helio.env.example)): the Discord token, channel and
people IDs, the EloBot checkout path, models and beta credentials. `helio update`
generates everything else from it (`~/.dori/elobot/env`, `beta.env`,
`beta-mongo.env`, `trusted-users`, `report-channels`, `release-approvers`,
`config.json`, and the IDs inside the prompts). Don't edit the generated
files by hand.

## Layout

| Path | What it is |
|---|---|
| [`helio.env.example`](helio.env.example) | The configuration template, every setting explained |
| [`agent/`](agent/README.md) | What gets installed into `~/.dori/elobot`: prompts, profile overlays, runbooks, launchers, helpers, config template |
| [`vendor/dori-mode/`](vendor/dori-mode/FORK.md) | The Dori skill and `dori` CLI, forked for Helio (`FORK.md` lists every change) |
| [`omo/`](omo/README.md) | omo project config for the EloBot checkout: memory agent and category models |
| [`discord-inbound/`](discord-inbound/AGENTS.md) | Discord watcher: filtering, authorization, catch-up, durable delivery |
| [`isolation/`](isolation/README.md) | Root services and host helpers for the isolated runtime |
| `elobot-checkout/` | `AGENTS.md` and docs copied into the EloBot checkout |
| `scripts/` | Installer, updater, config renderer, beta/release brokers, launchers |
| `tests/` | Offline tests (no Discord, no production) |
| `memory/` | Local-only snapshot of the shared EloBot omo memory (gitignored; never pushed) |
| [`docs/`](docs/) | [setup](docs/setup.md), [workflow](docs/workflow.md), [architecture](docs/architecture.md), [migration](docs/migration.md), [operator guide](docs/operator-guide.md) |

## How the instructions fit together

Helio's behaviour comes from three layers, each rule in exactly one place:

1. **Dori skill** (`vendor/dori-mode/SKILL.md`): how any Dori works, including
   lanes, the done protocol, writing style and standing rules. It's forked so
   deployments can add sender roles, relevance rules and authorization gates
   without contradicting it.
2. **Lead prompt** (`agent/prompts/lead.md`, installed as `setup-prompt.md`):
   Helio-only runtime for the lead session, covering monitors, inbound roles,
   acknowledgement, replies, attachments and learning.
3. **Work policy** (`agent/prompts/policy.md`, installed as `work-policy.md`):
   rules the lead and every worker share, covering authority, the release
   check, beta QA, evidence and questions.

Each installed prompt also gets a short **profile overlay**
(`agent/profiles/owner|isolated/`) for the few things that differ between your
normal account and the isolated runtime, such as Oracle access and beta
maintenance.

## Tests

```sh
~/PythonProjects/elo-bot/.venv/bin/python -m unittest discover -s tests   # needs pymongo for the beta tests
(cd discord-inbound && bun test)
(cd vendor/dori-mode/scripts && bun test)
```

Installed-helper tests run against a throwaway home:

```sh
(
  set -eu
  test_home="$(mktemp -d)"; trap 'rm -rf "$test_home"' EXIT
  test_home="$(cd "$test_home" && pwd -P)"
  mkdir -p "$test_home/.agents/skills" && cp -R vendor/dori-mode "$test_home/.agents/skills/dori-mode"
  python3 scripts/install.py --home "$test_home" --apply
  HOME="$test_home" bun test "$test_home/.dori/elobot/"{browser-env,thread-target,reply}.test.ts
)
```

Never use a real bot token, production service or live Discord message in a test.
