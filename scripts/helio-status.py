#!/usr/bin/env python3
"""Read-only summary of Helio's local setup. Never display credential values."""
import json, os, re, sqlite3, subprocess
from pathlib import Path
h=Path.home(); base=h/'.dori/elobot'; config=base/'config.json'; project=h/'PythonProjects/elo-bot'
def show(label, value): print(f'{label}: {value}')
def command(argv):
 try:
  p=subprocess.run(argv, capture_output=True, text=True, timeout=8, env={**os.environ,'PATH':str(h/'.bun/bin')+':'+str(h/'.local/bin')+':'+os.environ.get('PATH','')})
  return p.returncode, p.stdout.strip()
 except (OSError, subprocess.TimeoutExpired): return 1, ''
show('Project', str(project) if (project/'.git').exists() else 'MISSING')
show('Private environment', 'present' if (base/'env').is_file() else 'MISSING')
try:
 line=(base/'start').read_text(); m=re.search(r'--model\s+(\S+)\s+--thinking\s+(\S+)',line); show('Lead model',f'{m.group(1)}:{m.group(2)}' if m else 'unknown')
except OSError: show('Lead model','unavailable')
show('Memory', 'present' if (h/'.omo/memory/agents/elobot-ec289b4c/repo/.git').is_dir() else 'MISSING')
if config.exists():
 try:
  c=json.loads(config.read_text()); show('Worker default',c.get('defaultModel','MISSING')); show('Lead pane',c.get('leadPane') or 'not registered')
 except (ValueError,OSError): show('Dori config','INVALID')
code,out=command(['herdr','--session','elobot','status','server']); show('Herdr elobot session','running' if code==0 and 'status: running' in out.splitlines() else 'not running')
code,out=command(['bsk','doctor','--json'])
try:
 checks=json.loads(out); conn=next((x for x in checks if x.get('name')=='extension connected'),{}); show('BrowserSkill',conn.get('detail','unknown'))
except (ValueError,TypeError): show('BrowserSkill','unavailable')
try:
 categories=json.loads((project/'.omo/omo.jsonc').read_text()).get('[native]',{}).get('categories',{}); show('Project categories',', '.join(f"{n}={categories[n].get('model','?')}:{categories[n].get('reasoning','?')}" for n in ('deep-low','deep-high') if n in categories) or 'no local overrides')
except (OSError,ValueError): show('Project categories','unavailable')
show('Trusted-user lists','present' if all((base/x).is_file() for x in ['trusted-users','report-channels']) else 'MISSING')
watcher=False
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit(): continue
 try:
  args=(proc/'cmdline').read_bytes().split(b'\0')
  if any(arg == str(h/'.dori/discord-inbound/inbound.ts').encode() for arg in args): watcher=True; break
 except (OSError,PermissionError): continue
show('Discord watcher','running' if watcher else 'not running')
db=base/'state/discord-delivery.sqlite'
if db.exists():
 try:
  con=sqlite3.connect(f'file:{db}?mode=ro',uri=True); count=con.execute("SELECT COUNT(*) FROM delivery WHERE stream='inbound' AND payload IS NOT NULL").fetchone()[0]; con.close(); show('Pending inbound',str(count))
 except sqlite3.Error: show('Pending inbound','unavailable')
else: show('Pending inbound','no local queue')
show('Production SSH / beta setup','not checked by this status command')
