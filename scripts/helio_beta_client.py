#!/usr/bin/env python3
"""Submit one exact beta operation to the isolated protected service."""
import json, os, pwd, socket, struct, sys, uuid
from pathlib import Path

SOCKET='/run/helio-beta-service/maintenance.sock'
MAX_RESPONSE=1024*1024

class ClientError(Exception): pass

def receive_exact(sock,count):
    result=b''
    while len(result)<count:
        chunk=sock.recv(count-len(result))
        if not chunk:raise ClientError('Service closed the connection; inspect operation before retrying')
        result+=chunk
    return result

def exchange(request,socket_path=SOCKET,timeout=90):
    payload=json.dumps(request,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
    if len(payload)>4*1024*1024:raise ClientError('Request exceeds service size limit')
    try:
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout);sock.connect(socket_path)
            sock.sendall(struct.pack('!I',len(payload))+payload)
            count=struct.unpack('!I',receive_exact(sock,4))[0]
            if not 0<count<=MAX_RESPONSE:raise ClientError('Invalid service response; inspect before retrying')
            reply=json.loads(receive_exact(sock,count))
    except (OSError,ValueError) as error:
        raise ClientError('Service connection failed or the outcome is uncertain; inspect before retrying') from error
    if not isinstance(reply,dict) or not reply.get('ok'):
        raise ClientError('Service refused or failed; inspect the operation before retrying')
    return reply

def healthy(socket_path=SOCKET):
    try:return exchange({'action':'health'},socket_path,12)=={'ok':True,'status':'ready','database':'elo_beta'}
    except ClientError:return False

def submit(plan,op_id,socket_path=SOCKET):
    reply=exchange({'operation_id':op_id,'plan':plan},socket_path)
    result=reply.get('result')
    if not isinstance(result,dict) or result.get('operation_id')!=op_id or result.get('status') not in {'applied','conflict','uncertain'}:
        raise ClientError('Invalid service receipt; inspect before retrying')
    return result

def apply(path,validator):
    try: isolated_uid=pwd.getpwnam('helio-agent').pw_uid
    except KeyError:raise ClientError('The isolated Helio account is unavailable') from None
    if os.getuid()!=isolated_uid:raise ClientError('Beta writes are disabled outside the isolated Helio account')
    path=Path(path)
    if path.stat().st_size>2*1024*1024:raise ClientError('Plan is too large')
    plan=json.loads(path.read_text(encoding='utf-8'))
    validator(plan)
    if len(plan['operations'])!=1:raise ClientError('Submit one exact record per plan')
    operation_id=uuid.uuid4().hex
    print('Beta operation ID:',operation_id,flush=True)
    result=submit(plan,operation_id)
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['status']=='applied' else 2
