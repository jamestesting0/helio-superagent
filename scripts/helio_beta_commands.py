"""Elo Beta's slash commands as clickable mentions, for live tests.

    helio beta commands list          print each command path and its mention as JSON
    helio beta commands post [--force] post them as Elo Beta in the Test thread (HELIO_TEST_CHANNEL)

Clicking a mention such as </match queue:123> in Discord fills exactly Elo Beta's command into the message
box, so tests never type `/` or pick between Elo Beta and the production bot's command of the same name.
"""
import hashlib, json, os, urllib.error, urllib.request
from pathlib import Path

API = 'https://discord.com/api/v10'


class CommandsError(Exception): pass


def beta_token(home: Path) -> str:
    for line in (home / '.dori/elobot/beta.env').read_text().splitlines():
        key, sep, value = line.strip().removeprefix('export ').partition('=')
        if sep and key == 'BOT_BETA_TOKEN':
            return value.strip().strip('"\'')
    raise CommandsError('BOT_BETA_TOKEN is missing from beta.env')


def call(token, method, path, body=None):
    request = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Authorization': 'Bot ' + token, 'Content-Type': 'application/json',
                                              'User-Agent': 'DiscordBot (https://discord.com, 1.0)'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise CommandsError(f'Discord HTTP {error.code} for {method} {path}') from None


def mentions(commands):
    out = {}
    for command in commands:
        if command.get('type', 1) != 1:
            continue
        name, cid = command['name'], command['id']
        nested = [o for o in command.get('options') or [] if o.get('type') in (1, 2)]
        if not nested:
            out[name] = f'</{name}:{cid}>'
        for option in nested:
            if option['type'] == 1:
                out[f"{name} {option['name']}"] = f"</{name} {option['name']}:{cid}>"
            else:
                for sub in option.get('options') or []:
                    if sub.get('type') == 1:
                        path = f"{name} {option['name']} {sub['name']}"
                        out[path] = f'</{path}:{cid}>'
    return dict(sorted(out.items()))


def collect(token, channel):
    app = call(token, 'GET', '/oauth2/applications/@me')['id']
    guild = call(token, 'GET', f'/channels/{channel}').get('guild_id')
    commands = {c['name']: c for c in call(token, 'GET', f'/applications/{app}/commands')}
    if guild:
        commands.update({c['name']: c for c in call(token, 'GET', f'/applications/{app}/guilds/{guild}/commands')})
    return guild, mentions(commands.values())


def chunks(lines, limit=1900):
    block = ''
    for line in lines:
        if block and len(block) + len(line) + 1 > limit:
            yield block
            block = ''
        block += line + '\n'
    if block:
        yield block


def main(action, force=False, home=Path.home()):
    channel = os.environ.get('HELIO_TEST_CHANNEL', '').strip()
    if not channel.isdigit():
        raise CommandsError('HELIO_TEST_CHANNEL is not set')
    token = beta_token(home)
    guild, table = collect(token, channel)
    if action == 'list':
        print(json.dumps(table, indent=2))
        return 0
    state = home / '.dori/elobot/state/beta-command-palette.json'
    digest = hashlib.sha256(json.dumps([channel, table]).encode()).hexdigest()
    try:
        previous = json.loads(state.read_text())
    except (OSError, ValueError):
        previous = {}
    if previous.get('digest') == digest and previous.get('links') and not force:
        print('Palette unchanged; reuse:', *previous['links'], sep='\n')
        return 0
    lines = ['**Elo Beta command palette.** Click a command to fill it into the message box.', *table.values()]
    links = []
    for text in chunks(lines):
        message = call(token, 'POST', f'/channels/{channel}/messages', {'content': text, 'allowed_mentions': {'parse': []}})
        links.append(f'https://discord.com/channels/{guild}/{channel}/{message["id"]}')
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({'digest': digest, 'links': links}) + '\n')
    print('Palette posted:', *links, sep='\n')
    return 0
