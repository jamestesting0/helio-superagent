#!/usr/bin/env python3
"""Preview and safely update previously installed Helio-managed files.

On the owner side this first regenerates env/beta/permission files from
~/.config/helio/helio.env (see scripts/helio_config.py), then updates managed
files against the recorded baseline and refuses to overwrite local edits.
"""
import argparse, hashlib, json, os, runpy, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
PAYLOAD=runpy.run_path(str(ROOT/'scripts/helio_payload.py'))
CONFIG=PAYLOAD['CONFIG']
DOCS=runpy.run_path(str(ROOT/'scripts/organize-elobot-docs.py'))
INBOUND_FILES=PAYLOAD['INBOUND_FILES']
PROFILES=PAYLOAD['PROFILES']
MANAGED=PAYLOAD['MANAGED']
RETIRED=PAYLOAD['RETIRED']
SHIPPED=PAYLOAD['PREVIOUSLY_SHIPPED']
NEW_PAYLOAD=('helio-sessions.py','evidence.ts','evidence.test.ts',*PAYLOAD['SKILLS'])
def digest(b): return hashlib.sha256(b).hexdigest()
def atomic(p, data):
 fd,tmp=tempfile.mkstemp(prefix='.helio-',dir=p.parent)
 try:
  with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
  os.chmod(tmp,p.stat().st_mode & 0o777 if p.exists() else 0o600); os.replace(tmp,p)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
def run(home, action, update_launcher=False, profile=None):
 dst=home/'.dori/elobot'; manifest=dst/'.sync-manifest.json'
 if not dst.is_dir() or dst.is_symlink(): raise SystemExit('Helio install missing or unsafe')
 report_channels=dst/'report-channels'
 if report_channels.is_symlink() or not report_channels.is_file():
  raise SystemExit(f'Missing or unsafe authorization file: {report_channels}. Set HELIO_REPORT_CHANNELS in ~/.config/helio/helio.env and run helio update; local authorization files are never overwritten by the managed-file update.')
 if manifest.is_symlink(): raise SystemExit('Unsafe sync manifest')
 baseline=json.loads(manifest.read_text()) if manifest.is_file() else {}
 recorded_profile=baseline.get('_profile')
 if '_profile' in baseline and recorded_profile not in PROFILES:
  raise SystemExit('Invalid _profile in sync manifest; nothing updated')
 if profile is not None and recorded_profile is not None and profile!=recorded_profile:
  raise SystemExit(f'Installation profile is {recorded_profile}; refusing to switch to {profile}')
 profile=profile or recorded_profile or 'isolated'
 if profile=='owner' and update_launcher:
  raise SystemExit('Owner profile never replaces the host launcher')
 print(f'Update profile: {profile}')
 paths={name:dst/name for name in MANAGED}
 DOCS['validate'](dst)
 for name in DOCS['RUNBOOKS']:
  if (dst/'docs'/name).is_file():
   paths[name]=dst/'docs'/name
 if update_launcher:
  paths['@launcher']=home/'.local/bin/helio'
 else:
  print('Launcher excluded; preserving the installed host/runtime wrapper.')
 for name in INBOUND_FILES:
  paths['@inbound/'+name]=home/'.dori/discord-inbound'/name
 for name in PAYLOAD['MESSENGER']:
  paths['@messenger/'+name]=dst/'vendor/dori-mode/scripts/src/messenger'/name
 names=tuple(paths)
 for name,p in paths.items():
  for parent in p.parents:
   if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
    raise SystemExit(f'Unsafe managed directory: {parent}')
  new_payload=(name.startswith('@inbound/') or name in DOCS['NEW_RUNBOOKS'] or name in NEW_PAYLOAD) and name not in baseline
  if p.is_symlink() or (p.exists() and not p.is_file()) or (not p.exists() and not new_payload):
   raise SystemExit(f'Unsafe or missing managed file: {p}')
 current={n:digest(p.read_bytes()) if p.is_file() else None for n,p in paths.items()}
 if action=='adopt':
  if manifest.exists(): raise SystemExit('Manifest exists; refusing to replace baseline')
  current={name:value for name,value in current.items() if value is not None}
  current.update({name:digest((dst/name).read_bytes()) for name in RETIRED if (dst/name).is_file() and not (dst/name).is_symlink()})
  current['_configLeadPane']=json.loads(paths['config.json'].read_text()).get('leadPane', '')
  current['_profile']=profile
  atomic(manifest,(json.dumps(current,indent=2)+'\n').encode()); print('Recorded current files as the update baseline; no managed files changed.'); return
 if not manifest.is_file(): raise SystemExit('No baseline. Inspect current files, then run --adopt once.')
 # leadPane is runtime state written by start; compare all other config fields
 # against the recorded baseline while allowing this one field to change.
 config=json.loads(paths['config.json'].read_text())
 baseline_pane=baseline.get('_configLeadPane', '')
 config_matches=False
 for pane in {baseline_pane, ''}:
  config['leadPane']=pane
  if digest((json.dumps(config,indent=2)+'\n').encode())==baseline.get('config.json'): config_matches=True
 active=json.loads(paths['config.json'].read_text())
 env=PAYLOAD['installed_values'](home)
 mapping=PAYLOAD['values'](home,PAYLOAD['configured_project'](home,env) or active['defaultCwd'],env)
 documents=PAYLOAD['documents'](profile,mapping)
 source_config=PAYLOAD['render_config'](mapping)
 desired={}
 for name in names:
  if name in documents: data=documents[name]
  elif name=='config.json':
   for k in ('agentCommand','defaultModel','launchKeywords','maxWorkers','hibernateAfterMin'): active[k]=source_config[k]
   data=(json.dumps(active,indent=2)+'\n').encode()
  elif name=='@launcher': data=(ROOT/'scripts/helio-wsl').read_bytes()
  elif name.startswith('@inbound/'): data=(ROOT/'discord-inbound'/name[9:]).read_bytes()
  elif name.startswith('@messenger/'): data=(ROOT/'vendor/dori-mode/scripts/src/messenger'/name[11:]).read_bytes()
  else: data=PAYLOAD['plain'](name).read_bytes()
  desired[name]=data
 retired={name:dst/name for name in RETIRED if (dst/name).is_file() and not (dst/name).is_symlink()}
 # Intake files this installer recorded that the kit no longer ships (e.g. after a move) are retired the same way.
 inbound=home/'.dori/discord-inbound'
 dropped=[n for n in baseline if n.startswith('@inbound/') and n[9:] not in INBOUND_FILES]
 retired.update({n:inbound/n[9:] for n in dropped if (inbound/n[9:]).is_file() and not (inbound/n[9:]).is_symlink()})
 def reviewed(name,value): return value==baseline.get(name) or value in SHIPPED[profile].get(name,())
 # Already-converged files need no write, even with an older or missing baseline.
 # Config preserves local fields in desired, so equality cannot authorize its drift.
 conflicts=[n for n in names if not reviewed(n,current[n]) and not (n=='config.json' and config_matches)
            and not (n!='config.json' and current[n]==digest(desired[n]))]
 conflicts+=[n for n,p in retired.items() if not reviewed(n,digest(p.read_bytes()))]
 if conflicts:
  print('Local changes need review; nothing updated: '+', '.join(conflicts))
  if recorded_profile is None: print('If this is the owner home (not the isolated runtime), run once: python3 scripts/sync-install.py --profile owner')
  raise SystemExit(1)
 changes=[n for n in names if digest(desired[n])!=current[n]]
 settings=Path(mapping['HELIO_PROJECT'])/'.omo/settings.json'
 for parent in settings.parents:
  if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
   raise SystemExit(f'Unsafe project settings directory: {parent}')
 if settings.is_symlink() or (settings.exists() and not settings.is_file()):
  raise SystemExit(f'Unsafe project settings file: {settings}')
 project_settings=json.loads(settings.read_text()) if settings.exists() else {}
 if not isinstance(project_settings,dict) or not isinstance(project_settings.get('terminal',{}),dict):
  raise SystemExit(f'Expected project settings and terminal to be objects: {settings}')
 terminal=project_settings.setdefault('terminal',{})
 settings_changed=terminal.get('monitorMaxCharsPerInjection')!=16384
 terminal['monitorMaxCharsPerInjection']=16384
 print('Managed updates: '+(', '.join(changes) if changes else 'none'))
 print(f'Project terminal.monitorMaxCharsPerInjection: {"set to 16384" if settings_changed else "unchanged (16384)"}')
 if retired: print('Retired (no longer used, will be removed): '+', '.join(retired))
 print('Credentials, authorization lists, runtime state, other project settings and memory are excluded.')
 if action=='apply':
  if settings_changed:
   settings.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
   atomic(settings,(json.dumps(project_settings,indent=2)+'\n').encode())
  DOCS['organize'](dst,True,documents)
  for name in DOCS['RUNBOOKS']:
   paths[name]=dst/'docs'/name
  baseline['_configLeadPane']=active.get('leadPane', '')
  for name in changes:
   paths[name].parent.mkdir(mode=0o700,parents=True,exist_ok=True)
   atomic(paths[name],desired[name]); baseline[name]=digest(desired[name]); atomic(manifest,(json.dumps(baseline,indent=2)+'\n').encode())
  for name,p in retired.items():
   p.unlink(); baseline.pop(name,None)
  for name in dropped: baseline.pop(name,None)
  for name in names:
   baseline[name]=digest(paths[name].read_bytes())
  for name in PAYLOAD['EXECUTABLES']:
   paths[name].chmod((paths[name].stat().st_mode & 0o777) | 0o100)
  baseline['config.json']=digest(paths['config.json'].read_bytes())
  baseline['_profile']=profile
  atomic(manifest,(json.dumps(baseline,indent=2)+'\n').encode())
  print('Updated managed files. Restart Helio and its watchers to load changes.')
  # Startup only reports doc drift; adding missing project docs happens here, never overwriting.
  script=dst/'knowledge-setup.py'
  if (dst/'project-docs').is_dir() and script.is_file() and Path(mapping['HELIO_PROJECT']).is_dir():
   docs=subprocess.run([sys.executable,str(script),'--reconcile-docs'],capture_output=True,text=True,timeout=120,
                       env={**os.environ,'HOME':str(home),'HELIO_PROJECT':mapping['HELIO_PROJECT']})
   print((docs.stdout+docs.stderr).strip() or f'KNOWLEDGE_DOCS exit={docs.returncode}')
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--home',type=Path,default=Path.home())
 p.add_argument('--profile',choices=PROFILES,help='explicit initial profile; later updates use the recorded manifest profile')
 p.add_argument('--update-launcher',action='store_true',help='opt in to updating an adopted inner launcher; never use for the host isolation wrapper')
 group=p.add_mutually_exclusive_group()
 group.add_argument('--adopt',action='store_true')
 group.add_argument('--apply',action='store_true')
 args=p.parse_args()
 home=args.home.expanduser().resolve()
 action='adopt' if args.adopt else 'apply' if args.apply else 'preview'
 if CONFIG['config_path'](home).is_file():
  CONFIG['render'](home,action=='apply')
 elif not (home/'.dori/elobot/env').is_file():
  raise SystemExit('No ~/.config/helio/helio.env and no ~/.dori/elobot/env; see docs/setup.md')
 run(home,action,args.update_launcher,args.profile)
 # The kit ships a copy of the owner's skills; say when the owner's own copy has moved on.
 for name in PAYLOAD['SKILLS']:
  own=Path.home()/'.agents'/name
  if own.is_file() and own.read_bytes()!=PAYLOAD['plain'](name).read_bytes():
   print(f'Note: {own} differs from the kit copy agent/{name}; copy it into the kit to ship it.')
if __name__=='__main__': main()
