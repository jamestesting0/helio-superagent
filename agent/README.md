# agent/: what gets installed into ~/.dori/elobot

| Source | Installed as | Notes |
|---|---|---|
| `prompts/lead.md` + `profiles/<profile>/lead.md` | `setup-prompt.md` | Lead session only |
| `prompts/policy.md` + `profiles/<profile>/policy.md` | `work-policy.md` | Lead and every lane |
| `runbooks/discord-qa-workflow.md` | `docs/discord-qa-workflow.md` | Shared |
| `profiles/<profile>/runbooks/*.md` | `docs/beta-maintenance-workflow.md`, `docs/oracle-restart-workflow.md` | Differ per profile |
| `runbooks/README.md` | `docs/README.md` | Fresh install only |
| `bin/start`, `inbound`, `ack`, `context` | same names, mode 700 | Read everything from `~/.dori/elobot/env` |
| `helpers/*` | same names | `reply.ts`, `thread-target.ts`, `browser-env`, `knowledge-setup.py`, `helio-sessions.py` and tests |
| `config.template.json` | `config.json` | Dori config; `{{...}}` filled from `helio.env` |

`<profile>` is `owner` (your WSL account) or `isolated` (the sandboxed
`helio-agent` home). It's chosen at install time and recorded in
`~/.dori/elobot/.sync-manifest.json`.

`{{NAME}}` placeholders in prompts, runbooks and the config template are filled
from `helio.env` at install and update. An unknown name stops the install. The
list of names is in `helio.env.example`, plus `{{HOME}}`.

Also installed, from outside this folder: `vendor/dori-mode` messenger modules
into `~/.dori/elobot/vendor/` (imported by `reply.ts`), `discord-inbound/` into
`~/.dori/discord-inbound/`, and `elobot-checkout/docs` into `project-docs/`.
The file lists live in `scripts/helio_payload.py`.
