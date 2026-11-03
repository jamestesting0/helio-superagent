#!/usr/bin/env python3
"""Staged Unix-socket service for independently protected beta maintenance.

Not installed or enabled: deployment requires the isolated agent UID,
root-owned exclusion list, restricted credentials, and adversarial tests.
"""
from __future__ import annotations

import argparse
import json
import os
import runpy
import socket
import stat
import struct
import sys
from pathlib import Path

from dotenv import dotenv_values
from pymongo import MongoClient

BASE=Path(__file__).resolve().parent
broker=runpy.run_path(str(BASE/'helio_beta_broker.py'))
vault=broker['vault']
prep=broker['prep']
MAX_REQUEST=4*1024*1024
REQUIRED_CGROUP='/system.slice/helio-isolated.scope'


class ServiceError(Exception): pass


def read_exclusions(path: Path) -> set[tuple[str,str]]:
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_size>1048576:
            raise ServiceError('unsafe exclusion file')
        with os.fdopen(fd,'r') as stream:
            fd=-1
            data=json.load(stream)
    finally:
        if fd>=0:os.close(fd)
    if not isinstance(data,dict) or set(data)!={'database','complete','records'} or data['database']!='elo_beta' or data['complete'] is not True or not isinstance(data['records'],list):
        raise ServiceError('exclusions must be explicitly completed before service start')
    excluded=set()
    for record in data['records']:
        if not isinstance(record,dict) or set(record)!={'collection','id'}:
            raise ServiceError('invalid excluded record')
        collection=record['collection']
        if not isinstance(collection,str) or not prep['COLLECTION'].fullmatch(collection) or not prep['valid_id'](record['id']):
            raise ServiceError('invalid excluded record')
        excluded.add((collection,prep['identity_key'](record['id'])))
    return excluded


def create_client(path: Path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077:
        raise ServiceError('unsafe service credential file')
    uri=dotenv_values(path).get('MONGO_DB_URL')
    if not uri:raise ServiceError('missing service credential')
    client=MongoClient(uri,tls=True,serverSelectionTimeoutMS=7000,connectTimeoutMS=7000)
    try:
        check_database(client['elo_beta'])
    except BaseException:
        client.close()
        raise
    return client


def check_database(database):
    if getattr(database,'name',None)!='elo_beta':raise ServiceError('unexpected database handle')
    auth=database.command({'connectionStatus':1,'showPrivileges':True}).get('authInfo',{})
    safe,_=prep['evaluate_privileges'](auth)
    if not safe:raise ServiceError('service credential scope is not permitted')


def process_request(database, root, excluded, request):
    if not isinstance(request,dict) or set(request)!={'operation_id','plan'}:
        raise ServiceError('invalid request')
    check_database(database)
    return broker['apply_one'](database,root,request['operation_id'],request['plan'],excluded)


def peer_in_scope(pid: int, required_cgroup: str) -> bool:
    try:
        entries=Path(f'/proc/{pid}/cgroup').read_text().splitlines()
        return any(line.split(':',2)==['0','',required_cgroup] for line in entries)
    except (OSError,ValueError):
        return False


def serve(root: Path, socket_path: Path, allowed_uid: int, socket_gid: int, database, excluded, required_cgroup=REQUIRED_CGROUP):
    vault['require_private_directory'](root)
    if socket_path.exists() or socket_path.is_symlink():raise ServiceError('socket path already exists')
    parent=socket_path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.geteuid() or parent.st_mode&0o022:
        raise ServiceError('unsafe socket parent')
    # systemd may reset RuntimeDirectory ownership between ExecStartPre and
    # ExecStart. The owner can safely assign this directory to a supplemental
    # group so the allowed peer can traverse it without making it writable.
    os.chown(socket_path.parent,-1,socket_gid)
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);identity=None
    try:
        server.bind(str(socket_path));info=socket_path.lstat();identity=(info.st_dev,info.st_ino)
        os.chown(socket_path,-1,socket_gid);os.chmod(socket_path,0o660);server.listen(8)
        while True:
            conn,_=server.accept()
            with conn:
                conn.settimeout(10)
                try:
                    pid,uid,_=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
                    if uid!=allowed_uid or not peer_in_scope(pid,required_cgroup):raise ServiceError('unapproved peer')
                    length=struct.unpack('!I',vault['receive_exact'](conn,4))[0]
                    if not 0<length<=MAX_REQUEST:raise ServiceError('invalid request size')
                    request=json.loads(vault['receive_exact'](conn,length))
                    if request=={'action':'health'}:
                        check_database(database)
                        response={'ok':True,'status':'ready','database':'elo_beta'}
                    else:
                        response={'ok':True,'result':process_request(database,root,excluded,request)}
                except (ServiceError,broker['MaintenanceError'],vault['VaultError'],ValueError,TypeError,KeyError,OSError):
                    response={'ok':False,'error':'operation refused or failed; inspect before retrying'}
                except Exception:
                    # Database and parsing details can contain credentials or private data.
                    response={'ok':False,'error':'operation refused or failed; inspect before retrying'}
                payload=json.dumps(response,separators=(',',':')).encode()
                try:conn.sendall(struct.pack('!I',len(payload))+payload)
                except OSError:pass
    finally:
        server.close()
        if identity is not None:
            try:
                info=socket_path.lstat()
                if stat.S_ISSOCK(info.st_mode) and (info.st_dev,info.st_ino)==identity:socket_path.unlink()
            except FileNotFoundError:pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('archive','socket','credentials','exclusions'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--allowed-uid',type=int,required=True);parser.add_argument('--socket-gid',type=int,required=True)
    args=parser.parse_args()
    excluded=read_exclusions(args.exclusions)
    client=create_client(args.credentials)
    try:serve(args.archive,args.socket,args.allowed_uid,args.socket_gid,client['elo_beta'],excluded)
    finally:client.close()


if __name__=='__main__':
    try:main()
    except (ServiceError,OSError,ValueError):
        print('BETA_SERVICE_ERROR: service could not start',file=sys.stderr);sys.exit(1)
