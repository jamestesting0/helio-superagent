#!/usr/bin/env python3
"""Verify a specific, still-pending Discord release confirmation. Performs no production action."""
import argparse, json, os, re, sqlite3, subprocess, sys, urllib.error, urllib.request
from pathlib import Path
HOME=Path.home(); BASE=HOME/'.dori/elobot'; STATE=Path(os.environ.get('DORI_STATE_DIR', str(BASE/'state')))
class Refused(Exception): pass
def ids(path):
 try: values=[x.strip() for x in path.read_text().split(',') if x.strip()]
 except OSError as e: raise Refused(f'cannot read {path.name}') from e
 if any(not re.fullmatch(r'\d+',x) for x in values): raise Refused(f'invalid {path.name}')
 return set(values)
def expected_text(action,target,revision):
 if not re.fullmatch(r'[0-9a-f]{40}',revision): raise Refused('revision must be a lowercase full 40-character commit SHA')
 if action=='merge':
  if not re.fullmatch(r'jamestesting0/elo-bot#[1-9][0-9]*',target): raise Refused('target must be jamestesting0/elo-bot#<PR>')
 else:
  if target!='elobot': raise Refused('restart target must be elobot')
 return f'approve {action} {target} {revision}'
def verify(payload, live, action, target, revision, owner, trusted, channel_ok, is_dm):
 expected=expected_text(action,target,revision); author=str(payload.get('author_id',''))
 if live.get('id')!=payload.get('message_id') or live.get('channel_id')!=payload.get('channel_id'): raise Refused('message identity changed')
 if live.get('author',{}).get('id')!=author or live.get('author',{}).get('bot') or live.get('webhook_id'): raise Refused('author is not a matching human sender')
 if live.get('content','').strip().lower()!=expected or payload.get('content','').strip().lower()!=expected: raise Refused('confirmation must exactly match: '+expected)
 if author==owner:
  if not channel_ok: raise Refused('owner confirmation must be in a permitted location')
 elif author not in trusted or not channel_ok: raise Refused('sender is not currently an authorized release approver in an allowed location')
 return author
def api(path,token):
 req=urllib.request.Request('https://discord.com/api/v10'+path,headers={'Authorization':'Bot '+token,'User-Agent':'DiscordBot (https://discord.com, 1.0)'})
 try:
  with urllib.request.urlopen(req,timeout=10) as r: return json.load(r)
 except (urllib.error.URLError,ValueError) as e: raise Refused('Discord verification failed') from e
def main():
 p=argparse.ArgumentParser(description=__doc__); p.add_argument('--message',required=True); p.add_argument('--action',choices=['merge','restart'],required=True); p.add_argument('--target',required=True); p.add_argument('--revision',required=True); a=p.parse_args()
 try:
  if not re.fullmatch(r'\d+',a.message): raise Refused('message must be a numeric ID')
  expected_text(a.action,a.target,a.revision)
  token=os.environ.get('DORI_DISCORD_TOKEN',''); owner=os.environ.get('DORI_DISCORD_OWNER_ID',''); allowed=set(os.environ.get('DORI_DISCORD_ALLOWED','').split(','))
  if not token or not re.fullmatch(r'\d+',owner): raise Refused('missing Discord token or owner ID')
  db=sqlite3.connect(f'file:{STATE / "discord-delivery.sqlite"}?mode=ro',uri=True)
  try: row=db.execute("SELECT payload FROM delivery WHERE stream='inbound' AND id=? AND payload IS NOT NULL",(a.message,)).fetchone()
  finally: db.close()
  if not row: raise Refused('confirmation is not an unacknowledged inbound delivery')
  payload=json.loads(row[0]); channel_id=str(payload.get('channel_id',''))
  if not re.fullmatch(r'\d+',channel_id): raise Refused('invalid channel')
  live=api(f'/channels/{channel_id}/messages/{a.message}',token); channel=api(f'/channels/{channel_id}',token); dm=channel.get('type')==1
  current=channel; permitted=dm
  for _ in range(3):
   if str(current.get('id','')) in allowed: permitted=True; break
   parent=current.get('parent_id');
   if not parent: break
   current=api(f'/channels/{parent}',token)
  author=verify(payload,live,a.action,a.target,a.revision,owner,ids(BASE/'trusted-users'),permitted,dm)
  if a.action=='merge':
   repo,num=a.target.split('#'); r=subprocess.run(['gh','pr','view',num,'--repo',repo,'--json','state,headRefOid'],capture_output=True,text=True,timeout=15)
   if r.returncode: raise Refused('cannot read current PR head')
   pr=json.loads(r.stdout)
   if pr.get('state')!='OPEN' or pr.get('headRefOid')!=a.revision: raise Refused('PR is not open at the confirmed head')
   r=subprocess.run(['gh','pr','checks',num,'--repo',repo,'--json','state'],capture_output=True,text=True,timeout=15)
   if r.returncode: raise Refused('PR checks are unavailable or not passing')
   checks=json.loads(r.stdout); states=[x.get('state','').upper() for x in checks]
   if not states or 'SUCCESS' not in states or any(s not in ('SUCCESS','SKIPPED') for s in states): raise Refused('PR requires at least one passing check and no failed or pending checks')
  print(f'APPROVAL_VALID action={a.action} target={a.target} revision={a.revision} sender={author} message={a.message}')
  print('CHECK ONLY: no merge or restart was performed. Follow the work policy and recheck immediately before action.')
 except (Refused,OSError,sqlite3.Error,subprocess.SubprocessError,ValueError,KeyError) as e:
  print('APPROVAL_REFUSED: '+str(e),file=sys.stderr); return 2
 return 0
if __name__=='__main__': sys.exit(main())
