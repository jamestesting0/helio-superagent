#!/usr/bin/env python3
"""Start a private Herdr session and optionally launch the Helio lead."""
import json,os,subprocess,sys,time
from pathlib import Path

if len(sys.argv)!=2 or sys.argv[1] not in ('shell','start','resume'):
    raise SystemExit('usage: helio_isolated_start.py shell|start|resume')
mode=sys.argv[1];herdr='/home/james/.local/bin/herdr'
env=dict(os.environ,HERDR_SESSION='elobot')
server=subprocess.Popen([herdr,'--session','elobot','server'],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def run(args,timeout=15):
    p=subprocess.run([herdr,*args],env=env,capture_output=True,text=True,timeout=timeout)
    if p.returncode:raise RuntimeError('private Herdr operation failed: '+args[0])
    return p.stdout
try:
    for _ in range(120):
        try:run(['status','server'],2);break
        except (RuntimeError,subprocess.SubprocessError):
            if server.poll() is not None:raise RuntimeError('private Herdr server exited')
            time.sleep(.1)
    else:raise RuntimeError('private Herdr server did not start')
    if mode!='shell':
        result=json.loads(run(['tab','create','--cwd','/home/james/PythonProjects/elo-bot','--label','Helio','--focus']))['result']
        pane=result['root_pane']['pane_id']
        run(['pane','run',pane,'helio '+mode])
    result=subprocess.run([herdr,'--session','elobot'],env=env)
    sys.exit(result.returncode)
except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError) as error:
    print('HELIO_START_ERROR:',str(error),file=sys.stderr);sys.exit(1)
finally:
    try:run(['server','stop'],5)
    except (OSError,RuntimeError,subprocess.SubprocessError):pass
    if server.poll() is None:
        server.terminate()
        try:server.wait(timeout=3)
        except subprocess.TimeoutExpired:server.kill();server.wait()
