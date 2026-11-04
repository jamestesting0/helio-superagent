#!/usr/bin/env python3
"""Call Helio's narrow, confirmation-checking Oracle release broker."""
import argparse,json,re,socket,struct,sys,time

SOCKET='/run/helio-release-service/release.sock'
class ReleaseError(Exception):pass

def describe(state):
    """Report service evidence without claiming current Discord connectivity."""
    phase=state.get('phase') or ('running' if state.get('active') else 'unknown')
    revision=state.get('running_revision')
    version=f"running revision {revision[:8]}" if revision else f"checkout {(state.get('head') or 'unknown')[:8]}; running revision unverified"
    login=state.get('login_evidence','unavailable')
    return f"EloBot: {phase}; {version}; login {login}" + (f" at {state['login_observed_at']}" if state.get('login_observed_at') else '') + '; current gateway health unverified'

def observe(invocation,seconds=300,exchange_fn=None,clock=time.monotonic,sleep=time.sleep):
    """Only inspect after the single restart; never replay the production action."""
    deadline=clock()+seconds
    exchange_fn=exchange_fn or exchange
    while True:
        state=exchange_fn({'action':'inspect'},timeout=60)
        if invocation and state.get('invocation')!=invocation:
            return {'readiness':'invocation_changed','observation':state}
        if state.get('phase') in ('failed','inactive'):
            return {'readiness':'service_down','observation':state}
        if state.get('login_evidence')=='observed' and state.get('active'):
            return {'readiness':'login_observed','observation':state}
        remaining=deadline-clock()
        if remaining<=0:
            return {'readiness':'unverified','observation':state}
        sleep(min(10,remaining))

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
    sub.add_parser('status')
    wait=sub.add_parser('wait');wait.add_argument('--invocation');wait.add_argument('--seconds',type=int,default=300)
    restart=sub.add_parser('restart');restart.add_argument('--channel',required=True);restart.add_argument('--message',required=True);restart.add_argument('--revision',required=True)
    a=p.parse_args()
    if a.action=='wait':
        if not 0<=a.seconds<=600:raise ReleaseError('Observation budget must be between 0 and 600 seconds')
        result=observe(a.invocation,a.seconds);print(json.dumps(result,indent=2))
        return 0 if result['readiness']=='login_observed' else 2
    if a.action in ('inspect','status'):request={'action':'inspect'}
    else:
        if not re.fullmatch(r'\d{5,30}',a.channel) or not re.fullmatch(r'\d{5,30}',a.message) or not re.fullmatch(r'[0-9a-f]{40}',a.revision):raise ReleaseError('Invalid channel, message, or full revision')
        request={'action':'restart','channel_id':a.channel,'message_id':a.message,'revision':a.revision}
        print('Checking Discord confirmation and Oracle state; do not repeat an uncertain restart.',flush=True)
    result=exchange(request,timeout=60 if a.action in ('inspect','status') else 980)
    if a.action=='status':
        print(describe(result));return 0
    if a.action=='restart' and result.get('status')=='restarted':
        result.update(observe(result.get('invocation')))
    print(json.dumps(result,indent=2))
    if a.action=='restart' and (not isinstance(result,dict) or result.get('status')!='restarted' or result.get('readiness')!='login_observed'):return 2
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except ReleaseError as error:print('RELEASE_REFUSED:',str(error),file=sys.stderr);sys.exit(2)
