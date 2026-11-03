"""Copy owner-controlled environment and authorization files into the isolated runtime.

Shared by the root launcher (every start) and the root admin tool (deploy). Runs as root.
"""
import grp, json, os, pwd, re, secrets, stat, sys, tempfile
from pathlib import Path

# Helio controls its home, so root must never follow a link there: every component is opened
# with O_NOFOLLOW and files are replaced by name inside that directory handle.


def agent_dir(HOME, rel):
    fd = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(rel).parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd); raise


def write_agent_file(HOME, account, rel, data, mode=0o600, mtime=None):
    parent, name = os.path.split(rel)
    fd = agent_dir(HOME, parent); tmp = f'.{name}-{secrets.token_hex(6)}'
    try:
        out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            os.fchown(out, account.pw_uid, account.pw_gid); os.fchmod(out, mode)
            view = memoryview(data)
            while view:
                view = view[os.write(out, view):]
            if mtime is not None:
                os.utime(out, (mtime, mtime))
            os.fsync(out)
        finally:
            os.close(out)
        os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
    except BaseException:
        try: os.unlink(tmp, dir_fd=fd)
        except FileNotFoundError: pass
        raise
    finally:
        os.close(fd)


def read_agent_file(HOME, rel):
    """Regular file contents, or None when missing, a link, or not a regular file (a FIFO would block)."""
    parent, name = os.path.split(rel)
    try:
        fd = agent_dir(HOME, parent)
    except OSError:
        return None
    try:
        handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except OSError:
        return None
    finally:
        os.close(fd)
    with os.fdopen(handle, 'rb') as stream:
        return stream.read() if stat.S_ISREG(os.fstat(handle).st_mode) else None


def refresh(HOME, account):
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
        write_agent_file(HOME,account,'.dori/elobot/'+name,path.read_bytes())
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

