#!/usr/bin/env python3
"""Root admin for the isolated runtime: deploy, restart the lead, status and doctor.

    helio_isolated_admin.py deploy [--restart] | restart | status | doctor [--json]

Unlike the launcher it never builds the networked sandbox or touches the firewall, so it is safe
while Helio runs. Deploy copies the owner's kit checkout into the isolated home, refreshes the
owner's environment and permission files, applies the managed update in an offline sandbox, and
reports what the change needs (nothing, monitor self-restart, lead restart or full start).
"""
import datetime, fcntl, hashlib, json, os, pwd, runpy, stat, subprocess, sys, tarfile, tempfile, time
from dataclasses import asdict
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


def restart_state(state: dict) -> dict:
    receipts = {}
    for name in ('lead', 'full'):
        try:
            receipts[name] = json.loads(SAFE['read_agent_file'](HOME, f'.dori/elobot/state/{name}-start.json') or b'{}')
        except ValueError:
            receipts[name] = {}
    return runpy.run_path(str(HERE / 'helio_deploy_plan.py'))['restart_state'](state, receipts['lead'], receipts['full'])


def source_version():
    commit, changed = source_status()
    return commit, bool(changed)


def source_status() -> tuple[str, int]:
    git = [*AS_OWNER, 'git', '-C', SOURCE]
    commit = run([*git, 'rev-parse', '--short', 'HEAD']).stdout.strip() or 'unknown'
    return commit, len(run([*git, 'status', '--porcelain']).stdout.splitlines())


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
    binds = ['--ro-bind', str(policy), '/home/james/.dori/elobot/policy']
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


def prepare_dependencies():
    """Transfer only the staged lockfile's cache entries; the offline updater never fetches."""
    version = hashlib.sha256((STAGE / 'discord-inbound/bun.lock').read_bytes()).hexdigest().encode()
    marker = '.dori/elobot/dependency-cache-version'
    if SAFE['read_agent_file'](HOME, marker) == version:
        return
    owner = pwd.getpwnam('james')
    with tempfile.TemporaryDirectory(prefix='dependencies-', dir=STAGE.parent) as temporary:
        os.chown(temporary, owner.pw_uid, owner.pw_gid)
        os.chmod(temporary, 0o755)
        archive = Path(temporary) / 'cache.pack'
        packed = run([*AS_OWNER, 'env', f'HOME={owner.pw_dir}', f'{owner.pw_dir}/.bun/bin/bun',
                      'pm', 'cache', 'pack', str(archive)], cwd=STAGE / 'discord-inbound', timeout=300)
        if packed.returncode:
            raise RuntimeError('Dependency cache is incomplete; run bun install --frozen-lockfile in the owner inbound checkout:\n' +
                               (packed.stdout + packed.stderr).strip()[-1000:])
        archive.chmod(0o644)
        unpacked = run([*AS_AGENT, 'env', f'HOME={HOME}',
                        f'BUN_INSTALL_CACHE_DIR={HOME}/.bun/install/cache', f'{HOME}/.bun/bin/bun',
                        'pm', 'cache', 'unpack', str(archive)], cwd=Path(HOME, 'helio-agent/discord-inbound'), timeout=300)
        if unpacked.returncode:
            raise RuntimeError('Isolated dependency cache transfer failed:\n' + (unpacked.stdout + unpacked.stderr).strip()[-1000:])
    SAFE['write_agent_file'](HOME, account, marker, version, 0o644)


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
    prepare_dependencies()
    policy = SAFE['refresh'](HOME, account)
    installed = plan['managed_changes'](offline_sync(policy))
    administration = None
    if Path('/opt/helio-admin-service/controller.js').is_file():
        administration = runpy.run_path(str(HERE / 'helio_admin_install.py'))['install_controller'](
            Path('/home/james/.dori/discord-inbound'), True)
    admin_running = runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['status']()
    after = env_digest()
    node = ensure_node()
    outcome = plan['plan'](kit, installed, before != after)
    previous = read_state()
    current = restart_state(previous)
    version = commit + ('+local changes' if dirty else '')
    deployed_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    since = lambda kind: (previous.get(f'{kind}_restart_since') or previous.get('deployed_at')) if current[f'{kind}_restart_pending'] else deployed_at
    lead_pending = current['lead_restart_pending'] or outcome['needs'] in ('lead', 'full')
    full_pending = current['full_restart_pending'] or outcome['needs'] == 'full'
    state = {
        'version': version, 'deployed_at': deployed_at,
        'needs': outcome['needs'], 'changed': outcome['changed'][:60],
        'lead_restart_pending': lead_pending, 'lead_restart_since': since('lead') if lead_pending else None,
        'full_restart_pending': full_pending, 'full_restart_since': since('full') if full_pending else None,
        'lead_version': current['lead_version'],
        'admin_controller_version': administration['controller_sha256'] if administration else None,
        'admin_controller_restart_pending': bool(administration and admin_running.loaded_version != administration['controller_sha256']),
    }
    SAFE['write_agent_file'](HOME, account, STATE, (json.dumps(state, indent=2) + '\n').encode(), 0o644)
    if outcome['monitors_changed']:
        SAFE['write_agent_file'](HOME, account, '.dori/elobot/monitors-version', f'{version} {state["deployed_at"]}\n'.encode(), 0o644)
    live = running()
    print(f'Deployed {version} ({len(outcome["changed"])} changed files; backup {archive.name}; node {node or "not found"}).')
    print(plan['ADVICE'][outcome['needs']])
    print('Administration controller: ' + ('activation pending' if state['admin_controller_restart_pending'] else 'unchanged'))
    if restart_after:
        runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['report'](True)
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
    runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['report'](True)
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
    state.update(restart_state(state))
    commit, dirty = source_version()
    print(f'Repo checkout: {commit}{" +local changes" if dirty else ""}')
    print(f'Isolated runtime: {state.get("version", "unknown (deploy once with `helio deploy`)")}'
          + (f', deployed {state["deployed_at"]}' if state.get('deployed_at') else ''))
    print(f'Lead running: {state.get("lead_version") or "unknown"}')
    pending = 'full start' if state.get('full_restart_pending') else 'lead restart' if state.get('lead_restart_pending') else 'nothing'
    print(f'Restart pending: {pending}')
    administration = runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['status']()
    print('ADMINISTRATION ' + json.dumps(asdict(administration), sort_keys=True))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args == ['commands-sync']:
        runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['report']()
        return 0
    if args == ['commands-status']:
        administration = runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['status']()
        print('ADMINISTRATION ' + json.dumps(asdict(administration), sort_keys=True))
        return 0
    if args in (['doctor'], ['doctor', '--json']):
        result = run([*AS_AGENT, '/usr/bin/python3', '-I', str(HERE / 'helio_doctor.py'),
                      '--home', HOME, '--runtime-home', '/home/james', *args[1:]], timeout=30)
        administration = asdict(runpy.run_path(str(HERE / 'helio_admin_lifecycle.py'))['status']())
        commit, changed = source_status()
        deployed = read_state().get('deployed_at')
        hours = None
        if deployed:
            hours = round((datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(deployed)).total_seconds() / 3600, 1)
        source = {'commit': commit, 'uncommitted_files': changed, 'hours_since_deploy': hours}
        if '--json' in args:
            report = json.loads(result.stdout)
            report['administration'] = administration
            report['source'] = source
            print(json.dumps(report))
        else:
            print(result.stdout, end='')
            print('administration: ' + json.dumps(administration, sort_keys=True))
            print('source: ' + json.dumps(source, sort_keys=True))
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
