# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-02
**Commit:** e2f2c75
**Branch:** main

## OVERVIEW
Discord bot for Clash of Clans capital Elo matches, base storage, tournaments,
predictions, and tokens. Python 3.12, interactions.py, coc.py, Beanie/PyMongo,
and a separate PyTorch/Ultralytics base-fingerprint worker.

## STRUCTURE
```text
EloBot-dori/
|-- main.py / beta.py        # parallel deployment entry points
|-- watchdog.py             # child-process supervisor
|-- cogs/                   # *_commands.py extensions and hosting adapters
|-- common/                 # shared domain operations and Discord utilities
|-- database_models/        # document schemas, state deltas, persistence types
|-- tests/                  # unittest cases and reusable fake boundaries
|   `-- integration/        # disposable MongoDB integration gate
|-- scripts/                # model installation and fingerprint evaluation
|-- models/base_finder/     # pinned binary model, not application source
`-- assets/                 # bot-facing help and rules content
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Startup, error dispatch, index registration | `main.py`, `beta.py` | Check both entry points |
| Slash commands and component routing | `cogs/*_commands.py` | Loaded by suffix, not recursive package discovery |
| Base submission and image acquisition | `cogs/base_commands.py`, `cogs/_base_screenshots.py`, `cogs/base_submission/` | Separate from storage reservations |
| War/Helper hosting | `cogs/war_hosting/` | Typed external job boundary |
| Live match starts | `cogs/live_hosting/` | Two-side and clan reservations |
| Stored base lifecycle | `cogs/base_store/`, `common/base_store/` | Preparation, publication, release, legacy messages |
| Match publication and recovery | `common/matches/` | Persisted message identities and replay |
| Result recording | `common/results/` | Validation and operation boundaries |
| Finals and tournament UI | `common/finals/`, `cogs/final_commands.py` | Transactional results and resumable recovery |
| Tokens and betting | `common/tokens/`, `database_models/token_models.py` | Wallets, ledger, market settlement |
| Base recognition/search | `common/base_fingerprints/` | Worker protocol, extraction jobs, geometry |
| Shared Discord behavior | `common/discord/`, `common/utils.py` | Editing, locks, pagination, display links |
| Tests and CI requirements | `tests/`, `.github/workflows/python-tests.yml` | Unit and replica-set jobs are separate |
| Existing local UI/copy guides | `docs/README.md`, `docs/copy-style.md` | Ignored local docs; historical QA is not current evidence |

## CODE MAP
AST import/definition mapping was available; LSP document symbols failed.
Reference centrality is unmeasured, not a count inferred from file names.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `get_extensions` | function | `common/utils.py` | unmeasured | Discovers top-level command extensions |
| `Match` | document | `database_models/match_models.py` | unmeasured | Match slots, format, storage and publication state |
| `FingerprintService` | service | `common/base_fingerprints/service.py` | unmeasured | Extraction orchestration and worker lifetime |
| `MatchMessageState` | dataclass | `common/matches/messages.py` | unmeasured | Captures publication identity before awaits |
| `transaction` | async function | `common/finals/persistence.py` | unmeasured | Snapshot/majority transaction boundary |
| `BaseStoreRuntime` | protocol | `cogs/base_store/models.py` | unmeasured | Storage adapter contract |

## CONVENTIONS
- `get_extensions("cogs")` loads only non-private top-level `*_commands.py`.
- Hosting subpackages are helpers, not independently discovered extensions.
- Python 3.12 syntax is intentional: `type` aliases and generic functions occur.
- `common.constants` is widely wildcard-imported; do not mistake injected names
  such as `ipy` for missing imports without checking the actual module boundary.
- Startup uses `init_beanie(..., skip_indexes=True)` and explicit index creation.

## ANTI-PATTERNS (THIS PROJECT)
- Do not assume every match has three district slots: Finals use seven.
- Do not bypass persisted identity checks when publishing success or replaying
  controls; start, storage, and result paths have stale-state regression tests.
- Do not treat integration discovery with skipped tests as a passing CI gate.

## UNIQUE STYLES
- `mention_user` returns an already-bold display-name link; avoid nested bold.
- `embed_edit_payload` explicitly resets descriptions omitted by Embed serialization.
- Bot-message command references use backticks, including subcommands;
  slash-option descriptions stay plain text (`docs/copy-style.md`).
- Several orchestration modules use local imports to cross existing cog boundaries;
  `tests/test_cog_imports.py` checks fresh-module import independence.

## COMMANDS
```bash
python -m pip install -r requirements.txt
python -m pip check
python -m unittest discover -v tests
# With explicitly configured disposable local replica-set URIs:
python -m unittest discover -v -s tests/integration
```

## NOTES
- Running entry points starts real API/database clients; reading or importing test
  fixtures is not equivalent to launching a safe sandbox deployment.
- `main.py` and `beta.py` select configuration by filename; beta sync is controlled
  by `BETA_SYNC_FROM_MAIN`, currently false.
- CI uses Python 3.12, MongoDB 7 with a replica set, and Unicode fonts.
- Model setup/evaluation has its own CLI; see fingerprint guidance before running.
