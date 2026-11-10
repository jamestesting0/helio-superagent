"""Live Elo Beta QA through BrowserSkill, one deterministic call per step.

    helio beta qa start [--profile qa-a] [--channel ID]
    helio beta qa run "<command>" [--opt name=value ...] [--channel ID]
    helio beta qa select --message ID --menu "<current label>" --option "<label>"
    helio beta qa click --message ID --button "<label>"
    helio beta qa form --field "<label>=<value>" ... [--submit "<label>"]
    helio beta qa read [--message ID]
    helio beta qa where ID ...
    helio beta qa doctor
    helio beta qa stop [--profile P | --all]

Every call prints one JSON line. Exit 0: done (state done, failed or modal). Exit 2: refused before any input.
Exit 3: input was sent but no answer was observed; never resend, follow up with `read`. Exit 4: a person holds the tab.
"""
import contextlib, io, json, os, runpy, secrets, subprocess, time, traceback
from pathlib import Path

GUILD = '1033924790513311756'
EDITOR = '[role=textbox][data-slate-editor]'
QA = ('qa-a', 'qa-b', 'qa-c')
CHOICE_TYPES = {3, 4, 10}
ID_TYPES = {6, 7, 8, 9}


class Refused(Exception):
    code = 2

    def __init__(self, message, unexecuted=False):
        super().__init__(message)
        self.unexecuted = unexecuted


class Uncertain(Exception): code = 3
class HumanHold(Exception): code = 4


def _commands():
    return runpy.run_path(str(Path(__file__).with_name('helio_beta_commands.py')))


CONTEXTS, OBSERVATIONS = {}, {}
STRICT = {'evaluate', 'navigate'}


def bsk(*args, timeout=60):
    """Run one bsk command with --json under BrowserSkill's cooperation rules.

    Scripts and navigation have no DOM recipient, so BrowserSkill accepts each only with an unused observation from
    the latest sync; every such call gets its own, and any action invalidates it. A refusal that executed nothing
    (effect_state none, e.g. Discord's media changing the page) is re-synced and retried; anything that may have run
    never is.
    """
    session = args[args.index('--session') + 1] if '--session' in args else None
    for attempt in range(4):
        args = _fresh(args, session)
        try:
            out = _bsk_once(*args, timeout=timeout)
        except Refused as error:
            if not error.unexecuted or attempt == 3 or session is None:
                raise
            sync(session)
            continue
        OBSERVATIONS.pop(session, None)
        return out


def _fresh(args, session):
    args = list(args)
    if session is None or '--context' not in args:
        return tuple(args)
    if args[0] in STRICT:
        if session not in OBSERVATIONS:
            sync(session)
        observation = OBSERVATIONS.pop(session, None)
        if '--observation' in args:
            args[args.index('--observation') + 1] = observation
        elif observation:
            args[1:1] = ['--observation', observation]
    if session in CONTEXTS:
        args[args.index('--context') + 1] = CONTEXTS[session]
    return tuple(args)


def _bsk_once(*args, timeout=60):
    proc = subprocess.run([os.environ.get('BSK_BIN', 'bsk'), *args, '--json'], capture_output=True, text=True, timeout=timeout)
    try:
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        out = {'raw': proc.stdout.strip()}
    if proc.returncode:
        detail = out.get('message') if isinstance(out, dict) else None
        data = out.get('data') if isinstance(out, dict) and isinstance(out.get('data'), dict) else {}
        unexecuted = out.get('code') == 'permission_denied' and data.get('effect_state') == 'none' if isinstance(out, dict) else False
        raise Refused(f"bsk {args[0]} failed: {out.get('code', '') if isinstance(out, dict) else ''} {detail or proc.stderr.strip()[:300]}",
                      unexecuted=unexecuted)
    return out


def evaluate(session, ctx, expression, timeout='60s'):
    out = bsk('evaluate', '--session', session, '--context', ctx, '--timeout', timeout, expression, timeout=120)
    if isinstance(out, dict) and out.get('ok') is False:
        raise Refused(f"page script failed: {str(out.get('error') or out.get('message') or out)[:300]}")
    value = out.get('result', out.get('value', out)) if isinstance(out, dict) else out
    return json.loads(value) if isinstance(value, str) and value.startswith(('{', '[')) else value


# In-page helpers shared by every script: stable Discord hooks only (ids and roles, never hashed classes).
PAGE = r"""
const lis=()=>[...document.querySelectorAll('li[id^="chat-messages-"]')];
const li=id=>lis().find(l=>l.id.endsWith('-'+id));
const mid=l=>l.id.split('-').pop();
const header=l=>{for(let x=l;x;x=x.previousElementSibling){const n=x.querySelector&&x.querySelector('[id^="message-username-"]');if(n)return n;}return null;};
const author=l=>{const n=header(l);return n?n.innerText.trim():'';};
const authorId=l=>{const h=header(l),h3=h&&h.closest('h3'),i=h3&&h3.parentElement&&h3.parentElement.querySelector(':scope > img[src*="/avatars/"]');const m=i&&i.src.match(/avatars\/(\d+)\//);return m?m[1]:'';};
const norm=s=>(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const isBot=(l,b)=>authorId(l)===b.id||(!!norm(b.name)&&norm(author(l)).startsWith(norm(b.name)));
const view=l=>{const acc=l.querySelector('[id^="message-accessories-"]')||l;
 return {message_id:mid(l),author:author(l),ephemeral:/Only you can see this/.test(l.innerText),thinking:/is thinking/i.test(l.innerText),
  failed:/did not respond|interaction failed/i.test(l.innerText),text:(l.querySelector('[id^="message-content-"]')||{}).innerText||'',
  embeds:[...l.querySelectorAll('article')].map(a=>a.innerText),
  components:[...acc.querySelectorAll('button,[role=combobox],[aria-haspopup=listbox]')].map(b=>({type:b.getAttribute('aria-haspopup')||b.getAttribute('role')==='combobox'?'select':'button',label:(b.innerText||b.getAttribute('aria-label')||'').trim(),disabled:b.disabled||b.getAttribute('aria-disabled')==='true'}))};};
const mark=(el,t)=>{if(!el)return null;el.scrollIntoView({block:'center'});el.setAttribute('data-helio-qa',t);return t;};
const editorText=()=>{const e=document.querySelector('[role=textbox][data-slate-editor]');return e?e.innerText.replace(/\uFEFF/g,'').trim():null;};
"""


def page(body):
    return '(async()=>{' + PAGE + body + '})()'


def wait_script(baseline, target, bot, timeout_ms):
    """Resolve with the answer to the last input: a new or edited Elo Beta message, a modal, or pending."""
    return page(f"""const base=new Set({json.dumps(baseline)}),target={json.dumps(target)},bot={json.dumps(bot)};
const before=target&&li(target)?li(target).innerText:null;const end=Date.now()+{int(timeout_ms)};
while(Date.now()<end){{const d=document.querySelector('[role=dialog]');
 if(d&&d.querySelector('input,textarea'))return JSON.stringify({{state:'modal',title:(d.querySelector('h1,h2,[id*=title]')||{{}}).innerText||'',
  fields:[...d.querySelectorAll('label')].map(l=>l.innerText.trim()).filter(Boolean)}});
 const fresh=lis().filter(l=>!base.has(l.id)&&isBot(l,bot)).map(view);
 const edited=target&&li(target)&&li(target).innerText!==before?[view(li(target))]:[];
 const done=[...edited,...fresh].filter(v=>!v.thinking);
 if(done.length)return JSON.stringify({{state:done[0].failed?'failed':'done',...done[0],also:done.slice(1).map(v=>v.message_id)}});
 await new Promise(r=>setTimeout(r,250));}}
const last=[...lis().filter(l=>!base.has(l.id)&&isBot(l,bot)).map(view)].pop()||(target&&li(target)?view(li(target)):null);
return JSON.stringify({{state:'pending',...(last||{{}}),expected:bot,
 seen:lis().filter(l=>!base.has(l.id)).slice(-3).map(l=>({{id:mid(l),author:author(l),author_id:authorId(l)}}))}});""")


def baseline_script():
    return page("return JSON.stringify(lis().map(l=>l.id));")


def state_dir(home):
    return home / '.dori/elobot/state'


def sessions_file(home):
    return state_dir(home) / 'beta-qa-sessions.json'


def load_sessions(home):
    try:
        return json.loads(sessions_file(home).read_text())
    except (OSError, ValueError):
        return {}


def save_sessions(home, data):
    path = sessions_file(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1) + '\n')


def session_for(home, profile):
    entry = load_sessions(home).get(profile)
    if not entry:
        raise Refused(f'no QA session for {profile}; run helio beta qa start --profile {profile}')
    return entry


def sync(session):
    """One small sync per call: a context for DOM-targeted actions, and the human-hold check."""
    out = _bsk_once('cooperate', 'sync', '--session', session, '--max-tokens', '400', '--settle')
    state = out.get('state') or {}
    if state.get('editing') or state.get('mode') != 'ready' or not out.get('context_id'):
        raise HumanHold(f"tab is not ready for input (mode={state.get('mode')}, editing={state.get('editing')}); nothing was done")
    CONTEXTS[session] = out['context_id']
    if out.get('observation_id'):
        OBSERVATIONS[session] = out['observation_id']
    return out['context_id'], out.get('observation_id')


def act(kind, session, ctx, token, *extra):
    sel = f'[data-helio-qa="{token}"]'
    bsk(kind, '--session', session, '--context', ctx, '--selector', sel, *extra)


def find(session, ctx, body, what):
    """Run a finder that marks one element and returns its token, or refuse before any input."""
    token = secrets.token_hex(4)
    got = evaluate(session, ctx, page(f"const t={json.dumps(token)};" + body))
    if got != token:
        raise Refused(f'{what} not found on the page; nothing was clicked')
    return token


def rest(home):
    m = _commands()
    token = m['beta_token'](home)
    return m, token


def where(call, token, ids, category):
    """Each channel's place relative to the test category, from its parent chain."""
    out = {}
    for cid in ids:
        chain, current, verdict = [], cid, 'outside'
        try:
            for _ in range(4):
                if current == category:
                    verdict = 'inside'
                    break
                chain.append(current)
                current = (call(token, 'GET', f'/channels/{current}') or {}).get('parent_id')
                if not current:
                    break
        except Exception as error:  # noqa: BLE001 - a 403/404 is reported per ID, not fatal
            verdict = f'unverifiable ({error})'
        out[cid] = verdict
    return out


def in_scope(home, channel):
    if channel == os.environ.get('HELIO_TEST_CHANNEL', '').strip():
        return
    category = os.environ.get('HELIO_TEST_CATEGORY', '').strip()
    m, token = rest(home)
    if where(m['call'], token, [channel], category).get(channel) != 'inside':
        raise Refused(f'channel {channel} is not verified inside the test category; nothing was done')


def schema(m, token, channel):
    """Registered option lists by command path, from Elo Beta's own command JSON."""
    app = m['call'](token, 'GET', '/oauth2/applications/@me')['id']
    guild = m['call'](token, 'GET', f'/channels/{channel}').get('guild_id')
    commands = m['call'](token, 'GET', f'/applications/{app}/commands') + (
        m['call'](token, 'GET', f'/applications/{app}/guilds/{guild}/commands') if guild else [])
    out = {}
    for command in commands:
        options = command.get('options') or []
        nested = [o for o in options if o.get('type') in (1, 2)]
        if not nested:
            out[command['name']] = options
        for o in nested:
            if o['type'] == 1:
                out[f"{command['name']} {o['name']}"] = o.get('options') or []
            for sub in (o.get('options') or []) if o['type'] == 2 else []:
                out[f"{command['name']} {o['name']} {sub['name']}"] = sub.get('options') or []
    return out


def option_plan(options, given):
    """Required options in schema order, then requested optional ones; unknown or missing names are refused."""
    known = {o['name']: o for o in options}
    unknown = [name for name in given if name not in known]
    if unknown:
        raise Refused(f"unknown option(s) {', '.join(unknown)}; this command has {', '.join(known) or 'none'}")
    missing = [o['name'] for o in options if o.get('required') and o['name'] not in given]
    if missing:
        raise Refused(f"missing required option(s) {', '.join(missing)}")
    plan = []
    for o in sorted(options, key=lambda o: not o.get('required')):
        if o['name'] in given:
            value = given[o['name']]
            if o.get('type') in ID_TYPES and not value.isdigit():
                raise Refused(f"option {o['name']} takes a Discord ID, not {value!r}")
            check = bool(o.get('choices') or o.get('autocomplete'))
            if o.get('choices') and value not in [c['name'] for c in o['choices']]:
                raise Refused(f"option {o['name']} must be one of {', '.join(c['name'] for c in o['choices'])}")
            plan.append({'name': o['name'], 'value': value, 'required': bool(o.get('required')), 'check': check})
    return plan


def finish(home, result, session=None, ctx=None, screenshot=None):
    evidence = state_dir(home) / 'beta-qa'
    evidence.mkdir(parents=True, exist_ok=True)
    full = evidence / f"{time.strftime('%Y%m%dT%H%M%S')}-{result.get('message_id', 'result')}.json"
    full.write_text(json.dumps(result, indent=1) + '\n')
    shot = None
    if screenshot and session:
        if result.get('message_id'):
            token = find(session, ctx, f"return mark(li({json.dumps(result['message_id'])}),t);", 'message')
            bsk('scroll-to', '--session', session, '--context', ctx, '--selector', f'[data-helio-qa="{token}"]')
        bsk('screenshot', '--session', session, '--context', ctx, '--out', screenshot)
        shot = screenshot
    short = dict(result, embeds=[e[:1200] for e in result.get('embeds', [])], text=result.get('text', '')[:800],
                 full=str(full), **({'screenshot': shot} if shot else {}))
    print(json.dumps(short, ensure_ascii=False))
    if result.get('state') == 'pending':
        raise Uncertain(f"no answer observed yet; follow up with helio beta qa read --message {result.get('message_id', '')}")
    return 0


def bot_identity(home):
    m, token = rest(home)
    me = m['call'](token, 'GET', '/users/@me')
    return {'id': me['id'], 'name': me.get('global_name') or me['username']}


def answer(home, session, ctx, baseline, target, timeout):
    return evaluate(session, ctx, wait_script(baseline, target, bot_identity(home), timeout * 1000), timeout=f'{timeout + 15}s')


def start(home, profile, channel):
    accounts = json.loads((home / '.dori/elobot/qa-accounts.json').read_text())
    entry = accounts.get(profile) or {}
    if not entry.get('browser'):
        raise Refused(f'{profile} has no recorded BrowserSkill instance; run helio browser setup {profile}')
    in_scope(home, channel)
    sessions = load_sessions(home)
    live = bsk('session', 'list')
    live = live if isinstance(live, list) else []
    mine = sessions.get(profile, {}).get('session')
    for s in live:
        if s.get('browser_instance_id') == entry['browser'] and s.get('session_id') != mine:
            raise Refused(f"{profile} is held by another BrowserSkill session ({s.get('session_id')}); not shared")
    created = []
    try:
        return _start(home, profile, channel, entry, sessions, live, mine, False, created)
    except BaseException:
        # A session this call started is stopped, so a failed start never leaves an orphan that blocks the retry.
        for session in created:
            try:
                _bsk_once('session', 'stop', session)
            except Refused:
                pass
        raise


def _start(home, profile, channel, entry, sessions, live, mine, opened, created):
    if not mine or not any(s.get('session_id') == mine for s in live):
        ready = subprocess.run(['helio', 'browser', 'ready', '--profile', profile], capture_output=True, text=True, timeout=180)
        if ready.returncode:
            raise Refused(f'helio browser ready failed: {(ready.stdout + ready.stderr).strip()[-300:]}')
        opened = 'already' not in ready.stdout.lower()
        mine = bsk('session', 'start', '--browser', entry['browser'])['session_id']
        created.append(mine)
        bsk('navigate', '--session', mine, f'https://discord.com/channels/{GUILD}/{channel}')
    else:
        ctx, observation = sync(mine)
        bsk('navigate', '--session', mine, '--context', ctx, '--observation', observation, f'https://discord.com/channels/{GUILD}/{channel}')
    bsk('wait-for-element', '--session', mine, '--selector', EDITOR, '--timeout', '30s')
    ctx, _ = sync(mine)
    seen = evaluate(mine, ctx, page("""const u=document.querySelector('[aria-label="User area"],section[class*="panels"]');
return JSON.stringify({path:location.pathname,account:u?u.innerText:''});"""))
    if not seen['path'].endswith('/' + channel):
        raise Refused(f"tab is at {seen['path']}, not channel {channel}")
    if entry.get('account', '').lower() not in seen['account'].lower():
        raise Refused(f"signed-in account could not be confirmed as {entry.get('account')}")
    sessions[profile] = {'session': mine, 'browser': entry['browser'], 'account': entry.get('account'), 'channel': channel,
                         'opened_by_qa': opened or sessions.get(profile, {}).get('opened_by_qa', False)}
    save_sessions(home, sessions)
    print(json.dumps({'state': 'ready', 'profile': profile, **sessions[profile]}))
    return 0


def goto(session, ctx, observation, channel, current):
    if current != channel:
        bsk('navigate', '--session', session, '--context', ctx, '--observation', observation, f'https://discord.com/channels/{GUILD}/{channel}')
        bsk('wait-for-element', '--session', session, '--selector', EDITOR, '--timeout', '30s')
        return sync(session)[0]
    return ctx


def run(home, profile, command, opts, channel, timeout, screenshot):
    entry = session_for(home, profile)
    channel = channel or entry['channel']
    in_scope(home, channel)
    m, token = rest(home)
    path = ' '.join(command.removeprefix('/').split())
    plan = option_plan(schema(m, token, channel).get(path, []), opts)
    session = entry['session']
    ctx, observation = sync(session)
    ctx = goto(session, ctx, observation, channel, entry['channel'])
    entry['channel'] = channel
    if evaluate(session, ctx, page("return editorText();")):
        raise Refused('the message box already holds a draft; clear it or send it before running another command')
    table = m['placement'](m['collect'](token, os.environ['HELIO_TEST_CHANNEL'])[1], m['source_root']())
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m['mention'](token, home, table, os.environ['HELIO_TEST_CHANNEL'], path, channel)
    except m['CommandsError'] as error:
        raise Refused(f'QA_MENTION_FAILED {error}') from None
    posted = json.loads((state_dir(home) / 'beta-command-mentions.json').read_text())[0]['message']
    bsk('wait-for-element', '--session', session, '--selector', f'li[id$="-{posted}"] [id^="message-content-"]', '--timeout', '20s')
    last = path.split()[-1]
    tok = find(session, ctx, f"""const box=document.querySelector('li[id$="-{posted}"] [id^="message-content-"]');
const spans=box?[...box.querySelectorAll('span,div')].filter(e=>!e.children.length&&e.innerText.trim().endsWith({json.dumps(last)})):[];
return mark(spans[spans.length-1],t);""", 'the command mention')
    act('click', session, ctx, tok)
    m['delete_mentions'](token, home)
    filled = evaluate(session, ctx, page(f"""const end=Date.now()+5000;while(Date.now()<end){{const x=editorText();
if(x&&x.includes({json.dumps('/' + path)}))return x;await new Promise(r=>setTimeout(r,150));}}return editorText()||'';"""))
    if f'/{path}' not in (filled or ''):
        raise Refused(f'the mention did not fill /{path} (message box: {filled!r}); nothing was sent')
    paste = m['paste_expression']
    for step in plan:
        if not step['required']:
            tok = find(session, ctx, f"""return mark([...document.querySelectorAll('[role=option]')].find(o=>o.innerText.trim().startsWith({json.dumps(step['name'])})),t);""",
                       f"optional option {step['name']}")
            act('click', session, ctx, tok)
        if evaluate(session, ctx, paste(step['value'])) != 'PASTED':
            raise Refused(f"could not paste {step['name']}; the draft is left in the message box")
        if step['check']:
            top = evaluate(session, ctx, page("""const end=Date.now()+4000;while(Date.now()<end){const o=document.querySelector('[role=option]');
if(o)return o.innerText.trim();await new Promise(r=>setTimeout(r,150));}return '';"""))
            if top.split('\n')[0].strip() != step['value']:
                raise Refused(f"QA_OPTION_MISMATCH {step['name']}: top suggestion is {top!r}, not {step['value']!r}; nothing was sent")
        bsk('press', 'Tab', '--session', session, '--context', ctx, '--selector', EDITOR)
    readback = evaluate(session, ctx, page("return editorText();")) or ''
    for step in plan:
        if step['name'] not in readback or (not step['value'].isdigit() and step['value'] not in readback):
            raise Refused(f"message box does not show {step['name']}={step['value']} ({readback!r}); nothing was sent")
    baseline = evaluate(session, ctx, baseline_script())
    bsk('press', 'Enter', '--session', session, '--context', ctx, '--selector', EDITOR)
    left = evaluate(session, ctx, page("""const end=Date.now()+3000;while(Date.now()<end){if(!editorText())return '';await new Promise(r=>setTimeout(r,150));}
return editorText();"""))
    if left:
        hint = evaluate(session, ctx, page("return ([...document.querySelectorAll('[class*=error],[role=alert]')].map(e=>e.innerText).join(' ')||'').slice(0,300);"))
        raise Refused(f'QA_NOT_SENT Discord kept the command in the message box ({hint or left!r})')
    save_sessions(home, {**load_sessions(home), profile: entry})
    return finish(home, answer(home, session, ctx, baseline, None, timeout), session, ctx, screenshot)


def interact(home, profile, message, kind, label, option, timeout, screenshot):
    session = session_for(home, profile)['session']
    ctx, _ = sync(session)
    baseline = evaluate(session, ctx, baseline_script())
    if kind == 'button':
        tok = find(session, ctx, f"""const l=li({json.dumps(message)});const acc=l&&(l.querySelector('[id^="message-accessories-"]')||l);
return mark(acc&&[...acc.querySelectorAll('button')].find(b=>(b.innerText||b.getAttribute('aria-label')||'').trim()==={json.dumps(label)}&&!b.disabled),t);""",
                   f'enabled button {label!r} on message {message}')
        act('click', session, ctx, tok)
    else:
        tok = find(session, ctx, f"""const l=li({json.dumps(message)});const acc=l&&(l.querySelector('[id^="message-accessories-"]')||l);
return mark(acc&&[...acc.querySelectorAll('[role=combobox],[aria-haspopup=listbox]')].find(s=>s.innerText.trim().startsWith({json.dumps(label)})),t);""",
                   f'select {label!r} on message {message}')
        act('click', session, ctx, tok)
        tok = find(session, ctx, f"""const end=Date.now()+4000;while(Date.now()<end){{const o=[...document.querySelectorAll('[role=option]')].find(o=>o.innerText.trim().split('\\n')[0]==={json.dumps(option)});
if(o)return mark(o,t);await new Promise(r=>setTimeout(r,150));}}return null;""", f'option {option!r}')
        act('click', session, ctx, tok)
    return finish(home, answer(home, session, ctx, baseline, message, timeout), session, ctx, screenshot)


def form(home, profile, fields, submit, timeout, screenshot):
    session = session_for(home, profile)['session']
    ctx, _ = sync(session)
    for label, value in fields:
        tok = find(session, ctx, f"""const d=document.querySelector('[role=dialog]');const l=d&&[...d.querySelectorAll('label')].find(x=>x.innerText.trim().startsWith({json.dumps(label)}));
const i=l&&(l.htmlFor&&document.getElementById(l.htmlFor)||l.parentElement.querySelector('input,textarea'));return mark(i,t);""", f'form field {label!r}')
        act('fill', session, ctx, tok, '--value', value)
    baseline = evaluate(session, ctx, baseline_script())
    tok = find(session, ctx, f"""const d=document.querySelector('[role=dialog]');return mark(d&&[...d.querySelectorAll('button')].find(b=>b.innerText.trim()==={json.dumps(submit)}),t);""",
               f'form button {submit!r}')
    act('click', session, ctx, tok)
    return finish(home, answer(home, session, ctx, baseline, None, timeout), session, ctx, screenshot)


def read(home, profile, message, screenshot):
    session = session_for(home, profile)['session']
    ctx, _ = sync(session)
    bot = bot_identity(home)
    got = evaluate(session, ctx, page(f"""const l={f'li({json.dumps(message)})' if message else f'lis().filter(x=>isBot(x,{json.dumps(bot)})).pop()'};
return JSON.stringify(l?{{state:'done',...view(l)}}:{{state:'missing'}});"""))
    if got.get('state') == 'missing':
        raise Refused('message not found in the loaded channel')
    return finish(home, got, session, ctx, screenshot)


def doctor(home, profile):
    """Read-only check of the page hooks, including Elo Beta authorship against Discord's own message history."""
    entry = session_for(home, profile)
    session = entry['session']
    ctx, _ = sync(session)
    m, token = rest(home)
    bot = bot_identity(home)
    history = m['call'](token, 'GET', f"/channels/{entry['channel']}/messages?limit=20") or []
    truth = {message['id']: message['author']['id'] == bot['id'] for message in history}
    got = evaluate(session, ctx, page(f"""const truth={json.dumps(truth)},bot={json.dumps(bot)};const l=lis();
return JSON.stringify({{composer:!!document.querySelector('[role=textbox][data-slate-editor]'),messages:l.length,
account:!!document.querySelector('[aria-label="User area"],section[class*="panels"]'),
identity:Object.keys(truth).filter(id=>li(id)).map(id=>({{id,expected:truth[id],detected:isBot(li(id),bot),author:author(li(id)),author_id:authorId(li(id))}}))}});"""))
    wrong = [row for row in got['identity'] if row['expected'] != row['detected']]
    ok = bool(got['composer'] and got['messages'] and got['account'] and got['identity'] and not wrong)
    print(json.dumps({'state': 'ok' if ok else 'drift', 'composer': got['composer'], 'messages': got['messages'],
                      'account': got['account'], 'authorship_checked': len(got['identity']), 'wrong': wrong[:5]}, ensure_ascii=False))
    return 0 if ok else 2


def stop(home, profile, everything):
    sessions = load_sessions(home)
    names = list(sessions) if everything else [profile]
    for name in names:
        entry = sessions.pop(name, None)
        if not entry:
            continue
        try:
            bsk('session', 'stop', entry['session'])
        except Refused:
            pass  # already gone; closing the profile below is still correct
        if entry.get('opened_by_qa'):
            subprocess.run(['helio', 'browser', 'close', '--profile', name], capture_output=True, text=True, timeout=60)
    save_sessions(home, sessions)
    print(json.dumps({'state': 'stopped', 'profiles': names}))
    return 0


def main(args, home=Path.home()):
    try:
        test_channel = os.environ.get('HELIO_TEST_CHANNEL', '').strip()
        if args.action == 'start':
            return start(home, args.profile, args.channel or test_channel)
        if args.action == 'run':
            opts = dict(o.split('=', 1) for o in args.opt or [] if '=' in o)
            if len(opts) != len(args.opt or []):
                raise Refused('--opt takes name=value')
            return run(home, args.profile, args.target[0], opts, args.channel, args.timeout, args.screenshot)
        if args.action in ('select', 'click'):
            if not args.message or not (args.menu if args.action == 'select' else args.button) or (args.action == 'select' and not args.option):
                raise Refused('select needs --message, --menu and --option; click needs --message and --button')
            return interact(home, args.profile, args.message, 'select' if args.action == 'select' else 'button',
                            args.menu or args.button, args.option, args.timeout, args.screenshot)
        if args.action == 'form':
            fields = [tuple(f.split('=', 1)) for f in args.field or [] if '=' in f]
            if not fields or len(fields) != len(args.field):
                raise Refused('form needs --field "Label=value"')
            return form(home, args.profile, fields, args.submit, args.timeout, args.screenshot)
        if args.action == 'read':
            return read(home, args.profile, args.message, args.screenshot)
        if args.action == 'where':
            m, token = rest(home)
            print(json.dumps(where(m['call'], token, args.target, os.environ.get('HELIO_TEST_CATEGORY', '').strip())))
            return 0
        if args.action == 'doctor':
            return doctor(home, args.profile)
        if args.action == 'stop':
            return stop(home, args.profile, args.all)
        raise Refused(f'unknown action {args.action}')
    except (Refused, Uncertain, HumanHold) as error:
        print(json.dumps({'state': type(error).__name__.lower(), 'error': str(error)}))
        return error.code
    except Exception as error:  # may follow input, so it is uncertain: inspect with read, never resend
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print(json.dumps({'state': 'error', 'error': f'{type(error).__name__}: {error}', 'at': f'{frame.name}:{frame.lineno}'}))
        return 3


def add_parser(sub):
    qa = sub.add_parser('qa', help='live Elo Beta QA through BrowserSkill')
    qa.add_argument('action', choices=('start', 'run', 'select', 'click', 'form', 'read', 'where', 'doctor', 'stop'))
    qa.add_argument('target', nargs='*', help='run: the command; where: channel IDs')
    qa.add_argument('--profile', default='qa-a', choices=QA)
    qa.add_argument('--channel')
    qa.add_argument('--opt', action='append', help='run: name=value (repeatable)')
    qa.add_argument('--message'); qa.add_argument('--menu'); qa.add_argument('--option'); qa.add_argument('--button')
    qa.add_argument('--field', action='append', help='form: "Label=value" (repeatable)')
    qa.add_argument('--submit', default='Submit')
    qa.add_argument('--timeout', type=int, default=30)
    qa.add_argument('--screenshot')
    qa.add_argument('--all', action='store_true')
    return qa
