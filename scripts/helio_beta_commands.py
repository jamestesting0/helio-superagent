"""Elo Beta's slash commands as clickable mentions, for live tests.

    helio beta commands list                                  every command, its mention, and where it can run
    helio beta commands mention "match base submit" [--channel ID]   post one mention as Elo Beta (default: Test thread)
    helio beta commands delete                                delete the posted mention message(s)

Clicking a posted mention such as </match queue:123> fills exactly Elo Beta's command into that channel's
message box, so tests never type `/` or pick between Elo Beta and the production bot's command of the same name.
Where a command can run is read from Elo Bot's source: a command that compares the current channel (a match
looked up by its thread, a channel name, ID or parent check) is bound and is refused in the Test thread.
"""
import ast, difflib, json, os, re, urllib.error, urllib.request
from pathlib import Path

API = 'https://discord.com/api/v10'


class CommandsError(Exception): pass


def beta_token(home: Path) -> str:
    for line in (home / '.dori/elobot/beta.env').read_text().splitlines():
        key, sep, value = line.strip().removeprefix('export ').partition('=')
        if sep and key == 'BOT_BETA_TOKEN':
            return value.strip().strip('"\'')
    raise CommandsError('BOT_BETA_TOKEN is missing from beta.env')


def call(token, method, path, body=None, missing_ok=False):
    request = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Authorization': 'Bot ' + token, 'Content-Type': 'application/json',
                                              'User-Agent': 'DiscordBot (https://discord.com, 1.0)'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        raise CommandsError(f'Discord HTTP {error.code} for {method} {path}') from None


CTX_NAMES = ('ctx', 'context', 'interaction', 'inter')
THREAD_CHECKS = {'is_automatic_match_thread_member'}


def _kw(call, name):
    for keyword in call.keywords:
        if keyword.arg == name and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
            return keyword.value.value
    return None


def _command_vars(tree):
    """SlashCommand/group variables in one file, in source order: name -> [(line, (command, group))].

    A name can be rebound (two groups assigned to the same variable), so a decorator uses the latest binding above it.
    """
    found = {}

    def at(name, line):
        bound = [value for where, value in found.get(name, []) if where <= line]
        return bound[-1] if bound else None

    assigns = sorted((n for n in ast.walk(tree) if isinstance(n, ast.Assign) and len(n.targets) == 1
                      and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Call)), key=lambda n: n.lineno)
    for node in assigns:
        func, name = node.value.func, _kw(node.value, 'name')
        if not name:
            continue
        if isinstance(func, ast.Attribute) and func.attr == 'SlashCommand':
            value = (name, None)
        elif isinstance(func, ast.Attribute) and func.attr == 'group' and isinstance(func.value, ast.Name) and at(func.value.id, node.lineno):
            value = (at(func.value.id, node.lineno)[0], name)
        else:
            continue
        found.setdefault(node.targets[0].id, []).append((node.lineno, value))
    return at


def _is_current_channel(node):
    """ctx.channel..., ctx.channel_id or x.parent_channel anywhere inside node."""
    for sub in ast.walk(node):
        if isinstance(sub, ast.Attribute):
            if sub.attr == 'parent_channel':
                return True
            if sub.attr in ('channel', 'channel_id') and isinstance(sub.value, ast.Name) and sub.value.id in CTX_NAMES:
                return True
    return False


def _signals(node):
    """Restrictions inside one function that tie a command to where it is run.

    Sending to a channel or naming one in text is not a restriction; comparing the current channel is:
    a match looked up by `thread == ctx.channel.id`, a check of the channel's name, ID or parent, an
    isinstance check of ctx.channel, or a lookup keyed by thread.
    """
    out = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Compare) and _is_current_channel(sub):
            out.add(f'compares {ast.unparse(sub)[:80]}')
        elif (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id == 'isinstance'
              and sub.args and _is_current_channel(sub.args[0])):
            out.add(f'checks {ast.unparse(sub)[:80]}')
        elif isinstance(sub, ast.keyword) and sub.arg and 'thread' in sub.arg and _is_current_channel(sub.value):
            out.add(f'looks up {sub.arg}= by the current channel')
        elif isinstance(sub, ast.Dict) and any(isinstance(k, ast.Constant) and 'thread' in str(k.value) and _is_current_channel(v)
                                               for k, v in zip(sub.keys, sub.values)):
            out.add('looks up a thread by the current channel')
        elif isinstance(sub, ast.Name) and sub.id in THREAD_CHECKS:
            out.add(f'requires {sub.id}')
    return out


def _callees(node):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            func = sub.func
            if isinstance(func, ast.Name):
                yield func.id
            elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in ('self', 'cls'):
                yield func.attr


def classify(source_root: Path, depth: int = 4):
    """For every slash command in Elo Bot's cogs, the reasons it is bound to a channel (empty: usable anywhere)."""
    functions, commands = {}, {}
    files = sorted((source_root / 'cogs').rglob('*.py')) + [p for p in (source_root / 'main.py', source_root / 'beta.py') if p.is_file()]
    for path in files:
        tree = ast.parse(path.read_text(), str(path))
        variable_at = _command_vars(tree)
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            functions.setdefault(node.name, []).append(node)
            for deco in node.decorator_list:
                if not isinstance(deco, ast.Call):
                    continue
                func = deco.func
                name = func.attr if isinstance(func, ast.Attribute) else getattr(func, 'id', None)
                if name == 'slash_command':
                    parts = [_kw(deco, 'name'), _kw(deco, 'group_name'), _kw(deco, 'sub_cmd_name')]
                elif name == 'subcommand' and isinstance(func.value, ast.Name) and variable_at(func.value.id, node.lineno):
                    root, group = variable_at(func.value.id, node.lineno)
                    parts = [root, _kw(deco, 'group_name') or group, _kw(deco, 'sub_cmd_name')]
                else:
                    continue
                if parts[0]:
                    commands[' '.join(p for p in parts if p)] = node
    result = {}
    for path, node in commands.items():
        reasons, seen, frontier = set(), {node.name}, [(node, node.name)]
        for level in range(depth + 1):
            following = []
            for fn, where in frontier:
                reasons |= {f'{r} in {where}' if where != node.name else r for r in _signals(fn)}
                if level < depth:
                    for callee in _callees(fn):
                        if callee not in seen and callee in functions:
                            seen.add(callee)
                            following += [(f, callee) for f in functions[callee]]
            frontier = following
        result[path] = sorted(reasons)
    return result


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


# Exceptions reviewed against the code: they apply only while the command's signals are exactly these.
REVIEWED_ANYWHERE = {
    'match submit': ("compares getattr(getattr(ctx.channel, 'parent_channel', None), 'id', None) == FINAL_CHANN",),  # refuses inside Final match threads, works everywhere else
}


def source_root():
    here = Path.cwd()
    if (here / 'cogs').is_dir() and (here / 'main.py').exists():
        return here
    return Path(os.environ.get('HELIO_PROJECT', Path.home() / 'PythonProjects/elo-bot'))


def placement(table, source):
    """Where each registered command can be run: anywhere, bound (with the reasons), or unknown in this source."""
    reasons = classify(source)
    out = {}
    for path, mention in table.items():
        why = reasons.get(path)
        where = 'unknown' if why is None else 'anywhere' if not why or tuple(why) == REVIEWED_ANYWHERE.get(path) else 'bound'
        out[path] = {'mention': mention, 'where': where, **({'why': why[:3]} if where == 'bound' else {})}
    return out


def collect(token, channel):
    app = call(token, 'GET', '/oauth2/applications/@me')['id']
    guild = call(token, 'GET', f'/channels/{channel}').get('guild_id')
    commands = {c['name']: c for c in call(token, 'GET', f'/applications/{app}/commands')}
    if guild:
        commands.update({c['name']: c for c in call(token, 'GET', f'/applications/{app}/guilds/{guild}/commands')})
    return guild, mentions(commands.values())


def _state(home, name):
    return home / '.dori/elobot/state' / name


def _load(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def delete_mentions(token, home):
    path = _state(home, 'beta-command-mentions.json')
    posted = _load(path, [])
    for item in posted:
        call(token, 'DELETE', f"/channels/{item['channel']}/messages/{item['message']}", missing_ok=True)
    path.unlink(missing_ok=True)
    palette = _state(home, 'beta-command-palette.json')  # the retired palette: remove its messages once
    for link in _load(palette, {}).get('links', []):
        _, channel, message = link.rsplit('/', 2)
        call(token, 'DELETE', f'/channels/{channel}/messages/{message}', missing_ok=True)
        posted.append(link)
    palette.unlink(missing_ok=True)
    return len(posted)


def mention(token, home, table, test_channel, target, channel):
    path = ' '.join(target.removeprefix('/').split())
    entry = table.get(path)
    if entry is None:
        near = difflib.get_close_matches(path, table, n=3)
        raise CommandsError(f'Elo Beta has no /{path} command' + (f"; did you mean {', '.join('/' + n for n in near)}?" if near else ''))
    if entry['where'] == 'bound' and channel == test_channel:
        raise CommandsError(f"/{path} only works in the channel it belongs to ({entry['why'][0]}); "
                            'pass --channel with the match thread (or required channel) ID')
    delete_mentions(token, home)
    guild = call(token, 'GET', f'/channels/{channel}').get('guild_id') or '@me'
    message = call(token, 'POST', f'/channels/{channel}/messages', {'content': entry['mention'], 'allowed_mentions': {'parse': []}})
    state = _state(home, 'beta-command-mentions.json')
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps([{'channel': channel, 'message': message['id']}]) + '\n')
    print(json.dumps({'mention': entry['mention'], 'where': entry['where'], 'channel': channel, 'message_id': message['id'],
                      'link': f"https://discord.com/channels/{guild}/{channel}/{message['id']}"}))
    return 0


def main(action, target=None, channel=None, home=Path.home()):
    test_channel = os.environ.get('HELIO_TEST_CHANNEL', '').strip()
    if not test_channel.isdigit():
        raise CommandsError('HELIO_TEST_CHANNEL is not set')
    channel = channel or test_channel
    if not channel.isdigit():
        raise CommandsError('--channel must be a Discord channel or thread ID')
    token = beta_token(home)
    if action == 'delete':
        print(f'Deleted {delete_mentions(token, home)} command mention message(s).')
        return 0
    _, mentions_by_path = collect(token, test_channel)
    table = placement(mentions_by_path, source_root())
    if action == 'list':
        print(json.dumps(table, indent=2))
        return 0
    if action == 'mention':
        if not target:
            raise CommandsError('mention needs a command, for example "match base submit"')
        return mention(token, home, table, test_channel, target, channel)
    raise CommandsError(f'unknown action {action}')
