import json, runpy, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

m = runpy.run_path(str(Path(__file__).resolve().parent.parent / 'scripts/helio_beta_commands.py'))

COG = '''
import interactions as ipy
MATCH_CHANNEL = 1
LOG_CHANNEL = 2

async def find_match(ctx):
    return await Match.find_one(Match.thread == str(ctx.channel.id))

class Matches(ipy.Extension):
    base = ipy.SlashCommand(name="match", description="")
    base_group = base.group(name="base", description="")

    @base.subcommand(sub_cmd_name="queue")
    async def queue(self, ctx):
        channel = await self.bot.fetch_channel(MATCH_CHANNEL)
        await ctx.channel.send("queued")
        await self.log(ctx)

    async def log(self, ctx):
        await (await self.bot.fetch_channel(LOG_CHANNEL)).send(str(ctx.channel.id))

    @base_group.subcommand(sub_cmd_name="submit")
    async def submit(self, ctx):
        await self.lookup(ctx)

    async def lookup(self, ctx):
        return await find_match(ctx)

    @base.subcommand(sub_cmd_name="resubmit")
    async def resubmit(self, ctx):
        if "x" not in ctx.channel.name:
            return

    @ipy.slash_command(name="self", sub_cmd_name="store")
    @ipy.check(is_automatic_match_thread_member)
    async def store(self, ctx):
        pass

    other_group = base.group(name="delete", description="")

    @other_group.subcommand(sub_cmd_name="match")
    async def delete_match(self, ctx):
        pass

    other_group = base.group(name="export", description="")

    @other_group.subcommand(sub_cmd_name="match")
    async def export_match(self, ctx):
        pass

    @ipy.slash_command(name="help")
    async def help(self, ctx):
        pass
'''


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        (Path(self.dir.name) / 'cogs').mkdir()
        (Path(self.dir.name) / 'cogs/matches.py').write_text(COG)
        self.result = m['classify'](Path(self.dir.name))

    def tearDown(self):
        self.dir.cleanup()

    def test_channel_comparisons_bind_a_command_and_destinations_do_not(self):
        bound = {path for path, why in self.result.items() if why}
        self.assertEqual(set(self.result), {'match queue', 'match base submit', 'match resubmit', 'self store', 'help', 'match delete match', 'match export match'})
        self.assertEqual(bound, {'match base submit', 'match resubmit', 'self store'})
        self.assertIn('in find_match', self.result['match base submit'][0])

    def test_reviewed_exception_holds_only_while_the_code_matches(self):
        table = {'match resubmit': '</match resubmit:1>', 'help': '</help:2>', 'gone': '</gone:3>'}
        reviewed = {'match resubmit': tuple(self.result['match resubmit'])}
        with patch.dict(m['placement'].__globals__, {'REVIEWED_ANYWHERE': reviewed}):
            placed = m['placement'](table, Path(self.dir.name))
        self.assertEqual([placed[p]['where'] for p in ('match resubmit', 'help', 'gone')], ['anywhere', 'anywhere', 'unknown'])
        with patch.dict(m['placement'].__globals__, {'REVIEWED_ANYWHERE': {'match resubmit': ('compares something else',)}}):
            self.assertEqual(m['placement'](table, Path(self.dir.name))['match resubmit']['where'], 'bound')

    def test_a_bound_command_is_refused_in_the_test_thread_and_unknown_names_are_suggested(self):
        table = {'match base submit': {'mention': '</match base submit:1>', 'where': 'bound', 'why': ['compares x']}}
        calls = []
        with patch.dict(m['mention'].__globals__, {'call': lambda *a, **k: calls.append(a)}):
            with self.assertRaisesRegex(m['CommandsError'], 'only works in the channel'):
                m['mention']('t', Path(self.dir.name), table, '10', 'match base submit', '10')
            with self.assertRaisesRegex(m['CommandsError'], 'did you mean /match base submit'):
                m['mention']('t', Path(self.dir.name), table, '10', 'match base submt', '10')
        self.assertEqual(calls, [])


class PasteTests(unittest.TestCase):
    def test_paste_text_is_encoded_as_a_javascript_string(self):
        expression = m['paste_expression']('a\'b"c\\n</script>')
        self.assertIn(json.dumps('a\'b"c\\n</script>'), expression)
        self.assertTrue(expression.startswith('(()=>{') and expression.endswith('})()'))


if __name__ == '__main__':
    unittest.main()
