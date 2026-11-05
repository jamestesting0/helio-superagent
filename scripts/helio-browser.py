#!/usr/bin/env python3
"""Open and close Helio's dedicated WSL Chrome profiles.

    helio browser [open|ready|close|status] [--accounts N | --profile NAME]
    helio browser setup qa-a|qa-b|qa-c      open one test profile for its one-time login
    helio browser accounts                  show the test-account map and which profiles are connected

Without options the Helio profile is used, as before. Test profiles qa-a..qa-c each stay logged into one
Discord test account (qa-a is always the Elo Manager account), so multi-account tests use one window per
account instead of switching accounts. Their BrowserSkill instance IDs live in ~/.dori/elobot/qa-accounts.json.
"""
import argparse, json, os, signal, subprocess, sys, time
from pathlib import Path
HOME=Path.home(); ROOT=HOME/'.local/share/helio-chrome'; PROFILE=ROOT/'profile'; PKG=ROOT/'pkg'
CHROME=PKG/'opt/google/chrome/chrome'; LAUNCHER=HOME/'.local/bin/helio-chrome'; BSK=HOME/'.local/bin/bsk'
ACCOUNTS=HOME/'.dori/elobot/qa-accounts.json'
QA=('qa-a','qa-b','qa-c')

def profile_dir(name):return PROFILE if name=='helio' else ROOT/name

def browser_pids(name='helio'):
 result=[];flag=f'--user-data-dir={profile_dir(name)}'
 for proc in Path('/proc').iterdir():
  if not proc.name.isdigit(): continue
  try:
   if proc.stat().st_uid != os.getuid(): continue
   args=(proc/'cmdline').read_bytes().split(b'\0'); args=[os.fsdecode(a) for a in args if a]
   if not args or args[0]!=str(CHROME) or any(x.startswith('--type=') for x in args): continue
   if flag not in args: continue
   result.append(int(proc.name))
  except (OSError,ProcessLookupError): continue
 return result

def bsk_json(*args,timeout=8):
 p=subprocess.run([str(BSK),*args,'--json'],capture_output=True,text=True,timeout=timeout)
 if p.returncode: raise RuntimeError(f'bsk {args[0]} failed')
 return json.loads(p.stdout)

def active_sessions():
 try:
  value=bsk_json('session','list',timeout=10)
  if not isinstance(value,list): raise RuntimeError('Unexpected BrowserSkill session list')
  return value
 except (OSError,subprocess.SubprocessError,ValueError) as e: raise RuntimeError('Cannot verify BrowserSkill sessions; leaving Chrome open') from e

def accounts():
 try: data=json.loads(ACCOUNTS.read_text())
 except FileNotFoundError: return {}
 return {k:v for k,v in data.items() if k in QA and isinstance(v,dict)}

def close_browser(name='helio'):
 label='Helio Chrome' if name=='helio' else f'Chrome profile {name}'
 pids=browser_pids(name)
 if not pids: print(f'{label} is already closed.'); return 0
 if active_sessions(): print('BrowserSkill has active sessions; stop or finish them before closing Chrome.',file=sys.stderr); return 2
 for pid in pids:
  try: os.kill(pid,signal.SIGTERM)
  except ProcessLookupError: continue
  except OSError as e: print(f'Could not close {label}: {e}',file=sys.stderr); return 1
 for _ in range(50):
  if not browser_pids(name): print(f'{label} closed.'); return 0
  time.sleep(.1)
 print(f'{label} has not exited; it was left running for inspection.',file=sys.stderr); return 1

def open_browser(name='helio'):
 label='Helio Chrome' if name=='helio' else f'Chrome profile {name}'
 if browser_pids(name): print(f'{label} is already open.'); return 0
 if name=='helio':
  if not LAUNCHER.is_file(): print('Helio Chrome launcher is missing.',file=sys.stderr); return 1
  cmd=[str(LAUNCHER)];env=None
 else:
  # Same package and flags as the helio-chrome launcher, with this profile's own data directory.
  profile_dir(name).mkdir(parents=True,exist_ok=True,mode=0o700)
  cmd=[str(CHROME),f'--user-data-dir={profile_dir(name)}','--no-first-run']
  env=dict(os.environ,LD_LIBRARY_PATH=f"{PKG/'usr/lib/x86_64-linux-gnu'}"+(':'+os.environ['LD_LIBRARY_PATH'] if os.environ.get('LD_LIBRARY_PATH') else ''))
 ROOT.mkdir(parents=True,exist_ok=True)
 fd=os.open(ROOT/'helio-browser.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
 try:
  with os.fdopen(fd,'ab') as log: p=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env=env)
  for _ in range(40):
   if browser_pids(name): print(f'{label} opened.'); return 0
   if p.poll() is not None: break
   time.sleep(.1)
  print(f'{label} did not start; inspect ~/.local/share/helio-chrome/helio-browser.log.',file=sys.stderr); return 1
 except OSError as e: print(f'Could not open {label}: {e}',file=sys.stderr); return 1

def connected(name,browsers):
 if name=='helio':
  return [b for b in browsers if isinstance(b,dict) and b.get('label')=='Helio' and b.get('browser_name')=='chrome' and not b.get('version_skew') and not b.get('unresponsive')]
 want=accounts().get(name,{}).get('browser')
 return [b for b in browsers if isinstance(b,dict) and want and want in (b.get('id'),b.get('instance_id'),b.get('label')) and not b.get('unresponsive')]

def ready_browser(name='helio'):
 """Open one profile and wait for its BrowserSkill instance to be connected."""
 if name!='helio' and not accounts().get(name,{}).get('browser'):
  print(f'{name} is not set up yet: run helio browser setup {name}, log in its test account and record its BrowserSkill instance.',file=sys.stderr); return 1
 already_open=bool(browser_pids(name))
 if open_browser(name)!=0: return 1
 deadline=time.monotonic()+30
 required={'daemon running','daemon local process identity','protocol compatible','extension connected','browser protocol compatible'}
 while time.monotonic()<deadline:
  try:
   checks=bsk_json('doctor',timeout=min(8,max(1,deadline-time.monotonic())))
   states={x.get('name'):x.get('status') for x in checks if isinstance(x,dict)} if isinstance(checks,list) else {}
   if all(states.get(n)=='ok' for n in required) and browser_pids(name):
    browsers=bsk_json('browsers',timeout=min(8,max(1,deadline-time.monotonic())))
    if isinstance(browsers,list) and len(connected(name,browsers))==1:
     who='Helio' if name=='helio' else f"{name} ({accounts()[name].get('account','?')})"
     print(f'{who} BrowserSkill is connected and ready.'); return 0
  except (OSError,subprocess.SubprocessError,ValueError,RuntimeError): pass
  time.sleep(.5)
 print(f'{name} Chrome opened but BrowserSkill did not become ready; run bsk doctor --json for browser details.',file=sys.stderr)
 if not already_open:
  try: close_browser(name)
  except RuntimeError: print('Could not verify active browser sessions; leaving Chrome open.',file=sys.stderr)
 return 1

def show_accounts():
 data=accounts();browsers=[]
 try: browsers=bsk_json('browsers')
 except (OSError,subprocess.SubprocessError,ValueError,RuntimeError): pass
 for name in QA:
  entry=data.get(name,{})
  state='connected' if browsers and connected(name,browsers) else 'open' if browser_pids(name) else 'closed'
  print(f"{name}: account={entry.get('account','(not set)')} browser={entry.get('browser','(not set)')} {state}")
 return 0

def main():
 p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
 p.add_argument('action',choices=['open','ready','close','status','setup','accounts'],nargs='?',default='open')
 p.add_argument('name',nargs='?',choices=QA,help='profile for setup')
 group=p.add_mutually_exclusive_group()
 group.add_argument('--accounts',type=int,choices=(1,2,3),help='test profiles qa-a.. to use (qa-a is the Elo Manager account)')
 group.add_argument('--profile',choices=('helio',*QA))
 group.add_argument('--all',action='store_true',help='close: every Helio-managed profile')
 a=p.parse_args()
 if a.action=='accounts': return show_accounts()
 if a.action=='setup':
  if not a.name: p.error('setup needs a profile: qa-a, qa-b or qa-c')
  code=open_browser(a.name)
  if code==0: print(f'In the {a.name} window: add BrowserSkill, log into Discord as its test account, then copy the BrowserSkill profile instructions to Helio so it can record the instance in {ACCOUNTS}.')
  return code
 names=list(QA[:a.accounts]) if a.accounts else [a.profile or 'helio']
 if a.action=='close' and a.all: names=['helio',*QA]
 codes=[]
 for name in names:
  if a.action=='open': codes.append(open_browser(name))
  elif a.action=='ready': codes.append(ready_browser(name))
  elif a.action=='close':
   try: codes.append(close_browser(name))
   except RuntimeError as e: print(str(e),file=sys.stderr); codes.append(2)
  else: print(f"{name} Chrome is "+('open.' if browser_pids(name) else 'closed.')); codes.append(0)
 return max(codes)
if __name__=='__main__': sys.exit(main())
