#!/usr/bin/env python3
"""Open and close only Helio's dedicated WSL Chrome profile."""
import argparse, json, os, signal, subprocess, sys, time
from pathlib import Path
HOME=Path.home(); PROFILE=HOME/'.local/share/helio-chrome/profile'; CHROME=HOME/'.local/share/helio-chrome/pkg/opt/google/chrome/chrome'; LAUNCHER=HOME/'.local/bin/helio-chrome'; BSK=HOME/'.local/bin/bsk'
def browser_pids():
 result=[]
 for proc in Path('/proc').iterdir():
  if not proc.name.isdigit(): continue
  try:
   if proc.stat().st_uid != os.getuid(): continue
   args=(proc/'cmdline').read_bytes().split(b'\0'); args=[os.fsdecode(a) for a in args if a]
   if not args or args[0]!=str(CHROME) or any(x.startswith('--type=') for x in args): continue
   if f'--user-data-dir={PROFILE}' not in args: continue
   result.append(int(proc.name))
  except (OSError,ProcessLookupError): continue
 return result
def active_sessions():
 try:
  p=subprocess.run([str(BSK),'session','list','--json'],capture_output=True,text=True,timeout=10)
  if p.returncode: raise RuntimeError('BrowserSkill session list failed')
  value=json.loads(p.stdout)
  if not isinstance(value,list): raise RuntimeError('Unexpected BrowserSkill session list')
  return value
 except (OSError,subprocess.SubprocessError,ValueError) as e: raise RuntimeError('Cannot verify BrowserSkill sessions; leaving Chrome open') from e
def close_browser():
 pids=browser_pids()
 if not pids: print('Helio Chrome is already closed.'); return 0
 if active_sessions(): print('BrowserSkill has active sessions; stop or finish them before closing Chrome.',file=sys.stderr); return 2
 for pid in pids:
  try: os.kill(pid,signal.SIGTERM)
  except ProcessLookupError: continue
  except OSError as e: print(f'Could not close Helio Chrome: {e}',file=sys.stderr); return 1
 for _ in range(50):
  if not browser_pids(): print('Helio Chrome closed.'); return 0
  time.sleep(.1)
 print('Helio Chrome has not exited; it was left running for inspection.',file=sys.stderr); return 1
def open_browser():
 if browser_pids(): print('Helio Chrome is already open.'); return 0
 if not LAUNCHER.is_file(): print('Helio Chrome launcher is missing.',file=sys.stderr); return 1
 logdir=HOME/'.local/share/helio-chrome'; logdir.mkdir(parents=True,exist_ok=True)
 fd=os.open(logdir/'helio-browser.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
 try:
  with os.fdopen(fd,'ab') as log: p=subprocess.Popen([str(LAUNCHER)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
  for _ in range(40):
   if browser_pids(): print('Helio Chrome opened.'); return 0
   if p.poll() is not None: break
   time.sleep(.1)
  print('Helio Chrome did not start; inspect ~/.local/share/helio-chrome/helio-browser.log.',file=sys.stderr); return 1
 except OSError as e: print(f'Could not open Helio Chrome: {e}',file=sys.stderr); return 1
def ready_browser():
 """Open the dedicated profile and wait for its extension and daemon to be healthy."""
 already_open=bool(browser_pids())
 if open_browser()!=0: return 1
 deadline=time.monotonic()+30
 required={'daemon running','daemon local process identity','protocol compatible','extension connected','browser protocol compatible'}
 while time.monotonic()<deadline:
  try:
   p=subprocess.run([str(BSK),'doctor','--json'],capture_output=True,text=True,timeout=min(8,max(1,deadline-time.monotonic())))
   checks=json.loads(p.stdout)
   if isinstance(checks,list):
    states={x.get('name'):x.get('status') for x in checks if isinstance(x,dict)}
    if all(states.get(name)=='ok' for name in required) and browser_pids():
     browser_list=subprocess.run([str(BSK),'browsers','--json'],capture_output=True,text=True,timeout=min(8,max(1,deadline-time.monotonic())))
     browsers=json.loads(browser_list.stdout)
     matched=[b for b in browsers if isinstance(b,dict) and b.get('label')=='Helio' and b.get('browser_name')=='chrome' and not b.get('version_skew') and not b.get('unresponsive')] if isinstance(browsers,list) else []
     if browser_list.returncode==0 and len(matched)==1:
      print('Helio BrowserSkill is connected and ready.'); return 0
  except (OSError,subprocess.SubprocessError,ValueError): pass
  time.sleep(.5)
 print('Helio Chrome opened but BrowserSkill did not become ready; run helio doctor for details.',file=sys.stderr)
 if not already_open:
  try: close_browser()
  except RuntimeError: print('Could not verify active browser sessions; leaving Chrome open.',file=sys.stderr)
 return 1

def main():
 p=argparse.ArgumentParser(description=__doc__); p.add_argument('action',choices=['open','ready','close','status'],nargs='?',default='open'); a=p.parse_args()
 if a.action=='open': return open_browser()
 if a.action=='ready': return ready_browser()
 if a.action=='close':
  try: return close_browser()
  except RuntimeError as e: print(str(e),file=sys.stderr); return 2
 print('Helio Chrome is '+('open.' if browser_pids() else 'closed.')); return 0
if __name__=='__main__': sys.exit(main())
