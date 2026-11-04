#!/usr/bin/env python3
"""Read-only summary of Helio's local setup. Never display credential values."""
import json, os, re, sqlite3, subprocess
from contextlib import closing
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
state=Path(os.environ.get('DORI_STATE_DIR',str(base/'state')))
active_claims: set[str]=set()
conversation_db=state/'discord-conversations.sqlite'
if conversation_db.exists():
 try:
  with closing(sqlite3.connect(f'file:{conversation_db}?mode=ro',uri=True)) as con:
   columns={row[1] for row in con.execute("PRAGMA table_info(working)")}
   claim="claimed_at IS NOT NULL" if 'claimed_at' in columns else "reacted=1"
   active_claims={row[0] for row in con.execute(f"SELECT message_id FROM working WHERE closed_at IS NULL AND {claim}")}
   waiting=con.execute("""SELECT count(*) FROM conversations c WHERE c.status='open'
    AND c.user_id=(SELECT t.author_id FROM transcript t WHERE t.channel_id=c.channel_id
     AND t.user_id=c.user_id AND t.opened_at=c.opened_at ORDER BY t.rowid DESC LIMIT 1)""").fetchone()[0]
  show('Claims in progress',str(len(active_claims)))
  show('Conversations waiting on Helio',str(waiting))
 except sqlite3.Error:
  show('Claims in progress','unavailable'); show('Conversations waiting on Helio','unavailable')
else:
 show('Claims in progress','0'); show('Conversations waiting on Helio','0')
db=state/'discord-delivery.sqlite'
if db.exists():
 try:
  with closing(sqlite3.connect(f'file:{db}?mode=ro',uri=True)) as con:
   pending=con.execute("SELECT id FROM delivery WHERE stream='inbound' AND payload IS NOT NULL").fetchall()
   accepted={row[0] for row in con.execute("SELECT id FROM acceptance WHERE stream='inbound'")} if con.execute("SELECT 1 FROM sqlite_master WHERE name='acceptance'").fetchone() else set()
  show('Pending inbound',str(len(pending)))
  show('Unclaimed pending inbound',str(sum(row[0] not in active_claims and row[0] not in accepted for row in pending)))
 except sqlite3.Error:
  show('Pending inbound','unavailable'); show('Unclaimed pending inbound','unavailable')
else:
 show('Pending inbound','no local queue'); show('Unclaimed pending inbound','0')
try:
 plans=subprocess.run(['python3',str(Path(__file__).resolve().parent/'helio-plan.py'),'list'],capture_output=True,text=True,timeout=60)
 m=re.match(r'PLANS_AWAITING count=(\d+)',plans.stdout)
 show('Plans awaiting approval',m.group(1) if plans.returncode==0 and m else 'unavailable')
except (OSError,subprocess.TimeoutExpired): show('Plans awaiting approval','unavailable')
show('Production SSH / beta setup','not checked by this status command')
