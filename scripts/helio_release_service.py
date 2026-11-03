#!/usr/bin/env python3
"""Narrow, Discord-confirmed Oracle restart broker for isolated Helio."""
import argparse, datetime, json, os, re, runpy, socket, sqlite3, stat, struct, subprocess, sys, urllib.error, urllib.request
from pathlib import Path

SCOPE='/system.slice/helio-isolated.scope'
SHA=re.compile(r'^[0-9a-f]{40}$')
ID=re.compile(r'^[0-9]{5,30}$')
MAX_REQUEST=32768
APPROVAL=runpy.run_path(str(Path(__file__).resolve().parent/'helio_approval.py'))

class Refused(Exception):pass

def peer_allowed(pid,uid,required_uid):
    if uid!=required_uid:return False
    try:return any(x.split(':',2)==['0','',SCOPE] for x in Path(f'/proc/{pid}/cgroup').read_text().splitlines())
    except OSError:return False

def get_json(url,token):
    req=urllib.request.Request('https://discord.com/api/v10'+url,headers={'Authorization':'Bot '+token,'User-Agent':'DiscordBot (https://discord.com, 1.0)'})
    try:
        with urllib.request.urlopen(req,timeout=12) as response:return json.load(response)
    except (OSError,ValueError,urllib.error.URLError):raise Refused('Discord verification failed') from None

def verify_confirmation(channel_id,message_id,revision,config,fetch=get_json,now=None,activity=None):
    if not ID.fullmatch(channel_id) or not ID.fullmatch(message_id) or not SHA.fullmatch(revision):raise Refused('invalid confirmation parameters')
    token=config['token']
    message=fetch('/channels/'+channel_id+'/messages/'+message_id,token)
    author=message.get('author',{})
    if message.get('id')!=message_id or message.get('channel_id')!=channel_id or author.get('bot') or message.get('webhook_id'):
        raise Refused('confirmation identity is invalid')
    author_id=author.get('id','')
    if author_id!=config['owner'] and author_id not in config['trusted']:raise Refused('sender is not authorized')
    repo=config.get('repo','jamestesting0/elo-bot')
    bot_id=str(fetch('/users/@me',token).get('id',''))
    try:
        APPROVAL['check_intent']('restart',message,bot_id,repo,None,now=now)
        APPROVAL['check_revision'](revision,message,repo,'main',**({'activity':activity} if activity else {}))
    except APPROVAL['Refused'] as error:raise Refused(str(error)) from None
    current=fetch('/channels/'+channel_id,token)
    if str(current.get('id',''))!=channel_id:raise Refused('channel identity changed')
    permitted=current.get('type')==1
    for _ in range(4):
        if str(current.get('id','')) in config['allowed']:permitted=True;break
        parent=current.get('parent_id')
        if not parent or not ID.fullmatch(str(parent)):break
        current=fetch('/channels/'+str(parent),token)
    if not permitted:raise Refused('confirmation is outside permitted channels')
    return author_id

REMOTE_INSPECT=r'''import json,os,re,subprocess
def r(*a):
 try:
  p=subprocess.run(a,capture_output=True,text=True,timeout=25)
  return p.returncode,p.stdout
 except Exception:return 1,''
try:
 with open('/opt/elobot/config.json') as f:c=json.load(f)
except Exception:print(json.dumps({'ok':False}));raise SystemExit
git=('git','-c','safe.directory=/opt/elobot','-C','/opt/elobot')
sc,status=r(*git,'status','--porcelain','--untracked-files=all')
changes=status.splitlines()
cache='/opt/elobot/.cache';pip_cache=cache+'/pip'
pip_only=bool(changes) and all(line.startswith('?? .cache/pip/') for line in changes) and os.path.isdir(pip_cache) and not os.path.islink(cache) and not os.path.islink(pip_cache)
if pip_only:
 seen=0
 for root,dirs,files in os.walk(pip_cache,followlinks=False):
  seen+=len(dirs)+len(files)
  if seen>20000 or any(os.path.islink(os.path.join(root,name)) for name in dirs+files):pip_only=False;break
hc,head=r(*git,'rev-parse','HEAD')
tc,tip=r(*git,'ls-remote','--heads','origin','refs/heads/main')
pc,properties=r('systemctl','show','elobot','-p','ExecStartPre','-p','ExecStart','-p','ActiveState')
uc,_=r('sudo','-n','-l','/usr/bin/systemctl','restart','elobot')
ic,invocation=r('systemctl','show','elobot','-p','InvocationID','--value')
invocation=invocation.strip()
jc,logs=r('journalctl','-u','elobot','_SYSTEMD_INVOCATION_ID='+invocation,'-n','1000','--no-pager','-q') if ic==0 and re.fullmatch(r'[0-9a-f]{32}',invocation) else (1,'')
login=bool(re.search(r'Logged in as.{0,500}1212767017917218876',logs,re.S)) if jc==0 else None
lines=dict(x.split('=',1) for x in properties.splitlines() if '=' in x)
pre=lines.get('ExecStartPre','');start=lines.get('ExecStart','')
safe_pre=pre.count('{')==1 and 'path=/usr/local/sbin/elobot-update ; argv[]=/usr/local/sbin/elobot-update ;' in pre
safe_start=start.count('{')==1 and 'path=/usr/local/bin/elobot-start ; argv[]=/usr/local/bin/elobot-start ;' in start
parts=tip.strip().split()
out={'ok':sc==0 and hc==0 and tc==0 and pc==0,'clean':sc==0 and (not changes or pip_only),'ignored_pip_cache':pip_only,
     'head':head.strip() if hc==0 else '', 'tip':parts[0] if len(parts)==2 and parts[1]=='refs/heads/main' else '',
     'branch':c.get('repository_branch'),'update_on_start':c.get('update_on_start'),'start_file':c.get('start_file'),
     'expected_service':safe_pre and safe_start,'active':lines.get('ActiveState')=='active','restart_permission':uc==0,'bot_login_verified':login}
print(json.dumps(out))
'''

def inspect_remote(ssh_config):
    p=subprocess.run(['ssh','-F',str(ssh_config),'-o','BatchMode=yes','-o','ConnectTimeout=8','elo-bot','python3','-'],input=REMOTE_INSPECT,text=True,capture_output=True,timeout=45)
    if p.returncode:raise Refused('read-only Oracle inspection failed')
    try:value=json.loads(p.stdout)
    except ValueError:raise Refused('invalid Oracle inspection response') from None
    if not isinstance(value,dict) or value.get('ok') is not True:raise Refused('Oracle inspection incomplete')
    return value

def check_release_state(state,revision):
    if not state.get('clean'):raise Refused('Oracle checkout contains tracked or untracked changes')
    if not state.get('expected_service') or not state.get('restart_permission'):
        raise Refused('Oracle service or restart permission differs from the verified setup')
    if state.get('branch')!='main' or state.get('update_on_start') is not True or state.get('start_file')!='main.py':
        raise Refused('Oracle update settings differ from the verified setup')
    if state.get('tip')!=revision:raise Refused('live main tip differs from the approved revision')
    if not SHA.fullmatch(state.get('head','')):raise Refused('current Oracle revision is unavailable')

def reserve(db_path,message_id,channel_id,revision,author):
    db=sqlite3.connect(db_path,timeout=10)
    try:
        db.execute('PRAGMA synchronous=FULL')
        db.execute('CREATE TABLE IF NOT EXISTS actions (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, revision TEXT NOT NULL, author_id TEXT NOT NULL, status TEXT NOT NULL)')
        try:db.execute('INSERT INTO actions VALUES (?,?,?,?,?)',(message_id,channel_id,revision,author,'reserved'))
        except sqlite3.IntegrityError:raise Refused('confirmation was already used or requires recovery') from None
        db.commit()
    finally:db.close()

def mark(db_path,message_id,status):
    db=sqlite3.connect(db_path,timeout=10)
    try:db.execute('PRAGMA synchronous=FULL');db.execute('UPDATE actions SET status=? WHERE message_id=?',(status,message_id));db.commit()
    finally:db.close()

def perform(request,config,ssh_config,db_path,fetch=get_json,inspect=inspect_remote,runner=subprocess.run):
    if not isinstance(request,dict):raise Refused('invalid request')
    if request=={'action':'health'}:return {'status':'ready'}
    if request=={'action':'inspect'}:
        state=inspect(ssh_config)
        return {k:state.get(k) for k in ('clean','ignored_pip_cache','head','tip','branch','update_on_start','start_file','expected_service','active','restart_permission','bot_login_verified')}
    if set(request)!={'action','channel_id','message_id','revision'} or request.get('action')!='restart':raise Refused('unsupported action')
    channel=str(request['channel_id']);message=str(request['message_id']);revision=str(request['revision'])
    author=verify_confirmation(channel,message,revision,config,fetch)
    state=inspect(ssh_config);check_release_state(state,revision)
    # Re-fetch immediately before consuming confirmation and starting restart.
    if verify_confirmation(channel,message,revision,config,fetch)!=author:raise Refused('confirmation author changed')
    reserve(db_path,message,channel,revision,author)
    try:
        result=runner(['ssh','-F',str(ssh_config),'-o','BatchMode=yes','-o','ConnectTimeout=8','elo-bot','sudo','-n','/usr/bin/systemctl','restart','elobot'],capture_output=True,text=True,timeout=930)
        if result.returncode!=0:
            mark(db_path,message,'uncertain');return {'status':'uncertain','previous_revision':state['head']}
        try:after=inspect(ssh_config)
        except Exception:
            mark(db_path,message,'uncertain');return {'status':'uncertain','previous_revision':state['head']}
        verified=after.get('active') is True and after.get('head')==revision
        mark(db_path,message,'restarted' if verified else 'mismatch')
        return {'status':'restarted' if verified else 'mismatch','previous_revision':state['head'],'observed_revision':after.get('head'),'service_active':after.get('active'),'bot_login_verified':after.get('bot_login_verified') is True}
    except Exception:
        try:mark(db_path,message,'uncertain')
        except Exception:pass
        return {'status':'uncertain','previous_revision':state['head']}

def receive(sock,n):
    data=b''
    while len(data)<n:
        part=sock.recv(n-len(data))
        if not part:raise Refused('short request')
        data+=part
    return data

def load_config(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o027:raise Refused('unsafe service configuration')
    config=json.loads(path.read_text())
    if not isinstance(config,dict) or set(config)!={'token','owner','trusted','allowed'} or not config['token'] or not ID.fullmatch(config['owner']) or not isinstance(config['trusted'],list) or not isinstance(config['allowed'],list) or not all(isinstance(x,str) and ID.fullmatch(x) for x in config['trusted']+config['allowed']):raise Refused('invalid service configuration')
    return config

def serve(path,uid,gid,config_path,ssh_config,db_path):
    if path.exists() or path.is_symlink():raise Refused('socket exists')
    parent=path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.geteuid() or parent.st_mode&0o022:raise Refused('unsafe socket directory')
    os.chown(path.parent,-1,gid)
    server=socket.socket(socket.AF_UNIX);identity=None
    try:
        server.bind(str(path));s=path.lstat();identity=(s.st_dev,s.st_ino);os.chown(path,-1,gid);os.chmod(path,0o660);server.listen(4)
        while True:
            conn,_=server.accept()
            with conn:
                conn.settimeout(15)
                try:
                    pid,peer_uid,_=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    if not peer_allowed(pid,peer_uid,uid):raise Refused('unapproved peer')
                    count=struct.unpack('!I',receive(conn,4))[0]
                    if not 0<count<=MAX_REQUEST:raise Refused('invalid request size')
                    result=perform(json.loads(receive(conn,count)),load_config(config_path),ssh_config,db_path)
                    response={'ok':True,'result':result}
                except Refused as error:response={'ok':False,'error':str(error)}
                except Exception:response={'ok':False,'error':'release check failed; do not retry a restart without inspection'}
                payload=json.dumps(response,separators=(',',':')).encode()
                try:conn.sendall(struct.pack('!I',len(payload))+payload)
                except OSError:pass
    finally:
        server.close()
        if identity:
            try:
                s=path.lstat()
                if stat.S_ISSOCK(s.st_mode) and (s.st_dev,s.st_ino)==identity:path.unlink()
            except FileNotFoundError:pass

def main():
    p=argparse.ArgumentParser();p.add_argument('--config',type=Path,required=True);p.add_argument('--ssh-config',type=Path,required=True);p.add_argument('--db',type=Path,required=True);p.add_argument('--socket',type=Path,required=True);p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);a=p.parse_args()
    load_config(a.config)
    serve(a.socket,a.uid,a.gid,a.config,a.ssh_config,a.db)

if __name__=='__main__':
    try:main()
    except (OSError,ValueError,Refused):print('HELIO_RELEASE_ERROR: service could not start',file=sys.stderr);sys.exit(1)
