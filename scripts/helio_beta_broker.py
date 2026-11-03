#!/usr/bin/env python3
"""Exact-record beta maintenance; intended to run only as the vault service UID.

This is staged code. Do not expose it or enable mutations until the agent
runtime and every privileged channel have been isolated and verified.
"""
from __future__ import annotations

import hashlib
import json
import os
import runpy
import secrets
from pathlib import Path

from bson import BSON, json_util

BASE = Path(__file__).resolve().parent
prep = runpy.run_path(str(BASE / 'helio-beta.py'))
vault = runpy.run_path(str(BASE / 'helio_beta_vault.py'))


class MaintenanceError(Exception):
    pass


def apply_one(database, root: Path, op_id: str, plan: dict, denylist: set[tuple[str, str]]) -> dict:
    """Back up a live preimage before one conditional, exact-ID change.

    A persisted operation may never be retried blindly. The preimage archive
    remains present for conflict, failure and uncertain-outcome investigation.
    """
    if not vault['OP_ID'].fullmatch(op_id):
        raise MaintenanceError('invalid operation ID')
    if getattr(database, 'name', None) != 'elo_beta':
        raise MaintenanceError('database handle is not elo_beta')
    prep['validate_plan'](plan)
    if len(plan['operations']) != 1:
        raise MaintenanceError('one operation is required per durable archive')
    operation = plan['operations'][0]
    identity_key = prep['identity_key'](operation['id'])
    if (operation['collection'], identity_key) in denylist:
        raise MaintenanceError('this record is excluded from standing authorization')
    # The owner-controlled archive may be inspected, but never overwritten or
    # retried automatically after a crash or uncertain database response.
    if (root / op_id).exists() or (root / op_id).is_symlink():
        raise MaintenanceError('operation ID already exists; inspect before retrying')
    decoded = json_util.loads(json.dumps(operation))
    collection = database[operation['collection']]
    current = collection.find_one({'_id': decoded['id']})
    if current is None:
        raise MaintenanceError('record no longer exists')
    expected = decoded['before']
    try:
        current_raw, expected_raw = BSON.encode(current), BSON.encode(expected)
    except Exception as exc:
        raise MaintenanceError('cannot encode preimage') from exc
    if current_raw != expected_raw:
        raise MaintenanceError('record changed; inspect it and replan')

    import base64
    request = {'database': 'elo_beta', 'collection': operation['collection'],
               'operation_id': op_id, 'reason': operation['reason'],
               'document_bson': base64.b64encode(current_raw).decode('ascii')}
    saved = vault['store_preimage'](root, request)
    if saved.get('status') != 'stored':
        raise MaintenanceError('backup was not newly persisted')
    target = root / op_id
    prepared = {'status': 'prepared', 'action': operation['action'],
                'preimage_sha256': hashlib.sha256(current_raw).hexdigest()}
    vault['write_exclusive'](target / 'prepared.json', (json.dumps(prepared) + '\n').encode())
    vault['sync_dir'](target)

    # $$ROOT literal equality checks the whole preimage in the same atomic
    # operation, avoiding a read-then-write lost update.
    match = {'_id': decoded['id'], '$expr': {'$eq': ['$$ROOT', {'$literal': current}]}}
    try:
        if operation['action'] == 'delete':
            result = collection.delete_one(match)
            matched = result.deleted_count
        else:
            update = {}
            if decoded.get('set'):
                update['$set'] = decoded['set']
            if decoded.get('unset'):
                update['$unset'] = {path: '' for path in decoded['unset']}
            result = collection.update_one(match, update)
            matched = result.matched_count
        outcome = 'applied' if matched == 1 else 'conflict'
    except Exception:
        # A network error may happen after MongoDB committed the operation.
        outcome = 'uncertain'
    receipt = {'status': outcome, 'operation_id': op_id}
    try:
        vault['write_exclusive'](target / 'result.json', (json.dumps(receipt) + '\n').encode())
        vault['sync_dir'](target)
    except OSError:
        # Never claim success when the audit receipt was not durable.
        outcome = 'uncertain'
    return {'operation_id': op_id, 'status': outcome, 'backup': 'stored'}


def new_operation_id() -> str:
    return secrets.token_hex(16)
