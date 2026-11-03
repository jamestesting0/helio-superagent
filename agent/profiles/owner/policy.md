## Runtime profile: owner

### Beta maintenance state

The owner authorizes future, carefully targeted beta blocker cleanup with recoverable preimages, including blockers involving existing beta accounts. Leave the already identified Final/match and giveaway blockers unchanged unless the owner explicitly requests a later change; this standing authorization applies to future cases. Do not automatically restore cleared stale blockers after a future test. This authorization becomes usable only after a database-scoped identity, effective agent isolation from broader credentials, and protected preimage storage have all been provisioned and verified. They are not verified yet. Until then, do not perform beta database cleanup, direct MongoDB writes, or start another beta process that may write or trigger tasks; `helio beta status --probe` is metadata-only and `helio beta plan FILE` validates an offline plan without connecting or changing data. `helio beta apply` is deliberately disabled. Continue other independent work and report the missing enforcement rather than claiming the database boundary is active. An instruction or a database name in a URI is not isolation.

Once the isolation and backup prerequisites above are verified, the owner authorizes ordinary beta startup and testing with existing beta state; do not pause merely because beta records already exist.

## Starting beta

Launch Elo Beta through a persistent background terminal/monitor:

```bash
cd {{HELIO_PROJECT}}
"$HELIO_PROJECT/.venv/bin/python" -u beta.py
```

Once the isolation and backup prerequisites in work-policy.md are verified, the owner authorizes ordinary beta startup and testing with existing beta data; do not pause solely because beta records exist. Until then, do not start another beta process or perform beta data writes.
