# isolation/: the hardened runtime's host pieces

Copied from the running setup on 2026-11-03. They contain no secrets.

| File | Installed at | Purpose |
|---|---|---|
| `systemd/helio-beta-maintenance.service` | `/etc/systemd/system/` | Protected beta service (user `helio-vault`): exact-record maintenance with BSON preimages |
| `systemd/helio-release.service` | `/etc/systemd/system/` | Oracle release broker (user `helio-release`): read-only inspection and confirmation-gated restart |
| `bin/helio-backup` | `~/.local/bin/` | Owner command to list, verify and export protected beta preimages |
| `bin/helio-chrome` | `~/.local/bin/` | Starts the dedicated Helio Chrome profile |

The service code itself is in `scripts/` (`helio_beta_service.py`,
`helio_release_service.py`, `helio_isolated_launcher.py`, ...) and is installed
to `/opt/helio-beta-service/scripts/`. Setup steps: `docs/setup.md` part 8.
Design and limits: `docs/architecture.md`.

`helio update` never touches any of these. Reinstall them by hand with `sudo`
when they change.
