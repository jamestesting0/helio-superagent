import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json
import runpy
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

from bson import BSON

ROOT = Path(__file__).resolve().parent.parent
M = runpy.run_path(str(ROOT / 'scripts/helio_beta_broker.py'))


class FakeCollection:
    def __init__(self, doc):
        self.doc = doc
        self.race = False
        self.fail = False
        self.reads = 0
        self.calls = []

    def find_one(self, query):
        self.reads += 1
        return deepcopy(self.doc)

    def update_one(self, selector, update):
        self.calls.append((selector, update))
        if self.fail:
            raise ConnectionError('simulated uncertain commit')
        return SimpleNamespace(matched_count=0 if self.race else 1)

    def delete_one(self, selector):
        self.calls.append((selector, None))
        if self.fail:
            raise ConnectionError('simulated uncertain commit')
        return SimpleNamespace(deleted_count=0 if self.race else 1)


class FakeDatabase(dict):
    name = 'elo_beta'


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.doc = {'_id': 'fixture', 'state': 'waiting', 'counter': 3}
        self.coll = FakeCollection(self.doc)
        self.db = FakeDatabase(test_records=self.coll)
        self.plan = {'database': 'elo_beta', 'purpose': 'test', 'operations': [{
            'collection': 'test_records', 'id': 'fixture', 'action': 'update',
            'reason': 'prepare fixture', 'before': deepcopy(self.doc),
            'set': {'state': 'ready'}, 'unset': []}]}

    def tearDown(self):
        self.tmp.cleanup()

    def apply(self, op='a' * 32, deny=None):
        return M['apply_one'](self.db, self.root, op, self.plan, deny or set())

    def test_stores_exact_preimage_and_guards_atomic_mutation(self):
        result = self.apply()
        self.assertEqual(result['status'], 'applied')
        archive = self.root / ('a' * 32)
        self.assertEqual(BSON((archive / 'preimage.bson').read_bytes()).decode(), self.doc)
        self.assertEqual(json.loads((archive / 'result.json').read_text())['status'], 'applied')
        selector, update = self.coll.calls[0]
        self.assertEqual(selector['_id'], 'fixture')
        self.assertEqual(selector['$expr']['$eq'][1]['$literal'], self.doc)
        self.assertEqual(update, {'$set': {'state': 'ready'}})

    def test_conflict_and_uncertain_result_are_never_automatically_retried(self):
        for op, attribute, outcome in [('b' * 32, 'race', 'conflict'), ('c' * 32, 'fail', 'uncertain')]:
            setattr(self.coll, attribute, True)
            self.assertEqual(self.apply(op)['status'], outcome)
            with self.assertRaises(M['MaintenanceError']):
                self.apply(op)
            setattr(self.coll, attribute, False)

    def test_changed_preimage_or_excluded_record_never_mutates(self):
        self.plan['operations'][0]['before']['state'] = 'different'
        with self.assertRaises(M['MaintenanceError']):
            self.apply()
        self.assertEqual(self.coll.calls, [])
        self.plan['operations'][0]['before'] = deepcopy(self.doc)
        with self.assertRaises(M['MaintenanceError']):
            self.apply(deny={('test_records', 'string:fixture')})
        self.assertEqual(self.coll.calls, [])

    def test_refuses_other_databases_and_multiple_operations(self):
        self.plan['database'] = 'elo_bot'
        with self.assertRaises(ValueError):
            self.apply()
        self.plan['database'] = 'elo_beta'
        second = deepcopy(self.plan['operations'][0]); second['id'] = 'two'; second['before']['_id'] = 'two'
        self.plan['operations'].append(second)
        with self.assertRaises(M['MaintenanceError']):
            self.apply()
        self.assertEqual(self.coll.calls, [])

    def test_refuses_wrong_database_handle_even_with_valid_plan(self):
        self.db.name = 'elo_bot'
        with self.assertRaises(M['MaintenanceError']):
            self.apply()
        self.assertEqual(self.coll.reads, 0)


if __name__ == '__main__':
    unittest.main()
