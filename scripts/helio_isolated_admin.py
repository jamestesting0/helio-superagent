#!/usr/bin/env python3
"""Root admin for the isolated runtime: deploy, restart the lead, status and doctor.

    helio_isolated_admin.py deploy [--restart] | restart | status | doctor [--json]

Unlike the launcher it never builds the networked sandbox or touches the firewall, so it is safe
while Helio runs. Deploy copies the owner's kit checkout into the isolated home, refreshes the
owner's environment and permission files, applies the managed update in an offline sandbox, and
reports what the change needs (nothing, monitor self-restart, lead restart or full start).
"""
import datetime, fcntl, hashlib, json, os, pwd, runpy, stat, subprocess, sys, tarfile, tempfile, time
from pathlib import Path

HOME = '/var/lib/helio-agent/home'
SOURCE = '/home/james/PythonProjects/helio-superagent'
BACKUPS = Path('/var/lib/helio-agent-backups/deploys')
STAGE = Path('/var/lib/helio-agent-deploy/kit')
POLICY_FILES = ('trusted-users', 'release-approvers', 'report-channels')
EXCLUDES = ('.git', 'memory/', 'node_modules', '__pycache__', '.ruff_cache', '.omo')
HERE = Path(__file__).resolve().parent
STATE = '.dori/elobot/deploy-state.json'
SAFE = runpy.run_path(str(HERE / 'helio_owner_policy.py'))
if os.geteuid() != 0:
    raise SystemExit('Helio admin requires root')
account = pwd.getpwnam('helio-agent')
uid, gid = str(account.pw_uid), str(account.pw_gid)
AS_AGENT = ['setpriv', '--reuid', uid, '--regid', gid, '--clear-groups', '--no-new-privs']
AS_OWNER = ['setpriv', '--reuid', 'james', '--regid', 'james', '--init-groups', '--no-new-privs']


def run(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, timeout=kw.pop('timeout', 300), **kw)


def running():
    return run(['systemctl', 'is-active', '--quiet', 'helio-isolated.scope']).returncode == 0


def herdr(*args, timeout=15):
    result = run([*AS_AGENT, 'env', f'HOME={HOME}', 'HERDR_SESSION=elobot',
                  f'{HOME}/.local/bin/herdr', '--session', 'elobot', *args], timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'herdr {" ".join(args[:2])} failed: {(result.stderr or result.stdout).strip()[-200:]}')
    return result.stdout


def read_state() -> dict:
    try:
        return json.loads(SAFE['read_agent_file'](HOME, STATE) or b'{}')
    except ValueError:
        return {}


def source_version():
    git = [*AS_OWNER, 'git', '-C', SOURCE]
    commit = run([*git, 'rev-parse', '--short', 'HEAD']).stdout.strip() or 'unknown'
    dirty = bool(run([*git, 'status', '--porcelain']).stdout.strip())
    return commit, dirty


def backup():
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = BACKUPS / f'deploy-{datetime.datetime.now():%Y%m%d-%H%M%S}.tar.gz'
    def keep(info):
        parts = Path(info.name).parts
        return None if {'node_modules', '.git'} & set(parts) or parts[:3] == ('.dori', 'elobot', 'state') else info
    with tempfile.TemporaryDirectory(prefix='helio-state-', dir=HOME) as temporary:
        os.chown(temporary, account.pw_uid, account.pw_gid)
        saved = Path(temporary) / 'state'
        result = run([*AS_AGENT, '/usr/bin/python3', str(HERE / 'helio_state_backup.py'),
                      '--state', str(Path(HOME, '.dori/elobot/state')), '--destination', str(saved)])
        if result.returncode:
            raise RuntimeError('state snapshot failed: ' + result.stderr.strip()[-300:])
        with tarfile.open(target, 'w:gz') as tar:
            for rel in ('helio-agent', '.dori/elobot', '.dori/discord-inbound', '.local/bin/helio'):
                if not os.path.realpath(Path(HOME, rel)).startswith(HOME + '/') or os.path.islink(Path(HOME, rel)):
                    continue
                if os.path.lexists(Path(HOME, rel)):
                    tar.add(Path(HOME, rel), arcname=rel, filter=keep)
            tar.add(saved, arcname='.dori/elobot/state')
    for old in sorted(BACKUPS.glob('deploy-*.tar.gz'))[:-3]:
        old.unlink()
    return target


def offline_sync(policy: Path) -> str:
    binds = []
    for name in POLICY_FILES:
        binds += ['--ro-bind', str(policy / name), f'/home/james/.dori/elobot/{name}']
    cmd = [*AS_AGENT, 'bwrap', '--unshare-all', '--die-with-parent',
           '--clearenv', '--setenv', 'HOME', '/home/james', '--setenv', 'PATH', '/home/james/.bun/bin:/home/james/.local/bin:/usr/bin:/bin',
           '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
           '--dir', '/etc', '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group',
           '--dir', '/home', '--bind', HOME, '/home/james', *binds, '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
           '--chdir', '/home/james', '/usr/bin/python3', '/home/james/helio-agent/scripts/sync-install.py', '--apply', '--update-launcher']
    result = run(cmd)
    if result.returncode:
        raise RuntimeError('managed update refused:\n' + (result.stdout + result.stderr).strip()[-1500:])
    return result.stdout


def ensure_node():
    """Give the sandbox the owner's default Node (nvm) so omo extensions that need Node 24 work."""
    nvm = Path('/home/james/.nvm')
    alias = (nvm / 'alias/default').read_text().strip().lstrip('v') if (nvm / 'alias/default').is_file() else ''
    version = lambda p: [int(x) for x in p.parts[-3][1:].split('.')]
    candidates = sorted(nvm.glob(f'versions/node/v{alias}*/bin/node'), key=version) or sorted(nvm.glob('versions/node/v*/bin/node'), key=version)
    if not candidates:
        return None
    source = candidates[-1]
    fd = SAFE['agent_dir'](HOME, '.local/bin')
    try:
        current = os.stat('node', dir_fd=fd, follow_symlinks=False)
        same = stat.S_ISREG(current.st_mode) and current.st_size == source.stat().st_size and int(current.st_mtime) == int(source.stat().st_mtime)
    except FileNotFoundError:
        same = False
    finally:
        os.close(fd)
    if not same:
        SAFE['write_agent_file'](HOME, account, '.local/bin/node', source.read_bytes(), 0o755, source.stat().st_mtime)
    return source.parts[-3]


def deploy(restart_after: bool) -> int:
    plan = runpy.run_path(str(HERE / 'helio_deploy_plan.py'))
    commit, dirty = source_version()
    archive = backup()
    env_digest = lambda: hashlib.sha256(SAFE['read_agent_file'](HOME, '.dori/elobot/env') or b'').hexdigest()
    before = env_digest()
    excludes = [f'--exclude={x}' for x in EXCLUDES]
    STAGE.parent.mkdir(mode=0o755, exist_ok=True); STAGE.mkdir(mode=0o755, exist_ok=True)
    # Root only reads your checkout into a root-owned staging copy; Helio's own user writes it into its home.
    staged = run(['rsync', '-a', '--delete', '--no-owner', '--no-group', '--chmod=D755,Fu+rw,Fgo+r,Fgo-w', *excludes, f'{SOURCE}/', f'{STAGE}/'])
    copied = staged if staged.returncode else run([*AS_AGENT, 'rsync', '-ai', '--delete', '--no-owner', '--no-group', *excludes, f'{STAGE}/', f'{HOME}/helio-agent/'])
    if copied.returncode:
        raise RuntimeError('copy failed: ' + copied.stderr.strip()[-300:])
    kit = plan['rsync_changes'](copied.stdout)
    policy = SAFE['refresh'](HOME, account)
    installed = plan['managed_changes'](offline_sync(policy))
    after = env_digest()
    node = ensure_node()
    outcome = plan['plan'](kit, installed, before != after)
    previous = read_state()
    version = commit + ('+local changes' if dirty else '')
    state = {
        'version': version, 'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'needs': outcome['needs'], 'changed': outcome['changed'][:60],
        'lead_restart_pending': previous.get('lead_restart_pending', False) or outcome['needs'] in ('lead', 'full'),
        'full_restart_pending': previous.get('full_restart_pending', False) or outcome['needs'] == 'full',
        'lead_version': previous.get('lead_version'),
    }
    SAFE['write_agent_file'](HOME, account, STATE, (json.dumps(state, indent=2) + '\n').encode(), 0o644)
    if outcome['monitors_changed']:
        SAFE['write_agent_file'](HOME, account, '.dori/elobot/monitors-version', f'{version} {state["deployed_at"]}\n'.encode(), 0o644)
    live = running()
    print(f'Deployed {version} ({len(outcome["changed"])} changed files; backup {archive.name}; node {node or "not found"}).')
    print(plan['ADVICE'][outcome['needs']])
    if not live:
        print('Helio is not running; everything loads on the next `helio start`.')
    elif restart_after and state['lead_restart_pending'] and not state['full_restart_pending']:
        return restart()
    elif state['full_restart_pending'] and outcome['needs'] != 'full':
        print('A full restart from an earlier deploy is still pending: stop Helio and run `helio start`.')
    elif state['lead_restart_pending'] and outcome['needs'] not in ('lead', 'full'):
        print('A lead restart from an earlier deploy is still pending: run `helio restart`.')
    return 0


def restart() -> int:
    if not running():
        print('Helio is not running; use `helio start`.')
        return 1
    began = time.monotonic()
    for tab in json.loads(herdr('tab', 'list'))['result']['tabs']:
        if tab.get('label') == 'Helio':
            herdr('tab', 'close', tab['tab_id'])
    pane = json.loads(herdr('tab', 'create', '--cwd', '/home/james/PythonProjects/elo-bot', '--label', 'Helio', '--focus'))['result']['root_pane']['pane_id']
    time.sleep(3)  # a freshly created shell drops input typed before its prompt is ready
    herdr('pane', 'run', pane, 'helio start')
    print(f'Restarted the Helio lead in {time.monotonic() - began:.0f}s; sandbox, network, lanes and beta kept running. '
          'It re-arms its monitors and greets you when ready.')
    return 0


def status() -> int:
    state = read_state()
    commit, dirty = source_version()
    print(f'Repo checkout: {commit}{" +local changes" if dirty else ""}')
    print(f'Isolated runtime: {state.get("version", "unknown (deploy once with `helio deploy`)")}'
          + (f', deployed {state["deployed_at"]}' if state.get('deployed_at') else ''))
    print(f'Lead running: {state.get("lead_version") or "unknown"}')
    pending = 'full start' if state.get('full_restart_pending') else 'lead restart' if state.get('lead_restart_pending') else 'nothing'
    print(f'Restart pending: {pending}')
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args in (['doctor'], ['doctor', '--json']):
        result = run([*AS_AGENT, '/usr/bin/python3', '-I', str(HERE / 'helio_doctor.py'),
                      '--home', HOME, '--runtime-home', '/home/james', *args[1:]], timeout=30)
        print(result.stdout, end='')
        if result.stderr:
            print(result.stderr, file=sys.stderr, end='')
        return result.returncode
    lock = open('/run/helio-isolated-admin.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX)  # one deploy or restart at a time; a second one waits
    try:
        if args in (['deploy'], ['deploy', '--restart']):
            return deploy('--restart' in args)
        if args == ['restart']:
            return restart()
        if args == ['status']:
            return status()
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('HELIO_ADMIN_ERROR:', error, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
