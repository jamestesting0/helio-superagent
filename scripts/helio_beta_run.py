#!/usr/bin/env python3
"""Start beta with the scoped environment; never source a production .env."""
import ast,os,pwd,runpy,stat
from pathlib import Path
from dotenv import dotenv_values

class RunError(Exception):pass

def prepare(home: Path, cwd: Path, broker_ok: bool, uid: int):
    try:agent=pwd.getpwnam('helio-agent')
    except KeyError:raise RunError('isolated account unavailable') from None
    if uid!=agent.pw_uid or not broker_ok:raise RunError('beta launch requires the isolated runtime and protected service')
    project=(home/'PythonProjects/elo-bot').resolve()
    worktrees=(home/'.dori/elobot/state/worktrees').resolve()
    cwd=cwd.resolve()
    if not (cwd==project or cwd.is_relative_to(worktrees)):
        raise RunError('start beta only from the isolated checkout or a Helio worktree')
    script=cwd/'beta.py'
    if not script.is_file():raise RunError('beta.py is missing in this checkout')
    tree=ast.parse(script.read_text(encoding='utf-8'))
    values=[node.value for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='BETA_SYNC_FROM_MAIN' for t in node.targets)]
    if len(values)!=1 or not isinstance(values[0],ast.Constant) or values[0].value is not False:
        raise RunError('beta-to-main synchronization must be explicitly disabled')
    beta=home/'.dori/elobot/beta.env';mongo=home/'.dori/elobot/beta-mongo.env'
    for path in (beta,mongo):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_mode&0o077:raise RunError('beta environment permissions are unsafe')
    settings=dotenv_values(beta);restricted=dotenv_values(mongo).get('MONGO_DB_URL')
    if not restricted or settings.get('MONGO_DB_URL')!=restricted or not settings.get('BOT_BETA_TOKEN') or settings.get('BOT_MAIN_TOKEN'):
        raise RunError('beta environment does not match the restricted credential or beta identity')
    python=project/'.venv/bin/python'
    if not python.is_file() or not os.access(python,os.X_OK):raise RunError('isolated beta Python is unavailable')
    env=dict(os.environ)
    for name in ('BOT_MAIN_TOKEN','MONGO_DB_URL','DORI_DISCORD_TOKEN'):
        env.pop(name,None)
    env.update({k:v for k,v in settings.items() if v is not None and k not in ('BOT_MAIN_TOKEN','DORI_DISCORD_TOKEN')})
    env['PYTHONUNBUFFERED']='1'
    return str(python),str(script),env

def start(home: Path,check=False):
    client=runpy.run_path(str(Path(__file__).with_name('helio_beta_client.py')))
    python,script,env=prepare(home,Path.cwd(),client['healthy'](),os.getuid())
    if check:
        print('Beta launch configuration: isolated account, beta identity and scoped credential verified; bot not started.')
        return 0
    os.execve(python,[python,'-u',script],env)
