# Moving Helio to another laptop

This guide separates the reproducible setup and memory snapshot from private
credentials and live operational state. It does not automatically move or
erase the original installation.

## Before leaving the old laptop

1. Finish or deliberately pause active work. Stop all Helio lead and worker
   sessions and their Discord monitors. Do not start Helio on both laptops at
   once.
2. Inspect pending inbound and learning deliveries with the existing
   `~/.dori/elobot/ack pending inbound` and `~/.dori/elobot/ack pending context`
   commands. Do not acknowledge an item just to clear the queue.
3. Refresh the shared memory snapshot from the Helio repository:

   ```sh
   python3 scripts/memory_snapshot.py export \
     --replace-sha256 "$(sha256sum memory/manifest.json | awk '{print $1}')"
   ```

   `memory/` is gitignored and never pushed: carry it to the new laptop inside
   the encrypted backup below, not through Git.

   This replaces only a validated prior snapshot whose manifest matches the
   supplied hash. It refuses a dirty or uncommitted source when preserving
   HEAD; resolve that deliberately rather than ignoring the warning. Notes are
   readable under `memory/repo/`. The snapshot is private and represents only
   the exported point in time. It contains the existing committed HEAD, not
   earlier Git history. Its checksums detect changes or corruption; they do not
   authenticate who supplied a snapshot.
4. Review the repository contents and history before transferring or publishing
   it. Tokens and other credentials must remain outside Git, even in a private
   repository. Snapshot notes and operating documents may also contain private
   information.
5. If you need credentials, pending work, conversation histories or screenshots,
   make a **separate encrypted backup**. Choose your own encrypted storage and
   keep its recovery key separately. These materials are deliberately excluded
   from this repository.

### State backup precautions

`~/.dori/elobot/state/` contains the Discord cursors, delivery SQLite database,
pending attachments and lane records. Back these up as a coordinated set while
all Helio processes are stopped. SQLite uses WAL mode: a live copy of only the
`.sqlite` file is not a consistent backup. Do not combine a database from one
point in time with cursors or attachments from another.

Pending payloads and lane records may contain absolute paths to the old laptop.
Their transfer to a different home directory is not automatic. Prefer to finish
pending items before migration; otherwise preserve them in the encrypted backup
and reconcile them carefully before resuming. Do not assume active Herdr panes
or Omo processes can be resumed by copying state files.

If you do not restore the operational state, the watcher can establish new
baselines, and its limited catch-up is not a guarantee that old messages will be
recovered. Check for missing work and existing Discord replies before allowing
it to handle new messages. Do not delete cursors or acknowledge messages merely
to suppress a replay.

Session transcripts live under `~/.omo/agent/sessions/`; evidence is under the
working checkout's `.omo/evidence/`. They can contain private material and
are separate from the long-term memory snapshot.

## Prepare the new laptop

Follow [setup.md](setup.md) parts 1-7 (and part 8 for the isolated runtime). If
you kept the old `~/.config/helio/helio.env` in your encrypted backup, copy it
back (mode 600) instead of running `helio_config.py init`. Restore the memory
snapshot (setup.md 7c) into an **absent** omo identity: the restore refuses an
existing identity and restores the snapshot's committed HEAD without creating a
new commit. It creates fresh runtime locks, not the old machine's queues. Do not
overwrite another laptop's existing omo memory. An export made with `--no-head`
needs a separately authorized initial memory commit before omo can project it.

## First start

Confirm the correct Discord bot and access, authorized channels, beta
credentials and database, and Helio Chrome profile. Review the private
approval lists and work policy. If the encrypted operational state was not
restored, explicitly review the potential message gap first.

Start a **new** Helio session (`helio start`, or `~/.dori/elobot/start` inside `herdr --session elobot` without isolation). Existing
session records can retain an old memory binding and cannot prove the new
memory is active. Verify that startup reports the expected shared memory
identity before asking Helio to work. Do not merge, deploy or restart
production as part of this migration check.

If an error or conflict appears, stop and preserve both copies. Do not fix
the migration by deleting an existing memory store, cursor, queue, or
credentials. Restore procedures and live behavior must be tested on the new
laptop; the presence of a snapshot alone does not prove a successful migration.
