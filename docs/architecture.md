# Helio architecture

## Moving parts

```text
~/.config/helio/helio.env --(helio update)--> ~/.dori/elobot/{env,beta.env,...}   owner install
repo (agent/, discord-inbound/, vendor/) --(helio update)--> ~/.dori/elobot, ~/.dori/discord-inbound
owner ~/.dori/elobot/{env,beta*.env,trusted-users,...} --(launcher, every start)--> isolated home + read-only mounts
repo --(sudo rsync, then helio update inside)--> /var/lib/helio-agent/home (isolated install)
```

- **Lead**: one omo session in herdr (`start`), loaded with the Dori skill,
  `setup-prompt.md` and `work-policy.md`. It runs the monitors (`inbound`,
  `context`, `helio question watch`, `helio followups watch`, `dori watch/dead-panes/guard/freshness`).
- **Lanes**: omo sessions launched by `dori launch` using `config.json`'s
  `agentCommand`, loaded with `work-policy.md`.
- **Discord intake**: `discord-inbound/` classifies each message (role, scope,
  channel policy), stores it durably, and prints `INBOUND` lines for the lead.
- **Profiles**: `owner` runs as your WSL user; `isolated` runs as `helio-agent`
  in the sandbox below. They share all rules except the overlay in `agent/profiles/`.

## Read-only code inside the sandbox

Inside the isolated runtime `~/helio-agent`, `~/.dori/elobot` (including `config.json` and its hooks) and
`~/.dori/discord-inbound` are read-only bind mounts; only `~/.dori/elobot/state` and `~/.dori/elobot/backups`
are writable there. Helio therefore cannot edit the code and instructions that constrain it. `helio deploy`
runs on the host, outside these mounts, and is the only writer of those directories; `helio update --apply`
inside the sandbox refuses. Runtime records live under `state/`: the lead's pane (`lead-pane`) and start receipt
(`lead-start.json`), and the full-start receipt (`full-start.json`). `deploy-state.json` is written only by the
deploy; readers derive pending restarts by comparing it with those receipts. `~/.local/bin/helio` stays
replaceable (a single file the updater replaces atomically), and bubblewrap 0.6.1 cannot forbid nested user
namespaces, so this protects against ordinary edits, not a determined adversary. The mounts take effect at
the next full start after the root bundle is reinstalled.

## Beta isolation and recovery

The installed WSL launcher starts a dedicated `helio-agent` UID inside a Bubblewrap user, mount, PID and network namespace. Herdr, the lead, workers, BrowserSkill and Chrome are launched within that boundary. A UID-scoped firewall blocks the host's local and private addresses and IPv6 while permitting public outbound IPv4; `slirp4netns` also blocks the host loopback gateway. The original project `.env`, SSH directory, Windows interop paths, host Herdr socket and protected service credentials are not mounted. The dedicated Wayland socket supports the private Chrome profile. The physical checkout and Helio memory under `/var/lib/helio-agent/home` are separate copies; they do not automatically synchronize with the owner's original WSL checkout.

`helio-beta-maintenance.service` runs as `helio-vault` with an Atlas credential whose effective privileges are limited to `elo_beta`. Only the `helio-agent` UID in the root-managed `helio-isolated.scope` can use its socket. It rechecks privileges on requests, refuses records on the root-owned exclusion list (currently empty: no beta record is protected), stores a complete actual BSON preimage in `/var/lib/helio-beta-service/archive`, and applies an exact-ID whole-document atomic compare-and-set. Archives are inaccessible to the agent UID. Conflicts and uncertain results must not be blindly retried. The owner can list, verify and export a BSON preimage with `helio-backup`; restoration remains a separate, conflict-aware owner operation.

The agent has the restricted beta credential for running the beta application. Therefore the backup service protects operations submitted through `helio beta apply`; it does not technically intercept ordinary application writes or a direct PyMongo write. Helio uses `helio beta apply` for single-record edits so they keep a backup, and direct PyMongo writes with the beta credential for larger changes; both are limited to `elo_beta` by the credential itself.

`helio-release.service` holds the Oracle SSH key under a separate UID. Its narrow broker accepts read-only inspection and a single restart after verifying a fresh live Discord confirmation, owner/trusted sender, scope, revision, checkout and service state. The known untracked pip cache is tolerated only if all untracked changes are beneath `.cache/pip/` and the cache contains no symlinks. Other untracked or tracked changes stop the restart. The updater follows `main`, so a concurrent push can race the recheck; compare the resulting revision. Other Oracle shell operations are not available to the isolated agent. GitHub PR action limits remain agent policy rather than a separate GitHub authorization broker.

The isolated checkout, browser profile, memory and session history were copied from the original setup. `helio start` and `helio resume` launch into this isolated runtime; `helio --check` checks basic startup. The owner-managed trusted-user and report-channel lists are copied into read-only mounts on launch. `helio update` inside the workspace updates managed Helio files; it does not install updates to the root-owned services or isolation launcher.

Verification included an actual OpenAI request, GitHub and Discord authentication, BrowserSkill extension connection, session discovery, a Herdr worker, host-listener and Windows-interop probes, real scoped MongoDB synthetic updates with a stored preimage, a concurrent-write conflict, protected record and peer rejection, backup export/integrity tests, and read-only Oracle inspection. The synthetic fixtures were deleted; the empty `helio_broker_verification` collection and synthetic backup archives remain. A full Helio lead/monitor startup, a real beta bot startup against existing state, account login after profile copying, and an actual production restart were not performed in this verification.

## Buttons and click proof

Confirmations, plan approvals and question menus use Discord buttons, menus and forms
(`discord-inbound/interactive/`). The intake watcher answers each click itself, records it in
`discord-prompts.sqlite`, and only then reports `INBOUND_CONFIRM` to the lead. A restart is approved by a
button result message that Discord marks with the clicker and the clicked prompt (`interaction_metadata`);
the release broker re-reads both messages and checks the clicker, wording, timing and single use.
Discord does not record which button was pressed, so the prompt and result wording carry that part: a
sandbox that holds the bot token could present a Cancel click as a confirmation, but only for a real click
by an approver on that exact prompt within 15 minutes. Typed approvals avoid this limit and remain valid.
