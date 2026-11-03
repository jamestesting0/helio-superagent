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
| `helio permissions` | where to edit trusted users and report channels |
| `helio-backup list \| verify ID \| export ID` | protected beta preimages |

Inside the isolated workspace (`helio-wsl`): `helio start|resume`, `helio update [--apply]`,
`helio doctor`, `helio browser ready|close`, `helio beta ...`, `helio question ...`,
`helio release inspect`, `helio release-check ...`, `helio triage ...`,
`helio conversation open|close|list`, `helio followups add|check|done|list`, `helio status`.

Running without isolation: `herdr --session elobot`, then `~/.dori/elobot/start` (or `start resume`).

## Change a setting (IDs, people, models, secrets)

1. Edit `~/.config/helio/helio.env`.
2. `helio update --preview` - shows which generated files and prompts change (never values).
3. `helio update`.
4. Restart the lead (close the workspace, `helio start`), because a running
   session keeps the instructions it started with.

Trusted users, report channels and release approvers are copied into the
sandbox's read-only mounts on every isolated launch, so step 4 is what makes
them take effect there.

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

The isolated home has its own copy of this repo. After `helio update` works on
the owner side:

```sh
sudo rsync -a --delete --exclude .git --exclude memory/ \
  ~/PythonProjects/helio-superagent/ /var/lib/helio-agent/home/helio-agent/
sudo chown -R helio-agent:helio-agent /var/lib/helio-agent/home/helio-agent
helio                         # open the workspace
helio update                  # preview inside the sandbox
helio update --apply
helio start
```

Root-owned pieces (`/opt/helio-beta-service/scripts`, `isolation/systemd`) are
not updated by either `helio update`; reinstall them as in setup.md part 8 when
those files change.

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
