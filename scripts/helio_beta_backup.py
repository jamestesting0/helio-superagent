#!/usr/bin/env python3
"""Owner-only inspection and export of protected beta BSON preimages."""
import argparse,hashlib,json,os,pwd,re,stat,sys
from pathlib import Path
from bson import BSON

ROOT=Path('/var/lib/helio-beta-service/archive')
DEST=Path('/home/james/helio-beta-recovery')
OP=re.compile(r'^[0-9a-f]{32}$')
class BackupError(Exception):pass

def load(op):
    if not OP.fullmatch(op):raise BackupError('invalid operation ID')
    folder=ROOT/op;info=folder.lstat();owner=pwd.getpwnam('helio-vault').pw_uid
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=owner or info.st_mode&0o077:raise BackupError('unsafe archive directory')
    def read(name):
        fd=os.open(folder/name,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner or info.st_mode&0o077:raise BackupError('unsafe archive file')
            with os.fdopen(fd,'rb') as f:fd=-1;return f.read(17*1024*1024)
        finally:
            if fd>=0:os.close(fd)
    meta=json.loads(read('manifest.json'));raw=read('preimage.bson')
    if meta.get('database')!='elo_beta' or meta.get('operation_id')!=op or meta.get('size')!=len(raw) or meta.get('bson_sha256')!=hashlib.sha256(raw).hexdigest():raise BackupError('archive integrity verification failed')
    if '_id' not in BSON(raw).decode():raise BackupError('archive has no document ID')
    try:result=json.loads(read('result.json'))
    except FileNotFoundError:result={'status':'incomplete_or_uncertain'}
    return meta,raw,result

def export(op):
    meta,raw,result=load(op)
    user=pwd.getpwnam('james')
    try:DEST.mkdir(mode=0o700)
    except FileExistsError:pass
    directory=os.open(DEST,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0,user.pw_uid) or info.st_mode&0o077:raise BackupError('recovery directory is not private')
        if info.st_uid==0:os.fchown(directory,user.pw_uid,user.pw_gid)
        files=[(op+'.bson',raw),(op+'.manifest.json',(json.dumps({'manifest':meta,'result':result},indent=2)+'\n').encode())]
        for name,_ in files:
            try:os.stat(name,dir_fd=directory,follow_symlinks=False);raise BackupError('export file already exists')
            except FileNotFoundError:pass
        for name,content in files:
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
            os.fchown(fd,user.pw_uid,user.pw_gid)
            with os.fdopen(fd,'wb') as stream:stream.write(content);stream.flush();os.fsync(stream.fileno())
        os.fsync(directory)
    finally:os.close(directory)
    return DEST/(op+'.bson')

def main():
    if os.geteuid()!=0:raise BackupError('owner recovery tool must run as root')
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
    sub.add_parser('list');verify=sub.add_parser('verify');verify.add_argument('operation_id');out=sub.add_parser('export');out.add_argument('operation_id');a=p.parse_args()
    if a.action=='list':
        for folder in sorted(ROOT.iterdir()):
            if OP.fullmatch(folder.name):
                try:
                    meta,_,result=load(folder.name)
                    print(json.dumps({'operation_id':folder.name,'collection':meta['collection'],'stored_at':meta['stored_at'],'status':result.get('status')}))
                except (BackupError,OSError,ValueError):print(json.dumps({'operation_id':folder.name,'status':'invalid_or_incomplete'}))
        return
    if a.action=='verify':
        meta,_,result=load(a.operation_id)
        print(json.dumps({'operation_id':a.operation_id,'collection':meta['collection'],'sha256':meta['bson_sha256'],'status':result.get('status')}));return
    print('Verified BSON preimage exported to:',export(a.operation_id))

if __name__=='__main__':
    try:main()
    except (BackupError,OSError,ValueError,KeyError) as error:print('BACKUP_ERROR:',str(error),file=sys.stderr);sys.exit(2)
