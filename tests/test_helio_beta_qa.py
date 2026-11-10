import argparse
import io
import json
import runpy
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / 'scripts/helio_beta_qa.py'
LEADERBOARD = [
    {'name': 'lb_type', 'type': 3, 'required': True, 'choices': [{'name': 'Elo', 'value': 'elo'}, {'name': 'Hitrate', 'value': 'hitrate'}]},
    {'name': 'player', 'type': 6},
    {'name': 'season', 'type': 4, 'autocomplete': True},
]


def args(action, *target, **options):
    parser = argparse.ArgumentParser()
    runpy.run_path(str(SCRIPT))['add_parser'](parser.add_subparsers(dest='command'))
    argv = ['qa', action, *target]
    for key, value in options.items():
        argv += [f'--{key}', value] if not isinstance(value, list) else [x for v in value for x in (f'--{key}', v)]
    return parser.parse_args(argv)


class OptionPlanTests(unittest.TestCase):
    def setUp(self):
        self.qa = runpy.run_path(str(SCRIPT))

    def test_required_first_then_requested_optional_with_checks_by_type(self):
        plan = self.qa['option_plan'](LEADERBOARD, {'season': '13', 'lb_type': 'Hitrate', 'player': '42'})
        self.assertEqual([(s['name'], s['required'], s['check']) for s in plan],
                         [('lb_type', True, True), ('player', False, False), ('season', False, True)])

    def test_bad_requests_are_refused_before_any_input(self):
        plan = self.qa['option_plan']
        for given, message in (({}, 'missing required'), ({'lb_type': 'Hitrate', 'tier': 'x'}, 'unknown option'),
                               ({'lb_type': 'Best'}, 'must be one of'), ({'lb_type': 'Elo', 'player': 'Tergum'}, 'takes a Discord ID')):
            with self.subTest(given=given), self.assertRaisesRegex(self.qa['Refused'], message):
                plan(LEADERBOARD, given)


class WhereTests(unittest.TestCase):
    def test_parent_chain_decides_inside_outside_and_unverifiable(self):
        qa = runpy.run_path(str(SCRIPT))
        parents = {'thread': {'parent_id': 'chat'}, 'chat': {'parent_id': 'cat'}, 'other': {'parent_id': 'elsewhere'}, 'elsewhere': {}}

        def call(_token, _method, path):
            cid = path.rsplit('/', 1)[1]
            if cid == 'private':
                raise RuntimeError('Discord HTTP 403')
            return parents[cid]

        self.assertEqual(qa['where'](call, 't', ['thread', 'other', 'private'], 'cat'),
                         {'thread': 'inside', 'other': 'outside', 'private': 'unverifiable (Discord HTTP 403)'})


class ExitCodeTests(unittest.TestCase):
    def run_main(self, namespace, home, **patches):
        qa = runpy.run_path(str(SCRIPT))
        main = qa['main']
        for name, value in patches.items():
            main.__globals__[name] = value
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.dict('os.environ', {'HELIO_TEST_CHANNEL': '100', 'HELIO_TEST_CATEGORY': 'cat'}):
            code = main(namespace, home=home)
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def test_no_session_and_bad_arguments_refuse_with_exit_2(self):
        with tempfile.TemporaryDirectory() as home:
            code, out = self.run_main(args('read'), Path(home))
            self.assertEqual((code, out['state']), (2, 'refused'))
            code, out = self.run_main(args('run', 'leaderboard', opt=['lb_type']), Path(home))
            self.assertEqual((code, out['error']), (2, '--opt takes name=value'))

    def test_a_person_holding_the_tab_stops_the_call_before_any_input(self):
        with tempfile.TemporaryDirectory() as home:
            state = Path(home) / '.dori/elobot/state'
            state.mkdir(parents=True)
            (state / 'beta-qa-sessions.json').write_text(json.dumps({'qa-a': {'session': 's1', 'channel': '100'}}))
            calls = []

            def bsk(*argv, timeout=60):
                calls.append(argv[:2])
                return {'state': {'mode': 'ready', 'editing': True}, 'context_id': 'c'}

            code, out = self.run_main(args('click', message='9', button='Next'), Path(home), _bsk_once=bsk)
            self.assertEqual((code, out['state']), (4, 'humanhold'))
            self.assertEqual(calls, [('cooperate', 'sync')])

    def test_an_unanswered_input_is_uncertain_and_never_repeated(self):
        with tempfile.TemporaryDirectory() as home:
            state = Path(home) / '.dori/elobot/state'
            state.mkdir(parents=True)
            (state / 'beta-qa-sessions.json').write_text(json.dumps({'qa-a': {'session': 's1', 'channel': '100'}}))
            clicks = []

            def bsk(*argv, timeout=60):
                if argv[0] == 'click':
                    clicks.append(argv)
                return {'state': {'mode': 'ready', 'editing': False}, 'context_id': 'c'}

            def evaluate(_session, _ctx, expression, timeout='60s'):
                if 'const base=new Set' in expression:
                    return {'state': 'pending', 'message_id': '9', 'thinking': True}
                if 'const t="' in expression:
                    return expression.split('const t="', 1)[1].split('"', 1)[0]
                return []

            code, out = self.run_main(args('click', message='9', button='Next'), Path(home), _bsk_once=bsk, evaluate=evaluate,
                                      bot_name=lambda _home: 'Elo Beta')
            self.assertEqual(code, 3)
            self.assertEqual(out['state'], 'uncertain')
            self.assertEqual(len(clicks), 1)


class LivePageChangeTests(unittest.TestCase):
    def test_an_unexecuted_refusal_resyncs_and_retries_but_an_executed_failure_never_repeats(self):
        qa = runpy.run_path(str(SCRIPT))
        Refused, calls = qa['Refused'], []

        def bsk(*argv, timeout=60):
            calls.append((argv[0], argv[argv.index('--context') + 1] if '--context' in argv else None))
            if argv[:2] == ('cooperate', 'sync'):
                return {'state': {'mode': 'ready', 'editing': False}, 'context_id': f'c{len(calls)}'}
            if len([c for c in calls if c[0] == 'evaluate']) == 1:
                raise Refused('The media source changed; synchronize and replan', unexecuted=True)
            return {'result': 'OK'}

        qa['evaluate'].__globals__['_bsk_once'] = bsk
        qa['CONTEXTS']['s'] = 'c0'
        self.assertEqual(qa['evaluate']('s', 'c0', '1'), 'OK')
        self.assertEqual([c[0] for c in calls], ['evaluate', 'cooperate', 'evaluate'])
        self.assertEqual(calls[2][1], 'c2')

        def executed(*argv, timeout=60):
            calls.append(argv[0])
            raise Refused('click failed after dispatch')

        calls.clear()
        qa['evaluate'].__globals__['_bsk_once'] = executed
        with self.assertRaises(Refused):
            qa['bsk']('click', '--session', 's', '--context', 'c0', '--selector', 'x')
        self.assertEqual(calls, ['click'])

    def test_a_failed_start_stops_the_session_it_created(self):
        with tempfile.TemporaryDirectory() as home:
            elobot = Path(home) / '.dori/elobot'
            elobot.mkdir(parents=True)
            (elobot / 'qa-accounts.json').write_text(json.dumps({'qa-a': {'account': 'Dominik', 'browser': 'b1'}}))
            stopped = []

            def bsk(*argv, timeout=60):
                if argv[:2] == ('session', 'list'):
                    return []
                if argv[:2] == ('session', 'start'):
                    return {'session_id': 'new'}
                if argv[:2] == ('session', 'stop'):
                    stopped.append(argv[2])
                    return {}
                raise qa_refused('navigation failed')

            qa = runpy.run_path(str(SCRIPT))
            qa_refused = qa['Refused']
            main = qa['main']
            main.__globals__.update(_bsk_once=bsk, subprocess=mock.Mock(run=mock.Mock(
                return_value=mock.Mock(returncode=0, stdout='ready', stderr=''))))
            with redirect_stdout(io.StringIO()), mock.patch.dict('os.environ', {'HELIO_TEST_CHANNEL': '100', 'HELIO_TEST_CATEGORY': 'cat'}):
                code = main(args('start'), home=Path(home))
            self.assertEqual((code, stopped), (2, ['new']))


class PageScriptTests(unittest.TestCase):
    def test_generated_page_scripts_parse(self):
        qa = runpy.run_path(str(SCRIPT))
        scripts = [qa['baseline_script'](), qa['wait_script'](['a'], '9', 'Elo Beta', 1000)]
        for source in filter(None, scripts):
            result = subprocess.run(['bun', '-e', 'new Bun.Transpiler({loader:"js"}).transformSync(await Bun.stdin.text())'],
                                    input=source, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
