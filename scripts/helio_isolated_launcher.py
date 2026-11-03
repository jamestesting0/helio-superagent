#!/usr/bin/env python3
"""Root-owned launcher for Helio's isolated WSL runtime.

Only invoke from the root-owned helio-isolated systemd scope. Firewall rules
are installed before any unprivileged process is started and remain restrictive
if this supervisor is killed abruptly.
"""
import fcntl, grp, json, os, pty, pwd, re, select, signal, socket, stat, struct, subprocess, sys, tempfile, termios, tty
from pathlib import Path

SCOPE='/system.slice/helio-isolated.scope'
CHAIN='HELIO_AGENT_EGRESS'
HOME='/var/lib/helio-agent/home'
if os.geteuid()!=0:raise SystemExit('Helio isolation launcher requires root')
if not any(line.split(':',2)==['0','',SCOPE] for line in Path('/proc/self/cgroup').read_text().splitlines()):
    raise SystemExit('Helio isolation launcher requires the dedicated systemd scope')
account=pwd.getpwnam('helio-agent');uid=str(account.pw_uid);gid=str(account.pw_gid)
def fw(binary,*args,check=True):
    return subprocess.run([binary,'-w',*args],check=check,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
if fw('iptables','-S',CHAIN,check=False).returncode==0:raise SystemExit('Existing Helio firewall chain needs inspection before startup')
if subprocess.run(['pgrep','-u',uid],stdout=subprocess.DEVNULL).returncode==0:raise SystemExit('The dedicated Helio account already has processes')
if not Path(HOME).is_dir() or Path(HOME).stat().st_uid!=account.pw_uid:raise SystemExit('Isolated home is not provisioned')

def refresh_owner_policy():
    """Copy owner-controlled authorization files into root-protected mounts."""
    sys.path.insert(0,'/opt/helio-beta-service/packages')
    from dotenv import dotenv_values
    owner=pwd.getpwnam('james');base=Path('/home/james/.dori/elobot')
    source=base/'env';info=source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner.pw_uid or info.st_mode&0o077:raise RuntimeError('Owner environment permissions are unsafe')
    values=dotenv_values(source);token=values.get('DORI_DISCORD_TOKEN','');owner_id=values.get('DORI_DISCORD_OWNER_ID','')
    allowed=[x.strip() for x in values.get('DORI_DISCORD_ALLOWED','').split(',') if x.strip()]
    service_uri=dotenv_values('/etc/helio-beta-service/credential.env').get('MONGO_DB_URL')
    for name in ('env','beta.env','beta-mongo.env'):
        path=base/name;info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner.pw_uid or info.st_mode&0o077:raise RuntimeError('Owner environment file permissions are unsafe')
        if name!='env' and (not service_uri or dotenv_values(path).get('MONGO_DB_URL')!=service_uri):raise RuntimeError('Beta credential differs from the protected service; update the service before launch')
        target=Path(HOME)/'.dori/elobot'/name
        fd,tmp=tempfile.mkstemp(prefix='.'+name+'-',dir=target.parent)
        try:
            os.fchown(fd,account.pw_uid,account.pw_gid);os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb') as stream:stream.write(path.read_bytes());stream.flush();os.fsync(stream.fileno())
            os.replace(tmp,target)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
    policy=Path('/var/lib/helio-runtime-policy');policy.mkdir(mode=0o755,exist_ok=True)
    info=policy.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Policy directory permissions are unsafe')
    lists={}
    for name in ('trusted-users','release-approvers','report-channels'):
        path=base/name;info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner.pw_uid or info.st_mode&0o022:raise RuntimeError('Owner authorization file permissions are unsafe')
        content=path.read_text();items=[x.strip() for x in content.split(',') if x.strip()]
        if any(not re.fullmatch(r'\d{5,30}',x) for x in items):raise RuntimeError('Owner authorization file contains invalid IDs')
        lists[name]=items
        fd,tmp=tempfile.mkstemp(prefix='.'+name+'-',dir=policy)
        try:
            os.fchmod(fd,0o644)
            with os.fdopen(fd,'w') as stream:stream.write(','.join(items)+'\n');stream.flush();os.fsync(stream.fileno())
            os.replace(tmp,policy/name)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
    if not token or not re.fullmatch(r'\d{5,30}',owner_id) or any(not re.fullmatch(r'\d{5,30}',x) for x in allowed):raise RuntimeError('Owner Discord configuration is invalid')
    directory=Path('/etc/helio-release-service');release_gid=grp.getgrnam('helio-release').gr_gid
    fd,tmp=tempfile.mkstemp(prefix='.auth-',dir=directory)
    try:
        os.fchown(fd,0,release_gid);os.fchmod(fd,0o640)
        with os.fdopen(fd,'w') as stream:
            json.dump({'token':token,'owner':owner_id,'trusted':lists['trusted-users'],'allowed':allowed},stream)
            stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,directory/'auth.json')
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
    return policy

def wait_byte(fd,proc,seconds=20):
    ready,_,_=select.select([fd],[],[],seconds)
    if not ready:raise RuntimeError('Sandbox setup timed out')
    if not os.read(fd,1):raise RuntimeError('Sandbox network failed to start')

def info_json(fd,seconds=20):
    result=b''
    while len(result)<65536:
        ready,_,_=select.select([fd],[],[],seconds)
        if not ready:raise RuntimeError('Sandbox setup timed out')
        part=os.read(fd,4096)
        if not part:raise RuntimeError('Sandbox failed to report its PID')
        result+=part
        try:return json.loads(result)
        except json.JSONDecodeError:pass
    raise RuntimeError('Invalid sandbox setup response')

def dimensions(master):
    try:
        size=fcntl.ioctl(sys.stdin.fileno(),termios.TIOCGWINSZ,b'\0'*8)
        fcntl.ioctl(master,termios.TIOCSWINSZ,size)
    except (OSError,ValueError):pass

def relay(master,proc):
    stdin=sys.stdin.fileno();stdout=sys.stdout.fileno();saved=None
    if os.isatty(stdin):saved=termios.tcgetattr(stdin);tty.setraw(stdin)
    dimensions(master)
    old_winch=signal.getsignal(signal.SIGWINCH)
    signal.signal(signal.SIGWINCH,lambda *_:dimensions(master))
    try:
        while proc.poll() is None:
            inputs=[master]
            if stdin is not None:inputs.append(stdin)
            ready,_,_=select.select(inputs,[],[],.2)
            if master in ready:
                try:data=os.read(master,65536)
                except OSError:break
                if not data:break
                os.write(stdout,data)
            if stdin is not None and stdin in ready:
                data=os.read(stdin,65536)
                if data:os.write(master,data)
                else:stdin=None
        while select.select([master],[],[],0)[0]:
            try:data=os.read(master,65536)
            except OSError:break
            if not data:break
            os.write(stdout,data)
    finally:
        signal.signal(signal.SIGWINCH,old_winch)
        if saved is not None:termios.tcsetattr(sys.stdin.fileno(),termios.TCSADRAIN,saved)

def child_tty():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)

made=hooked=v6=False
sandbox=network=None; master=slave=None
old_term=signal.getsignal(signal.SIGTERM)
old_hup=signal.getsignal(signal.SIGHUP)
def interrupted(*_):raise KeyboardInterrupt
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGHUP,interrupted)
try:
    policy=refresh_owner_policy()
    fw('iptables','-N',CHAIN);made=True
    fw('iptables','-A',CHAIN,'-m','addrtype','--dst-type','LOCAL','-j','REJECT')
    for net in ('0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','198.18.0.0/15','224.0.0.0/4','240.0.0.0/4'):
        fw('iptables','-A',CHAIN,'-d',net,'-j','REJECT')
    fw('iptables','-A',CHAIN,'-j','RETURN')
    fw('iptables','-I','OUTPUT','1','-m','owner','--uid-owner',uid,'-j',CHAIN);hooked=True
    fw('ip6tables','-I','OUTPUT','1','-m','owner','--uid-owner',uid,'-j','REJECT');v6=True
    with tempfile.TemporaryDirectory(prefix='helio-sandbox-',dir='/run') as control:
        os.chown(control,account.pw_uid,account.pw_gid);os.chmod(control,0o700)
        dns=Path(control,'resolv.conf');dns.write_text('nameserver 1.1.1.1\noptions timeout:2 attempts:1\n');os.chown(dns,account.pw_uid,account.pw_gid)
        check=Path(control,'check.py');check.write_text('''import os,socket,subprocess\nfrom pathlib import Path\nassert os.getuid()==999\nassert not Path("/home/james/PythonProjects/elo-bot/.env").exists()\nassert not Path("/home/james/.ssh").exists()\nassert not Path("/mnt/c/Windows/System32/wsl.exe").exists()\ns=socket.socket(socket.AF_UNIX);s.connect("/run/helio-beta-service/maintenance.sock");s.close()\nassert subprocess.run(["/home/james/PythonProjects/elo-bot/.venv/bin/python","--version"],stdout=subprocess.DEVNULL).returncode==0\nassert subprocess.run(["/home/james/.bun/bin/omo","--version"],stdout=subprocess.DEVNULL).returncode==0\nsocket.getaddrinfo("github.com",443)\nprint("Isolated runtime basic checks passed.")\n''');os.chown(check,account.pw_uid,account.pw_gid)
        info_r,info_w=os.pipe()
        if '--connectivity-check' in sys.argv[1:]:
            command=['/home/james/PythonProjects/elo-bot/.venv/bin/python','/home/james/.cache/test_isolated_connectivity.py']
        elif '--suite-check' in sys.argv[1:]:
            command=['/home/james/.bun/bin/bun','test','/home/james/helio-agent/vendor/dori-mode/scripts/test/helio-lifecycle.test.ts','/home/james/helio-agent/vendor/dori-mode/scripts/test/helio-model.test.ts']
        elif '--sync-check' in sys.argv[1:]:
            command=['/usr/bin/python3','/home/james/helio-agent/scripts/sync-install.py','--apply']
        elif '--worker-check' in sys.argv[1:]:
            command=['/home/james/PythonProjects/elo-bot/.venv/bin/python','/home/james/.cache/test_isolated_worker.py']
        elif '--model-check' in sys.argv[1:]:
            command=['/home/james/PythonProjects/elo-bot/.venv/bin/python','/home/james/.cache/test_isolated_model.py']
        elif '--integration-check' in sys.argv[1:]:
            command=['/home/james/PythonProjects/elo-bot/.venv/bin/python','/home/james/.cache/test_sandbox_client.py']
        elif '--check' in sys.argv[1:]:
            command=['/usr/bin/python3','/control/check.py']
        else:
            mode='start' if '--start' in sys.argv[1:] else ('resume' if '--resume' in sys.argv[1:] else 'shell')
            command=['/usr/bin/python3','/home/james/helio-agent/scripts/helio_isolated_start.py',mode]
        cmd=['setpriv','--reuid',uid,'--regid',gid,'--clear-groups','--no-new-privs','bwrap',
             '--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-net','--unshare-cgroup-try','--die-with-parent','--info-fd',str(info_w),
             '--clearenv','--setenv','HOME','/home/james','--setenv','USER','helio-agent','--setenv','LOGNAME','helio-agent','--setenv','SHELL','/bin/bash',
             '--setenv','TERM',os.environ.get('TERM','xterm-256color'),'--setenv','PATH','/home/james/.bun/bin:/home/james/.local/bin:/usr/bin:/bin',
             '--setenv','XDG_RUNTIME_DIR','/run/user/'+uid,'--setenv','WAYLAND_DISPLAY','wayland-0',
             '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
             '--dir','/etc','--ro-bind','/etc/ssl','/etc/ssl','--ro-bind','/etc/fonts','/etc/fonts','--ro-bind','/etc/machine-id','/etc/machine-id','--ro-bind','/etc/hosts','/etc/hosts','--ro-bind','/etc/nsswitch.conf','/etc/nsswitch.conf','--ro-bind','/etc/passwd','/etc/passwd','--ro-bind','/etc/group','/etc/group','--ro-bind',str(dns),'/etc/resolv.conf',
             '--dir','/home','--bind',HOME,'/home/james','--dir','/mnt','--dir','/run','--dir','/run/user','--dir','/run/user/'+uid,'--chmod','0700','/run/user/'+uid,
             '--ro-bind','/mnt/wslg/runtime-dir/wayland-0','/run/user/'+uid+'/wayland-0','--dir','/run/helio-beta-service','--ro-bind','/run/helio-beta-service/maintenance.sock','/run/helio-beta-service/maintenance.sock',
             '--dir','/run/helio-release-service','--ro-bind','/run/helio-release-service/release.sock','/run/helio-release-service/release.sock',
             '--ro-bind',str(policy/'trusted-users'),'/home/james/.dori/elobot/trusted-users',
             '--ro-bind',str(policy/'release-approvers'),'/home/james/.dori/elobot/release-approvers',
             '--ro-bind',str(policy/'report-channels'),'/home/james/.dori/elobot/report-channels',
             '--tmpfs','/tmp','--proc','/proc','--dev','/dev','--bind',control,'/control','--chdir','/home/james/PythonProjects/elo-bot',
             '--','/bin/sh','-c','while [ ! -f /control/ready ]; do sleep 0.1; done; exec "$@"','helio',*command]
        interactive=not any(x in sys.argv[1:] for x in ('--check','--integration-check','--model-check','--worker-check','--sync-check','--suite-check','--connectivity-check'))
        if interactive:
            if not os.isatty(sys.stdin.fileno()):raise RuntimeError('Interactive Helio needs a terminal')
            master,slave=pty.openpty()
            sandbox=subprocess.Popen(cmd,pass_fds=(info_w,),stdin=slave,stdout=slave,stderr=slave,preexec_fn=child_tty)
            os.close(slave);slave=None
        else:
            sandbox=subprocess.Popen(cmd,pass_fds=(info_w,),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        os.close(info_w)
        try:info=info_json(info_r)
        finally:os.close(info_r)
        ready_r,ready_w=os.pipe()
        network=subprocess.Popen(['setpriv','--reuid',uid,'--regid',gid,'--clear-groups','--no-new-privs','slirp4netns','--configure','--disable-host-loopback','--ready-fd',str(ready_w),str(info['child-pid']),'tap0'],pass_fds=(ready_w,),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        os.close(ready_w)
        try:wait_byte(ready_r,network)
        finally:os.close(ready_r)
        Path(control,'ready').touch()
        if interactive:relay(master,sandbox);code=sandbox.wait(timeout=15)
        else:
            out,err=sandbox.communicate(timeout=120)
            if out:print(out,end='')
            if sandbox.returncode and err:print(err,file=sys.stderr,end='')
            code=sandbox.returncode
        sys.exit(code or 0)
except (OSError,RuntimeError,subprocess.SubprocessError) as error:
    print('HELIO_ISOLATION_ERROR:',str(error),file=sys.stderr);sys.exit(1)
except KeyboardInterrupt:
    print('\nHelio isolation stopped.',file=sys.stderr);sys.exit(130)
finally:
    signal.signal(signal.SIGTERM,old_term)
    signal.signal(signal.SIGHUP,old_hup)
    if sandbox is not None and sandbox.poll() is None:
        sandbox.terminate()
        try:sandbox.wait(timeout=5)
        except subprocess.TimeoutExpired:sandbox.kill();sandbox.wait()
    if network is not None and network.poll() is None:
        network.terminate()
        try:network.wait(timeout=5)
        except subprocess.TimeoutExpired:network.kill();network.wait()
    if master is not None:os.close(master)
    if slave is not None:os.close(slave)
    if v6:fw('ip6tables','-D','OUTPUT','-m','owner','--uid-owner',uid,'-j','REJECT',check=False)
    if hooked:fw('iptables','-D','OUTPUT','-m','owner','--uid-owner',uid,'-j',CHAIN,check=False)
    if made:
        fw('iptables','-F',CHAIN,check=False);fw('iptables','-X',CHAIN,check=False)
