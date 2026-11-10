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
                                      bot_identity=lambda _home: {'id': '88', 'name': 'Elo Beta'})
            self.assertEqual(code, 3)
            self.assertEqual(out['state'], 'uncertain')
            self.assertEqual(len(clicks), 1)


class LivePageChangeTests(unittest.TestCase):
    def test_an_executed_failure_or_script_error_is_never_repeated(self):
        qa = runpy.run_path(str(SCRIPT))
        calls = []

        def executed(*argv, timeout=60):
            calls.append(argv[0])
            if argv[:2] == ('cooperate', 'sync'):
                return {'state': {'mode': 'ready', 'editing': False}, 'context_id': 'c', 'observation_id': f'o{len(calls)}'}
            if argv[0] == 'evaluate':
                return {'ok': False, 'error': 'TypeError: x is null'}
            raise qa['Refused']('click failed after dispatch')

        qa['bsk'].__globals__['_bsk_once'] = executed
        with self.assertRaises(qa['Refused']):
            qa['bsk']('click', '--session', 's', '--context', 'c0', '--selector', 'x')
        with self.assertRaisesRegex(qa['Refused'], 'page script failed'):
            qa['evaluate']('s', 'c0', '1')
        self.assertEqual(calls, ['click', 'cooperate', 'evaluate'])

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


class StrictBrowser:
    """BrowserSkill's cooperation rules: scripts and navigation need an unused observation from the latest sync,
    input invalidates observations, and the first script after navigating meets Discord's still-loading media."""

    def __init__(self, qa, account_path, detected=True, clicks_to_fill=1):
        self.qa, self.path, self.issued, self.calls, self.syncs, self.media_loading = qa, account_path, set(), [], 0, False
        self.filled = self.sent = False
        self.scripts, self.detected, self.clicks, self.clicks_to_fill = [], detected, 0, clicks_to_fill

    def __call__(self, *argv, timeout=60):
        self.calls.append(argv[0])
        if argv[:2] == ('cooperate', 'sync'):
            self.syncs += 1
            self.issued = {f'o{self.syncs}'}
            return {'state': {'mode': 'ready', 'editing': False}, 'context_id': f'c{self.syncs}', 'observation_id': f'o{self.syncs}'}
        if argv[0] in ('evaluate', 'navigate') and '--context' in argv:
            observation = argv[argv.index('--observation') + 1] if '--observation' in argv else None
            if observation not in self.issued:
                raise self.qa['Refused']('This action requires an unused strict observation', unexecuted=True)
            self.issued.discard(observation)
            if argv[0] == 'evaluate' and self.media_loading:
                self.media_loading = False
                raise self.qa['Refused']('The media source changed; synchronize and replan', unexecuted=True)
        if argv[0] in ('click', 'press', 'fill', 'navigate'):
            self.issued.clear()
            self.clicks += argv[0] == 'click'
            self.filled = self.clicks >= self.clicks_to_fill
            self.sent = self.sent or (argv[0] == 'press' and argv[1] == 'Enter')
            self.media_loading = argv[0] == 'navigate'
        if argv[:2] == ('session', 'list'):
            return []
        if argv[:2] == ('session', 'start'):
            return {'session_id': 's1'}
        if argv[0] != 'evaluate':
            return {}
        script = argv[-1]
        self.scripts.append(script)
        if 'const truth=' in script:
            truth = json.loads(script.split('const truth=', 1)[1].split(',bot=', 1)[0])
            rows = [{'id': i, 'expected': v, 'detected': v if self.detected else False, 'author': '', 'author_id': ''} for i, v in truth.items()]
            return {'ok': True, 'result': json.dumps({'composer': True, 'messages': 5, 'account': True, 'identity': rows})}
        if 'location.pathname' in script:
            return {'ok': True, 'result': json.dumps({'path': self.path, 'account': 'Dominik dominikisop'})}
        if 'const t="' in script:
            return {'ok': True, 'result': script.split('const t="', 1)[1].split('"', 1)[0]}
        if 'const base=new Set' in script:
            return {'ok': True, 'result': json.dumps({'state': 'done', 'message_id': '9', 'author': 'Elo Beta', 'embeds': []})}
        if 'map(fieldName)' in script:
            return {'ok': True, 'result': json.dumps(['Page number'])}
        if 'DataTransfer' in script:
            return {'ok': True, 'result': 'PASTED'}
        if 'if(o)return o.innerText.trim()' in script:
            return {'ok': True, 'result': 'Hitrate'}
        if 'x.includes(' in script:
            return {'ok': True, 'result': '/leaderboard lb_type:' if self.filled else ''}
        if 'if(!editorText())return' in script or 'return editorText();' in script:
            # An empty message box reads as '': before the mention is clicked and once the command is sent.
            return {'ok': True, 'result': '/leaderboard lb_type: Hitrate' if self.filled and not self.sent else ''}
        return {'ok': True, 'result': '[]'}


class BrowserSkillContractTests(unittest.TestCase):
    def drive(self, home, namespace, **patches):
        qa = runpy.run_path(str(SCRIPT))
        browser = StrictBrowser(qa, '/channels/1033924790513311756/100', patches.pop('detected', True), patches.pop('clicks_to_fill', 1))
        qa['main'].__globals__.update(_bsk_once=browser, bot_identity=lambda _home: {'id': '88', 'name': 'Elo Beta'}, subprocess=mock.Mock(
            run=mock.Mock(return_value=mock.Mock(returncode=0, stdout='ready', stderr=''))), **patches)
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.dict('os.environ', {'HELIO_TEST_CHANNEL': '100', 'HELIO_TEST_CATEGORY': 'cat'}):
            code = qa['main'](namespace, home=home)
        return code, json.loads(out.getvalue().strip().splitlines()[-1]), browser

    def test_start_doctor_run_and_click_follow_browser_and_discord_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.dori/elobot').mkdir(parents=True)
            (home / '.dori/elobot/qa-accounts.json').write_text(json.dumps({'qa-a': {'account': 'Dominik', 'browser': 'b1'}}))
            commands = runpy.run_path(str(SCRIPT.with_name('helio_beta_commands.py')))

            def mention(_token, home_, _table, _test, _path, channel):
                (home_ / '.dori/elobot/state/beta-command-mentions.json').write_text(json.dumps([{'channel': channel, 'message': '555'}]))

            def call(_token, _method, path):
                if 'messages' in path:
                    return [{'id': '9', 'author': {'id': '88'}}, {'id': '8', 'author': {'id': '66'}}]
                return {'id': '88', 'username': '.Elo Beta'}

            discord = {'call': call, 'collect': lambda *_a: (None, {}), 'placement': lambda *_a: {}, 'source_root': lambda: None,
                       'mention': mention, 'CommandsError': RuntimeError, 'delete_mentions': lambda *_a: 1,
                       'paste_expression': commands['paste_expression']}
            api = {'rest': lambda _home: (discord, 't')}
            scripts = []

            def drive(namespace, **patches):
                code, out, browser = self.drive(home, namespace, **patches)
                scripts.extend(browser.scripts)
                return code, out, browser

            code, out, _ = drive(args('start'))
            self.assertEqual((code, out['state']), (0, 'ready'), out)
            code, out, _ = drive(args('doctor'), **api)
            self.assertEqual((code, out['state'], out['authorship_checked']), (0, 'ok', 2), out)
            # Elo Beta's message not recognised on the page is caught before any command is sent.
            code, out, _ = drive(args('doctor'), detected=False, **api)
            self.assertEqual((code, out['state'], [row['id'] for row in out['wrong']]), (2, 'drift', ['9']), out)
            leaderboard = {'schema': lambda *_a: {'leaderboard': LEADERBOARD}, **api}
            # Discord ignored the first mention click; the second fills the box and the command is sent once.
            code, out, browser = drive(args('run', 'leaderboard', opt=['lb_type=Hitrate']), clicks_to_fill=2, **leaderboard)
            self.assertEqual((code, out['state'], out['message_id']), (0, 'done', '9'), out)
            self.assertEqual((browser.calls.count('click'), browser.calls.count('press')), (2, 2))
            code, out, browser = drive(args('run', 'leaderboard', opt=['lb_type=Hitrate']), clicks_to_fill=9, **leaderboard)
            self.assertEqual((code, browser.calls.count('click'), browser.calls.count('press')), (2, 3, 0), out)
            self.assertIn('after 3 clicks', out['error'])
            code, out, browser = drive(args('click', message='9', button='Next'))
            self.assertEqual((code, out['state'], out['message_id']), (0, 'done', '9'), out)
            self.assertEqual(browser.calls.count('click'), 1)
            code, out, browser = drive(args('form', field=['Page=5']))
            self.assertEqual((code, out['state'], browser.calls.count('fill')), (0, 'done', 1), out)
            code, out, browser = drive(args('form', field=['Season=13']))
            self.assertEqual((code, browser.calls.count('fill')), (2, 0), out)
            self.assertIn('Page number', out['error'])
            parsed = subprocess.run(['bun', '-e', 'const t=new Bun.Transpiler({loader:"js"});for(const s of JSON.parse(await Bun.stdin.text()))t.transformSync(s)'],
                                    input=json.dumps(scripts), capture_output=True, text=True, timeout=60)
            self.assertEqual(parsed.returncode, 0, parsed.stderr)
            self.assertTrue(scripts)


class PageScriptTests(unittest.TestCase):
    def test_generated_page_scripts_parse(self):
        qa = runpy.run_path(str(SCRIPT))
        scripts = [qa['baseline_script'](), qa['wait_script'](['a'], '9', {'id': '88', 'name': 'Elo Beta'}, 1000)]
        for source in filter(None, scripts):
            result = subprocess.run(['bun', '-e', 'new Bun.Transpiler({loader:"js"}).transformSync(await Bun.stdin.text())'],
                                    input=source, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
