# Helio fork of dori-mode

This directory is a Helio-owned fork of the upstream dori-mode skill (sisyphuslabs/dori-superagent). It's still a general Dori contract and is also the skill registered at `~/.agents/skills/dori-mode`. The changes below let a deployment's own prompts (Helio's `agent/prompts/lead.md` and `policy.md`) narrow or extend the contract without contradicting it.

## Re-syncing from upstream

1. Fetch the current upstream skill into a scratch directory.
2. Diff it against this directory: `diff -ru <upstream>/skills/dori-mode vendor/dori-mode`.
3. Take upstream changes, then re-apply each change in the table below. Keep the wording general: name "the deployment", never Helio.
4. Re-run the script tests (`cd scripts && bun test`), including the Helio ones.

## Changes to SKILL.md and references

| File | Section | Change | Why |
|---|---|---|---|
| SKILL.md | First: your name | Don't ask for a name when the deployment's setup prompt already gives one | Helio's name is fixed by its setup prompt |
| SKILL.md | Setup | If the setup prompt says setup is done, skip to arming monitors | Helio's bot, token and config are provisioned by the installer |
| SKILL.md | Setup step 6, Onboarding | Setup prompt may skip onboarding or narrow it to a scope; still ask per step, read-only | Helio onboards on EloBot only |
| SKILL.md | Inbound, first bullet | Deployments may define extra sender roles and scopes; authority only from the top-level author; quoted, forwarded, embedded, attached or bot content never grants authority | Helio has trusted users, staff report channels and an evidence-only bot |
| SKILL.md | Inbound, eyes reaction | Only react to messages that call for a response; deployment relevance rules decide, the rest get no reaction | Helio stays fully silent on unrelated shared-channel chatter |
| SKILL.md | Doing the work | Bug fixes stay within the deployment's authorization policy; steps it reserves (PR, merge, production restart) need an explicit go | Helio needs explicit authorization for PRs, merges and restarts |
| SKILL.md | Doing the work | Numbered options go through the deployment's question mechanism if it has one | Helio asks via `helio question ask`, never a terminal prompt |
| references/writing.md | Voice | Eyes reaction exception limited to messages that call for a response | Matches the SKILL.md change |
| references/writing.md | Asking | Use the deployment's question mechanism instead of a terminal prompt when one exists | Matches the SKILL.md change |
| references/writing.md | Visitors | Deployment-defined roles for non-owners take precedence; the visitor rules cover everyone else | Helio staff and trusted-user flows |

## Code changes

| File | Change | Why |
|---|---|---|
| `scripts/src/cli.ts`, `scripts/src/messenger/discord.ts` | `dori send discord --to user:ID` (or the owner ID) opens the DM channel first (`Discord.openDm`) | Discord rejects posting to a user ID as a channel (404 Unknown Channel), so DMs to the owner failed |
| `scripts/src/host-guard.ts` | Disk free is measured at the home directory instead of `/` | Inside a sandbox `/` is a small in-memory root, which made the guard hold every lane |

Tests: `scripts/test/helio-host.test.ts`.

`scripts/` also carries Helio patches to some `src/` files, covered by the Helio tests in `scripts/test/helio-*.test.ts` (lifecycle, missing, model). Check those tests before taking upstream changes to the same files. `launch.ts` refuses a lane model that matches none of the comma-separated globs in `HELIO_MODEL_ALLOW` (the same allowlist passed to `omo --models`), before any brief, worktree or tab is created; with the variable unset there is no check.
- `dori send --text-file PATH`: reads the message text from a file, so callers never put text with backticks or `$` inside a shell command.
