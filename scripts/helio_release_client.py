#!/usr/bin/env python3
"""Call Helio's narrow, confirmation-checking Oracle release broker."""
import argparse,json,re,socket,struct,sys

SOCKET='/run/helio-release-service/release.sock'
class ReleaseError(Exception):pass

def exchange(request,path=SOCKET,timeout=980):
    data=json.dumps(request,separators=(',',':')).encode()
    try:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(timeout);sock.connect(path);sock.sendall(struct.pack('!I',len(data))+data)
            def read(n):
                out=b''
                while len(out)<n:
                    part=sock.recv(n-len(out))
                    if not part:raise ReleaseError('Release response was incomplete; inspect before retrying')
                    out+=part
                return out
            length=struct.unpack('!I',read(4))[0]
            if not 0<length<=1048576:raise ReleaseError('Invalid release response')
            response=json.loads(read(length))
    except (OSError,ValueError) as error:
        raise ReleaseError('Release service unavailable or outcome uncertain; inspect before retrying') from error
    if not isinstance(response,dict) or not response.get('ok'):raise ReleaseError(str(response.get('error','Release request refused')) if isinstance(response,dict) else 'Release request refused')
    return response.get('result')

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
    sub.add_parser('inspect')
    restart=sub.add_parser('restart');restart.add_argument('--channel',required=True);restart.add_argument('--message',required=True);restart.add_argument('--revision',required=True)
    a=p.parse_args()
    if a.action=='inspect':request={'action':'inspect'}
    else:
        if not re.fullmatch(r'\d{5,30}',a.channel) or not re.fullmatch(r'\d{5,30}',a.message) or not re.fullmatch(r'[0-9a-f]{40}',a.revision):raise ReleaseError('Invalid channel, message, or full revision')
        request={'action':'restart','channel_id':a.channel,'message_id':a.message,'revision':a.revision}
        print('Checking Discord confirmation and Oracle state; do not repeat an uncertain restart.',flush=True)
    result=exchange(request);print(json.dumps(result,indent=2))
    if a.action=='restart' and (not isinstance(result,dict) or result.get('status')!='restarted'):return 2
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except ReleaseError as error:print('RELEASE_REFUSED:',str(error),file=sys.stderr);sys.exit(2)
