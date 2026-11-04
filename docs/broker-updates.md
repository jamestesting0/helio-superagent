# Updating the installed root brokers

The source kit, owner installation, isolated kit and root broker bundle are separate. A normal `helio deploy` updates both agent profiles but does not update `/opt/helio-beta-service/scripts`.

From the owner WSL shell, preview:

```sh
/mnt/c/Windows/System32/wsl.exe -d Ubuntu-22.04 -u root -- python3 /home/james/PythonProjects/helio-superagent/scripts/helio_root_bundle.py
```

After reviewing the source changes, run the same command with `--apply`. It saves changed installed files under `/var/lib/helio-agent-backups/brokers/`, installs the explicit dependency bundle and the two broker service units, records every file digest, reloads systemd when a unit changes and restarts only affected local broker services. It never restarts Oracle EloBot or the isolated workspace. A root update must finish before deploying an admin script that depends on a new root helper.

Then run `bash scripts/helio-host deploy --restart` from the source checkout. This baseline-checks generated updates in both homes, preserves unmanaged local edits and restarts the Helio lead if required. Do not hand-edit generated `~/.dori/elobot` prompts/config or replace the host isolation launcher as a routine update.

Check the root bundle again: `changed` must be empty. From the isolated runtime run `helio release inspect`; retain its `broker_version`, observed timestamp, phase, invocation, checkout and running-revision evidence. A login observed in that invocation is historical evidence, not a current gateway health check.

The sandbox binds each broker's runtime directory read-only, rather than pinning
the socket inode. The service units preserve these directories across stops and
remove their own socket after exit. This lets a running sandbox see a replacement
socket after a broker restart. When upgrading an older socket-file mount, a lead
restart alone cannot repair it: stop the isolated workspace and start it again
with the updated root launcher. Existing lane state remains on disk.

After that one-time workspace restart, verify `helio release status`, restart
only the local `helio-release.service`, and verify `helio release status` again
from the same isolated workspace. Both inspections must succeed; the workspace
must remain running. This checks socket replacement visibility without restarting
production EloBot.

Before a deploy the admin snapshots runtime state as the agent user. SQLite databases use the SQLite backup API, including committed WAL data, rather than copying live database files. The resulting deploy archive includes that snapshot and its manifest. Databases are individually consistent; unrelated live JSON and multiple databases do not form one global transaction.

Restore rehearsal must target a fresh temporary directory: extract only the saved state there, verify manifest SHA256 values, run `PRAGMA integrity_check` on each SQLite database and inspect pending queues/decision history. Never overwrite active runtime state to rehearse recovery. Review code and state compatibility separately before a real rollback; replaying old state can repeat completed external actions.
