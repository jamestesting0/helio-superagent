# Working with Helio day to day

## The three copies

| Copy | Where | Who edits it |
|---|---|---|
| Source (this repo) | `~/PythonProjects/helio-superagent` | you, in the normal WSL shell |
| Owner install | `~/.dori/elobot`, `~/.dori/discord-inbound` | `helio update` only |
| Isolated install | `/var/lib/helio-agent/home` (seen as `/home/james` inside the sandbox) | `helio update` inside the workspace |

Editing the repo changes neither install until you run `helio update`, and the
owner install never reaches the isolated one by itself.

## Commands

Normal WSL shell (the host `helio`):

| Command | Does |
|---|---|
| `helio start` / `helio resume` | open the isolated workspace and start a new / the latest lead |
| `helio` | open the isolated workspace without starting the lead |
| `helio --check`, `helio status` | sandbox self-check; service status |
| `helio update --preview`, `helio update` | regenerate files from `helio.env`, then preview/apply managed-file updates to the owner install |
| `helio deploy [--restart]` | `helio update`, then the isolated install; says what the change needs (nothing, monitors restart themselves, `helio restart`, or a full start). `--restart` also restarts the lead when needed |
| `helio restart` | replace only the lead session; sandbox, lanes and beta keep running |
| `helio version` | repo commit vs installed and running versions, and any pending restart |
| `helio doctor [--json]` | read-only startup snapshot: live process evidence, queues, failed lanes with causes, recovery, health and timestamped Oracle observations |
| `helio permissions` | where to edit trusted users and report channels |
| `helio-backup list \| verify ID \| export ID` | protected beta preimages |

Inside the isolated workspace (`helio-wsl`): `helio start|resume`, `helio update [--apply]`,
`helio doctor`, `helio browser ready|close`, `helio beta ...`, `helio question ...`,
`helio pr check --number N` (read-only current-main/CI/mergeability inspection),
`helio release inspect`, `helio release-check ...`, `helio triage ...`,
`helio conversation list|show|open|set|join|leave|merge|close`, `helio followups check|deliver|list|show`, `helio status`,
`helio blacklist ...`, `helio housekeeping [--dry-run|--last]`, `helio health [--json]`.
These last three run inside the isolated workspace (or owner installation), not through the host launcher.

Live beta browser work uses `helio browser ready`, which defaults to qa-a.
Use `helio browser ready --accounts 2` or `--accounts 3` for multiple supplied
accounts. The helper uses Wayland in the isolated WSL runtime; do not launch
Chrome directly or fall back to the legacy Helio profile. Bind BrowserSkill
sessions to the verified QA instance/account map and close only profiles opened
by the task. See the installed `docs/discord-qa-workflow.md` for setup and cleanup.

`helio doctor --json` is the first check when a greeting reports incomplete
readiness. It works from either shell and does not start or repair anything.
An old failed lane is a work-state warning, separate from receiving new requests.
The report supplies inspection commands; it never acknowledges a question,
retires a lane or grants an approval. Missing or unreadable data is unknown,
not an empty queue. Monitor entries describe live processes, not subscription
pause state or a guarantee of current Discord connectivity. Intake readiness
is read from its atomic receipt and matched to its namespace PID and process
start ticks; old receipts and copied chat notifications cannot establish readiness. Browser and beta
are explicitly unprobed; run their inspection commands inside Helio when needed.
The host route needs the current owner-installed root bundle
(`scripts/helio_root_bundle.py`); routine deployment does not replace it.

Running without isolation: `herdr --session elobot`, then `~/.dori/elobot/start` (or `start resume`).

## Change a setting (IDs, people, models, secrets)

1. Edit `~/.config/helio/helio.env`.
2. `helio update --preview` - shows which generated files and prompts change (never values).
3. `helio update`.
4. `helio deploy`, then `helio restart`: a running session keeps the settings
   and instructions it started with.

Trusted users, report channels and release approvers are copied into the
sandbox's read-only mounts by every deploy and every launch.

## Change Helio's instructions or code

| To change | Edit |
|---|---|
| Rules for the lead only (inbound, acks, monitors, replies) | `agent/prompts/lead.md` |
| Rules for lead and workers (authority, release check, QA, evidence) | `agent/prompts/policy.md` |
| Something that differs between owner and isolated | `agent/profiles/<profile>/lead.md` or `policy.md` |
| Generic Dori behaviour | `vendor/dori-mode/SKILL.md`, and record it in `vendor/dori-mode/FORK.md` |
| Runbooks | `agent/runbooks/` (shared) or `agent/profiles/<profile>/runbooks/` |
| Launchers and helpers | `agent/bin/`, `agent/helpers/` |
| Discord intake | `discord-inbound/` |
| omo categories and memory agent | `omo/omo.jsonc` (see `omo/README.md`) |

Use `{{NAME}}` for any ID or path that lives in `helio.env` (for example
`{{HELIO_TEST_CHANNEL}}`, `{{HELIO_PROJECT}}`); the installer fills it in. Then:

```sh
~/PythonProjects/elo-bot/.venv/bin/python -m unittest discover -s tests   # offline checks
helio update --preview && helio update
```

`helio update` refuses to overwrite a managed file that was edited in place;
move that edit into the repo, or revert it, and run again.

## Deploy to the isolated runtime

From the normal WSL shell, Helio running or not:

```sh
helio deploy            # updates your install, then the isolated one, and reports what is needed
helio restart           # only if it says the lead needs a restart
helio version           # what is installed and running
```

`helio deploy` backs up the isolated install first (the last 3 are kept in
`/var/lib/helio-agent-backups/deploys`), copies this repo in, refreshes the env
and permission files, and applies the managed update offline. Docs, tests and
per-call tools are live at once; the inbound, learning, question and follow-up
monitors notice new code within a minute and restart themselves; instruction,
setting or Dori changes need `helio restart`; launcher or sandbox changes need
a full stop and `helio start`. It never restarts the lead unless you pass
`--restart`.

Root-owned pieces (`/opt/helio-beta-service/scripts`, `isolation/systemd`) are
not updated by `helio deploy`; reinstall them as in setup.md part 8 when those
files change.

## One-time migration of an existing install to this layout

For a laptop that ran the pre-reorganization kit (`~/.dori/elobot/env`,
`channel-policy.env`, `GUIDE.md` exist):

```sh
cd ~/PythonProjects/helio-superagent
python3 scripts/helio_config.py init --from-installed   # builds helio.env from the live files
python3 scripts/helio_config.py check
python3 scripts/sync-install.py --profile owner          # preview: owner profile, one time
python3 scripts/sync-install.py --profile owner --apply
helio update --preview                                   # from now on, the normal command
```

`init --from-installed` uses the same precedence the old wrappers did
(`channel-policy.env` over `env`). The owner profile is recorded on the first
apply; `GUIDE.md` and `channel-policy.env` are removed because nothing reads
them any more.

The isolated runtime has no `helio.env` of its own: the launcher copies the
owner's generated `env` into it on every launch. So migrate the owner side
first, then deploy (above) and run `helio update --profile isolated --apply`
inside the workspace once.
