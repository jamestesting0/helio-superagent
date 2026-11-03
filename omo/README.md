# omo configuration for Helio

`omo.jsonc` is the omo (oh-my-openagent) **project** config for the EloBot
checkout. The installer copies it to `$HELIO_PROJECT/.omo/omo.jsonc`, and every
Helio session starts in that checkout, so the lead and all lanes pick it up.

| Key | Value | Why |
|---|---|---|
| `memory.enabled` | `true` | Helio keeps long-term memory |
| `memory.agent` | `EloBot` | The memory identity Helio shares with the EloBot assistant. `agent/helpers/knowledge-setup.py` refuses to start unless this is set, and links it to `~/.omo/memory/agents/elobot-ec289b4c` |
| `memory.sync.enabled` | `false` | Memory stays local; the repo's `memory/` snapshot is the deliberate export |
| `[native].categories.deep-low` | `chatgpt-subscription/gpt-6.1-terra`, reasoning high | Model for routine delegated work inside a session |
| `[native].categories.deep-high` | `chatgpt-subscription/gpt-6.1-sol`, reasoning high | Model for hard delegated decisions |

## Where each model is chosen

| Session | Set in |
|---|---|
| Helio lead | `HELIO_LEAD_MODEL`, `HELIO_LEAD_THINKING` in `helio.env` |
| Lanes (workers) | `HELIO_WORKER_MODEL` in `helio.env` (becomes `defaultModel` in `config.json`) |
| Allowed providers | `HELIO_MODEL_ALLOW` in `helio.env` (`--models` for every session) |
| Categories inside a session | `omo.jsonc` (this folder) |

Keep everything on OpenAI (`chatgpt-subscription/` or `openai/`): the work
policy forbids other providers.

## Changing it

Edit `omo.jsonc` here. The installer copies it only into a fresh checkout and
`helio update` doesn't overwrite it, so after a change copy it yourself:

```sh
cp omo/omo.jsonc "$HELIO_PROJECT/.omo/omo.jsonc"
```
