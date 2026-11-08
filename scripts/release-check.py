#!/usr/bin/env python3
"""Verify a specific, still-pending Discord release approval. Performs no production action."""
import argparse, hashlib, json, os, re, runpy, sqlite3, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
HOME=Path.home(); BASE=HOME/'.dori/elobot'; STATE=Path(os.environ.get('DORI_STATE_DIR', str(BASE/'state')))
APPROVAL=runpy.run_path(str(Path(__file__).resolve().parent/'helio_approval.py'))
ISSUE_LINK=runpy.run_path(str(Path(__file__).resolve().parent/'helio_issue_link.py'))
REPO=os.environ.get('HELIO_GITHUB_REPO','jamestesting0/elo-bot')
class Refused(Exception): pass
def ids(path):
 try: values=[x.strip() for x in path.read_text().split(',') if x.strip()]
 except OSError as e: raise Refused(f'cannot read {path.name}') from e
 if any(not re.fullmatch(r'\d+',x) for x in values): raise Refused(f'invalid {path.name}')
 return set(values)
def parse_target(action,target,revision):
 if action in ('plan','work'):
  m=re.fullmatch(re.escape(REPO)+r'#([1-9][0-9]*)',target)
  if not m: raise Refused(f'{action} target must be {REPO}#<issue>')
  return int(m.group(1))
 if not re.fullmatch(r'[0-9a-f]{40}',revision): raise Refused('revision must be a lowercase full 40-character commit SHA')
 if action in ('merge','pr'):
  m=re.fullmatch(re.escape(REPO)+r'#([1-9][0-9]*)',target)
  if not m: raise Refused(f'target must be {REPO}#<PR>')
  return int(m.group(1))
 if target!='elobot': raise Refused('restart target must be elobot')
 return None
def verify(payload, live, action, target, revision, owner, trusted, channel_ok, is_dm, bot_id='', now=None, not_before=None,*,resolved_plan=False):
 pr=parse_target(action,target,revision)
 author=verify_source(payload,live,owner,trusted,channel_ok)
 try: APPROVAL['check_intent'](action,live,bot_id,REPO,pr,now=now,not_before=not_before,resolved_plan=resolved_plan)
 except APPROVAL['Refused'] as e: raise Refused(str(e)) from None
 return author
def verify_source(payload,live,owner,trusted,channel_ok):
 """Human identity, unchanged content and current location/trust, shared by decisions."""
 author=str(payload.get('author_id',''))
 if payload.get('for_owner'): raise Refused('a message addressed to the owner never approves a Helio action')
 if live.get('id')!=payload.get('message_id') or live.get('channel_id')!=payload.get('channel_id'): raise Refused('message identity changed')
 if live.get('author',{}).get('id')!=author or live.get('author',{}).get('bot') or live.get('webhook_id'): raise Refused('author is not a matching human sender')
 fingerprint=(payload.get('discord_origin') or {}).get('content_sha256')
 live_text=live.get('content','')
 edited=hashlib.sha256(live_text.encode()).hexdigest()!=fingerprint if fingerprint else live_text.strip()!=str(payload.get('content','')).strip()
 if edited: raise Refused('the approval message was edited after it was received; ask for a fresh one')
 if author==owner:
  if not channel_ok: raise Refused('owner confirmation must be in a permitted location')
 elif author not in trusted or not channel_ok: raise Refused('sender is not currently an authorized release approver in an allowed location')
 return author
def api(path,token):
 req=urllib.request.Request('https://discord.com/api/v10'+path,headers={'Authorization':'Bot '+token,'User-Agent':'DiscordBot (https://discord.com, 1.0)'})
 try:
  with urllib.request.urlopen(req,timeout=10) as r: return json.load(r)
 except (urllib.error.URLError,ValueError) as e: raise Refused('Discord verification failed') from e
def pr_view(repo,num,run=None,sleep=None):
 run=run or subprocess.run; sleep=sleep or time.sleep
 argv=['gh','pr','view',num,'--repo',repo,'--json','state,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences,body']
 reason=''
 for attempt in (1,2):
  try:
   r=run(argv,capture_output=True,text=True,timeout=30)
   if not r.returncode: return json.loads(r.stdout)
   reason=(r.stderr or r.stdout).strip()[-200:] or f'gh exited {r.returncode}'
  except subprocess.TimeoutExpired: reason='gh timed out after 30 seconds'
  if attempt==1: sleep(3)
 raise Refused(f'cannot read PR #{num} from GitHub after one retry: {reason}')
def require_passing(rollup):
 passed,running,failing=[],[],[]
 for c in rollup or []:
  name=c.get('name') or c.get('context') or 'unnamed check'
  if 'conclusion' in c or 'status' in c:
   conclusion=str(c.get('conclusion') or '').upper()
   if str(c.get('status','')).upper()!='COMPLETED': running.append(name)
   elif conclusion=='SUCCESS': passed.append(name)
   elif conclusion not in ('SKIPPED','NEUTRAL'): failing.append(f'{name}={conclusion or "unknown"}')
  else:
   state=str(c.get('state') or '').upper()
   if state=='SUCCESS': passed.append(name)
   elif state in ('PENDING','EXPECTED'): running.append(name)
   else: failing.append(f'{name}={state or "unknown"}')
 if failing: raise Refused('PR checks failing: '+', '.join(failing))
 if running: raise Refused('PR checks still running: '+', '.join(running)+'; check again when they finish')
 if not passed: raise Refused('PR has no passing check')
def require_mergeable(mergeable: str, status: str) -> None:
 if mergeable!='MERGEABLE' or status not in ('CLEAN','HAS_HOOKS'):
  raise Refused(f'PR merge readiness is {mergeable}/{status}; inspect current main, conflicts, checks and repository requirements before acting')
def github_revision(path: str, field: str) -> str:
 result=subprocess.run(['gh','api',path,'--jq',field],capture_output=True,text=True,timeout=30)
 revision=result.stdout.strip()
 if result.returncode or not re.fullmatch(r'[0-9a-f]{40}',revision):
  detail=(result.stderr or revision).strip()[-200:]
  raise Refused(f'GitHub base inspection unavailable: {detail}')
 return revision
def load(message_id, work_channel=None, work_fingerprint=None):
 """The pending inbound delivery and its live Discord state; shared with helio-plan.py."""
 if not re.fullmatch(r'\d+',message_id): raise Refused('message must be a numeric ID')
 token=os.environ.get('DORI_DISCORD_TOKEN',''); owner=os.environ.get('DORI_DISCORD_OWNER_ID',''); allowed=set(os.environ.get('DORI_DISCORD_ALLOWED','').split(','))
 if not token or not re.fullmatch(r'\d+',owner): raise Refused('missing Discord token or owner ID')
 db=sqlite3.connect(f'file:{STATE / "discord-delivery.sqlite"}?mode=ro',uri=True)
 try:
  row=db.execute("SELECT payload FROM delivery WHERE stream='inbound' AND id=? AND payload IS NOT NULL",(message_id,)).fetchone()
  accepted=False
  if work_channel is not None and db.execute("SELECT 1 FROM sqlite_master WHERE name='acceptance'").fetchone():
   accepted=db.execute("SELECT 1 FROM acceptance WHERE stream='inbound' AND id=?",(message_id,)).fetchone() is not None
 finally: db.close()
 if not row and not (work_channel is not None and (accepted or work_fingerprint)):
  raise Refused('confirmation is not an unacknowledged inbound delivery')
 payload=json.loads(row[0]) if row else None
 channel_id=str(payload.get('channel_id','')) if payload is not None else str(work_channel)
 if not re.fullmatch(r'\d+',channel_id): raise Refused('invalid channel')
 live=api(f'/channels/{channel_id}/messages/{message_id}',token)
 if payload is None:
  if not work_fingerprint and live.get('edited_timestamp'):
   raise Refused('accepted request was edited and its original fingerprint is unavailable; inspect the current request')
  payload={'message_id':message_id,'channel_id':channel_id,'author_id':str((live.get('author') or {}).get('id','')),
           'content':live.get('content','')}
 if work_fingerprint:
  payload={**payload,'discord_origin':{'content_sha256':work_fingerprint}}
 if accepted or work_fingerprint:
  live={**live,'_helio_accepted_work':True}
 bot_id=str(api('/users/@me',token).get('id',''))
 permitted,dm=location(channel_id,token,allowed)
 return dict(payload=payload,live=live,owner=owner,trusted=ids(BASE/'trusted-users'),channel_ok=permitted,is_dm=dm,bot_id=bot_id)
def location(channel_id,token,allowed):
 current=api(f'/channels/{channel_id}',token); dm=current.get('type')==1; permitted=dm
 for _ in range(3):
  if str(current.get('id','')) in allowed: permitted=True; break
  parent=current.get('parent_id')
  if not parent: break
  current=api(f'/channels/{parent}',token)
 return permitted,dm
def prompt_row(prompt_id):
 if not re.fullmatch(r'[0-9a-f]{20}',prompt_id): raise Refused('confirmation must be a prompt ID from helio confirm')
 path=STATE/'discord-prompts.sqlite'
 if not path.is_file() or path.is_symlink(): raise Refused('no button confirmations are recorded')
 db=sqlite3.connect(f'file:{path}?mode=ro',uri=True); db.row_factory=sqlite3.Row
 try: row=db.execute('SELECT * FROM prompts WHERE id=?',(prompt_id,)).fetchone()
 finally: db.close()
 if not row: raise Refused('unknown button confirmation')
 return dict(row)
def load_click(prompt_id,action,target,revision,now=None,not_before=None,*,accepted_plan=False):
 """A recorded button confirmation, re-verified against Discord's own click record and current trust; shared with helio-plan.py."""
 row=prompt_row(prompt_id)
 if row['kind']!=('plan' if action=='plan' else 'confirm') or row['action']!=action or row['target']!=target or row['revision']!=revision:
  raise Refused('the button confirmation is for a different action, target or revision')
 if accepted_plan and action!='plan': raise Refused('accepted-plan verification is only for an already approved plan')
 if row['status']!=('used' if accepted_plan else 'confirmed'): raise Refused(f"the button confirmation is {row['status']}, not confirmed; ask again")
 if not row['result_message_id'] or not row['message_id']: raise Refused('the button confirmation has no recorded result; ask again')
 token=os.environ.get('DORI_DISCORD_TOKEN',''); owner=os.environ.get('DORI_DISCORD_OWNER_ID',''); allowed=set(os.environ.get('DORI_DISCORD_ALLOWED','').split(','))
 if not token or not re.fullmatch(r'\d+',owner): raise Refused('missing Discord token or owner ID')
 channel_id=row['channel_id']
 result=api(f"/channels/{channel_id}/messages/{row['result_message_id']}",token)
 prompt=api(f"/channels/{channel_id}/messages/{row['message_id']}",token)
 bot_id=str(api('/users/@me',token).get('id',''))
 if result.get('id')!=row['result_message_id'] or prompt.get('id')!=row['message_id'] or result.get('channel_id')!=channel_id:
  raise Refused('the recorded confirmation no longer matches Discord')
 number=None if action=='restart' else int(target.rsplit('#',1)[1])
 # A used plan stays accepted while work runs. Revalidate the original click proof
 # and current trust without turning elapsed implementation time into reapproval.
 try:
  if accepted_plan: now=APPROVAL['snowflake_time'](result['id'])
  clicker,clicked=APPROVAL['check_click'](action,result,prompt,bot_id,number,revision,now=now,not_before=not_before,
                                      repo=target.rsplit('#',1)[0] if action!='restart' else None)
 except APPROVAL['Refused'] as e: raise Refused(str(e)) from None
 if not location(channel_id,token,allowed)[0]: raise Refused('the confirmation is outside permitted channels')
 if clicker!=owner and clicker not in ids(BASE/'trusted-users'): raise Refused('the person who clicked is not currently the owner or a trusted user')
 username=str(((result.get('interaction_metadata') or {}).get('user') or {}).get('username') or clicker)
 return dict(clicker=clicker,username=username,clicked=clicked,result_id=row['result_message_id'],channel_id=channel_id)
class AlreadyMerged(Exception): pass
def running_revision():
 """Read the running process revision from the authoritative release broker."""
 client=runpy.run_path(str(Path(__file__).with_name('helio_release_client.py')))
 try: return client['exchange']({'action':'inspect'},timeout=60).get('running_revision')
 except client['ReleaseError'] as error: raise Refused(str(error)) from None
def release_gate(action,target,revision):
 """Current GitHub and hold state for the action; returns the branch whose revision timing applies."""
 if action=='merge':
  repo,num=target.split('#'); pr=pr_view(repo,num)
  if pr.get('state')=='MERGED': raise AlreadyMerged()
  if pr.get('state')=='CLOSED':
   raise Refused('PR is closed without a pending merge; inspect current state instead of asking for a fresh approval')
  if pr.get('state')!='OPEN' or pr.get('headRefOid')!=revision: raise Refused('PR is not open at the confirmed head')
  try: ISSUE_LINK['require_link'](pr.get('body',''),{item['number'] for item in pr.get('closingIssuesReferences') or []},pr.get('baseRefName',''))
  except ISSUE_LINK['Refused'] as error: raise Refused(str(error)) from None
  require_passing(pr.get('statusCheckRollup'))
  require_mergeable(pr.get('mergeable','UNKNOWN'),pr.get('mergeStateStatus','UNKNOWN'))
  branch=urllib.parse.quote(pr['baseRefName'],safe='')
  base=github_revision(f'repos/{repo}/branches/{branch}','.commit.sha')
  common=github_revision(f'repos/{repo}/compare/{base}...{revision}?per_page=1','.merge_base_commit.sha')
  if common!=base:
   raise Refused('PR head does not include the current base; integrate it and verify the new head before merging')
  require_no_holds('merge',pr)
  return pr.get('headRefName','')
 if action=='restart':
  require_no_holds('restart')
 return 'main'
def require_no_holds(action,pr=None):
 path=STATE/'decisions.sqlite'
 if not path.exists(): return
 ledger=runpy.run_path(str(Path(__file__).with_name('helio_decisions.py')))
 db=ledger['connect'](path)
 try:
  issues={int(item['number']) for item in (pr or {}).get('closingIssuesReferences',[])}
  body=(pr or {}).get('body','')
  issues|={int(number) for number in re.findall(r'\b(?:fix(?:es)?|close[sd]?|resolve[sd]?|implements|refs|related to)\s+#(\d+)\b',body,re.I)}
  issues|={int(number) for number in re.findall(r'https://github\.com/'+re.escape(REPO)+r'/issues/(\d+)\b',body)}
  if action=='restart':
   issues={int(item['scope'][6:]) for item in ledger['active'](db,REPO) if item['scope'].startswith('issue#')}
  blocking=ledger['holds'](db,REPO,issues,action)
 finally: db.close()
 if blocking: raise Refused('Active issue hold '+blocking[0]['id']+' by '+blocking[0]['author_id']+'; ask its author or the owner to lift it. Use helio decide list for private details.')
def main():
 p=argparse.ArgumentParser(description=__doc__)
 source=p.add_mutually_exclusive_group(required=True)
 source.add_argument('--message'); source.add_argument('--confirmation'); source.add_argument('--preflight',action='store_true')
 p.add_argument('--action',choices=['merge','restart','pr'],required=True); p.add_argument('--target',required=True); p.add_argument('--revision',required=True); a=p.parse_args()
 try:
  if a.message is not None and (a.action=='pr' or not re.fullmatch(r'\d+',a.message)): raise Refused('message must be a numeric ID for a merge or restart')
  parse_target(a.action,a.target,a.revision)
  if a.preflight:
   release_gate(a.action,a.target,a.revision)
   print(f'PREFLIGHT_OK action={a.action} target={a.target} revision={a.revision}')
   return 0
  if a.confirmation is not None:
   release_gate(a.action,a.target,a.revision)
   click=load_click(a.confirmation,a.action,a.target,a.revision)
   print(f"APPROVAL_VALID action={a.action} target={a.target} revision={a.revision} sender={click['clicker']} confirmation={a.confirmation} result={click['result_id']} channel={click['channel_id']}")
   print(f'CHECK ONLY: nothing was performed. Run helio confirm use {a.confirmation} immediately before acting; it can be used once.')
   return 0
  m=load(a.message); live=m['live']
  verify_source(m['payload'],live,m['owner'],m['trusted'],m['channel_ok'])
  branch=release_gate(a.action,a.target,a.revision)
  author=verify(m['payload'],live,a.action,a.target,a.revision,m['owner'],m['trusted'],m['channel_ok'],m['is_dm'],m['bot_id'])
  path=STATE/'discord-delivery.sqlite'
  with sqlite3.connect(f'file:{path}?mode=ro',uri=True) as db:
   table=db.execute("SELECT 1 FROM sqlite_master WHERE name='inbound_recovery'").fetchone()
   review=db.execute("SELECT outcome,reviewed_at FROM inbound_recovery WHERE id=?",(a.message,)).fetchone() if table else None
  if review and (review[0]!='resume' or not review[1]): raise Refused('Recovered request needs helio recovery scan/review; do not ask for another approval yet')
  try:
   combined=a.action=='restart' and APPROVAL['combined_pr'](live,REPO,m['bot_id']) is not None
   APPROVAL['check_revision'](a.revision,live,REPO,branch,running_revision=running_revision() if combined else None,bot_id=m['bot_id'])
  except APPROVAL['Refused'] as e: raise Refused(str(e)) from None
  print(f'APPROVAL_VALID action={a.action} target={a.target} revision={a.revision} sender={author} message={a.message}')
  print('CHECK ONLY: no merge or restart was performed. Follow the work policy and recheck immediately before action.')
 except AlreadyMerged:
  print(f'RELEASE_ALREADY_MERGED target={a.target}; no merge or fresh approval is needed. Reconcile the completed outcome.')
  return 4
 except (Refused,OSError,sqlite3.Error,subprocess.SubprocessError,ValueError,KeyError) as e:
  print('APPROVAL_REFUSED: '+str(e),file=sys.stderr); return 2
 return 0
if __name__=='__main__': sys.exit(main())
