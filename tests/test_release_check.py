import datetime,runpy,unittest,os,json,sqlite3,tempfile,sys
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
m=runpy.run_path(str(Path(__file__).resolve().parent.parent/'scripts/release-check.py'))
def stamp(minutes_ago=1): return (datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=minutes_ago)).isoformat()
class ReleaseCheckTests(unittest.TestCase):
 def setUp(self):
  self.sha='a'*40; self.target='jamestesting0/elo-bot#42'; self.text='yep merge #42 please'
  self.payload={'author_id':'42','channel_id':'50','message_id':'60','content':self.text}
  self.live={'id':'60','channel_id':'50','author':{'id':'42','bot':False},'content':self.text,'timestamp':stamp()}
 def check(self,**kw):
  args=dict(payload=self.payload,live=self.live,action='merge',target=self.target,revision=self.sha,owner='1',trusted={'42'},channel_ok=True,is_dm=False,bot_id='7'); args.update(kw); return m['verify'](**args)
 def test_natural_approval_from_current_approver(self): self.assertEqual(self.check(),'42')
 def test_revoked_sender_and_wrong_target_refused(self):
  with self.assertRaises(m['Refused']): self.check(trusted=set())
  with self.assertRaises(m['Refused']): self.check(target='jamestesting0/elo-bot#43')
 def test_edited_unrelated_stale_and_bot_messages_refused(self):
  self.live['content']='yep merge #42 and also #43'
  with self.assertRaises(m['Refused']): self.check()
  self.payload['content']=self.live['content']='lol'
  with self.assertRaises(m['Refused']): self.check()
  self.payload['content']=self.live['content']=self.text; self.live['timestamp']=stamp(30)
  with self.assertRaises(m['Refused']): self.check()
  self.live['timestamp']=stamp(); self.live['author']['bot']=True
  with self.assertRaises(m['Refused']): self.check()
 def test_link_approval_matches_by_fingerprint_not_rewritten_text(self):
  import hashlib
  raw='merge https://github.com/jamestesting0/elo-bot/pull/42 please'
  self.live['content']=raw
  self.payload['content']='merge jamestesting0/elo-bot#42 (pull request) please'
  self.payload['discord_origin']={'content_sha256':hashlib.sha256(raw.encode()).hexdigest()}
  self.assertEqual(self.check(),'42')
  self.live['content']=raw+' and #43'
  with self.assertRaises(m['Refused']): self.check()
 def test_yes_reply_to_helio_question_is_an_approval(self):
  self.payload['content']=self.live['content']='yes'
  self.live['referenced_message']={'content':'Merge jamestesting0/elo-bot#42 (head aaaaaaa)?','author':{'id':'7'}}
  self.assertEqual(self.check(),'42')
 def test_owner_requires_permitted_location(self):
  with self.assertRaises(m['Refused']): self.check(owner='42',channel_ok=False)
  self.assertEqual(self.check(owner='42',channel_ok=True),'42')
def snowflake(minutes_ago): return str(int(((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=minutes_ago)).timestamp()*1000-1420070400000))<<22)
class ButtonConfirmationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
  self.base=Path(self.tmp.name); self.state=self.base/'state'; self.state.mkdir(); (self.base/'trusted-users').write_text('42')
  self.sha='a'*40; self.target='jamestesting0/elo-bot#42'; self.pid='0'*19+'1'
  self.prompt={'id':snowflake(3),'channel_id':'50','author':{'id':'7','bot':True},'content':'Merge #42 · `aaaaaaa`?'}
  click=snowflake(2)
  self.result={'id':str(int(click)+(1<<22)),'channel_id':'50','author':{'id':'7','bot':True},'webhook_id':'7','content':'✅ <@42> confirmed merge #42 · `aaaaaaa`',
   'interaction_metadata':{'id':click,'type':3,'user':{'id':'42','username':'staff'},'interacted_message_id':self.prompt['id']}}
  self.row={'id':self.pid,'kind':'confirm','action':'merge','target':self.target,'revision':self.sha,'status':'confirmed','channel_id':'50',
   'message_id':self.prompt['id'],'result_message_id':self.result['id']}
  self.pr={'state':'OPEN','headRefOid':self.sha,'headRefName':'fix','baseRefName':'main','body':'',
   'statusCheckRollup':[{'name':'Unit tests','status':'COMPLETED','conclusion':'SUCCESS'}]}
 def run_cli(self,*extra):
  db=sqlite3.connect(self.state/'discord-prompts.sqlite'); db.execute('DROP TABLE IF EXISTS prompts')
  db.execute('CREATE TABLE prompts('+','.join(self.row)+')'); db.execute('INSERT INTO prompts VALUES('+','.join('?'*len(self.row))+')',tuple(self.row.values())); db.commit(); db.close()
  def api(path,token):
   if path=='/users/@me': return {'id':'7'}
   if path.endswith('/'+self.prompt['id']): return json.loads(json.dumps(self.prompt))
   if '/messages/' in path: return json.loads(json.dumps(self.result))
   return {'id':'50','type':0}
  def run(argv,**kw):
   class R: returncode=0; stdout=json.dumps(self.pr)
   return R()
  g=m['main'].__globals__; env={'DORI_DISCORD_TOKEN':'fake','DORI_DISCORD_OWNER_ID':'1','DORI_DISCORD_ALLOWED':'50'}
  argv=['release-check',*(extra or ('--confirmation',self.pid)),'--action','merge','--target',self.target,'--revision',self.sha]
  out,err=StringIO(),StringIO()
  with patch.dict(os.environ,env),patch.dict(g,{'BASE':self.base,'STATE':self.state,'api':api}),patch.object(sys,'argv',argv),patch.object(g['subprocess'],'run',run),redirect_stdout(out),redirect_stderr(err):
   return m['main'](),out.getvalue()+err.getvalue()
 def test_a_recorded_click_by_a_trusted_user_is_valid(self):
  code,out=self.run_cli()
  self.assertEqual(code,0,out); self.assertIn('APPROVAL_VALID action=merge',out); self.assertIn('sender=42',out); self.assertIn(f'helio confirm use {self.pid}',out)
 def test_unconfirmed_mismatched_or_untrusted_clicks_are_refused(self):
  cases={'cancelled':lambda:self.row.update(status='cancelled'),'used':lambda:self.row.update(status='used'),
   'other target':lambda:self.row.update(target='jamestesting0/elo-bot#43'),
   'untrusted':lambda:(self.result['interaction_metadata']['user'].update(id='5'),self.result.update(content='✅ <@5> confirmed merge #42 · `aaaaaaa`')),
   'other channel':lambda:self.row.update(channel_id='51'),
   'head moved':lambda:self.pr.update(headRefOid='b'*40)}
  for name,change in cases.items():
   with self.subTest(name):
    self.setUp(); change(); code,out=self.run_cli()
    self.assertEqual(code,2,out); self.assertIn('APPROVAL_REFUSED',out)
 def test_preflight_checks_github_without_any_approval(self):
  code,out=self.run_cli('--preflight'); self.assertEqual(code,0,out); self.assertIn('PREFLIGHT_OK',out)
  self.pr['state']='MERGED'; code,out=self.run_cli('--preflight'); self.assertEqual(code,4); self.assertIn('RELEASE_ALREADY_MERGED',out)
class ReleaseCliTests(unittest.TestCase):
 def test_pending_approval_must_match_live_message_head_and_checks(self):
  with tempfile.TemporaryDirectory() as tmp:
   base=Path(tmp); state=base/'state'; state.mkdir(); (base/'trusted-users').write_text('42'); (base/'release-approvers').write_text('42')
   sha='a'*40; target='jamestesting0/elo-bot#42'; text=f'merge #42 at {sha[:7]}'
   payload={'author_id':'42','channel_id':'50','message_id':'60','content':text}
   db=sqlite3.connect(state/'discord-delivery.sqlite'); db.execute('CREATE TABLE delivery(stream TEXT,id TEXT,payload TEXT)'); db.execute('INSERT INTO delivery VALUES(?,?,?)',('inbound','60',json.dumps(payload))); db.commit(); db.close()
   live={'id':'60','channel_id':'50','author':{'id':'42','bot':False},'content':text,'timestamp':stamp()}
   def api(path,token): return {'id':'7'} if path=='/users/@me' else live if '/messages/' in path else {'id':'50','type':0}
   def run(argv,**kw):
    class R: returncode=0; stdout=json.dumps({'state':'OPEN','headRefOid':sha,'headRefName':'fix',
     'statusCheckRollup':[{'__typename':'CheckRun','name':'Unit tests','status':'COMPLETED','conclusion':'SUCCESS'}]})
    return R()
   g=m['main'].__globals__; env={'DORI_DISCORD_TOKEN':'fake','DORI_DISCORD_OWNER_ID':'1','DORI_DISCORD_ALLOWED':'50'}
   argv=['release-check','--message','60','--action','merge','--target',target,'--revision',sha]
   with patch.dict(os.environ,env),patch.dict(g,{'BASE':base,'STATE':state,'api':api}),patch.object(sys,'argv',argv),patch.object(g['subprocess'],'run',run),redirect_stdout(StringIO()):
    self.assertEqual(m['main'](),0)
    live['content']='changed'
    with redirect_stderr(StringIO()): self.assertEqual(m['main'](),2)
    live['content']=text; live['timestamp']=stamp(120)
    def merged(argv,**kw):
     result=run(argv,**kw); result.stdout=json.dumps({'state':'MERGED','headRefOid':sha})
     return result
    output=StringIO()
    with patch.object(g['subprocess'],'run',merged),redirect_stdout(output):
     self.assertEqual(m['main'](),4)
    self.assertIn('RELEASE_ALREADY_MERGED',output.getvalue())
    self.assertIn('no merge or fresh approval',output.getvalue())
class PullRequestStateTests(unittest.TestCase):
 def run_results(self,*results):
  calls=[]
  def run(argv,**kw):
   calls.append(argv); r=results[len(calls)-1]
   if isinstance(r,Exception): raise r
   return r
  return run,calls
 def result(self,code,out='',err=''):
  class R: pass
  r=R(); r.returncode=code; r.stdout=out; r.stderr=err; return r
 def test_one_transient_failure_is_retried_and_the_view_includes_checks(self):
  ok=self.result(0,json.dumps({'state':'OPEN','statusCheckRollup':[]}))
  run,calls=self.run_results(self.result(1,err='HTTP 502: Bad Gateway'),ok)
  self.assertEqual(m['pr_view']('o/r','6',run=run,sleep=lambda s:None)['state'],'OPEN')
  self.assertEqual(len(calls),2); self.assertIn('statusCheckRollup',calls[0][-1])
 def test_two_failures_report_ghs_own_reason(self):
  run,_=self.run_results(self.result(1,err='HTTP 502: Bad Gateway'),m['subprocess'].TimeoutExpired('gh',30))
  with self.assertRaisesRegex(m['Refused'],'after one retry: gh timed out'): m['pr_view']('o/r','6',run=run,sleep=lambda s:None)
  run,_=self.run_results(self.result(1,err='HTTP 502: Bad Gateway'),self.result(1,err='HTTP 401: Bad credentials'))
  with self.assertRaisesRegex(m['Refused'],'Bad credentials'): m['pr_view']('o/r','6',run=run,sleep=lambda s:None)
 def test_check_results_name_what_blocks_the_merge(self):
  run=lambda name,status='COMPLETED',conclusion='SUCCESS':{'__typename':'CheckRun','name':name,'status':status,'conclusion':conclusion}
  m['require_passing']([run('Unit tests'),run('Lint',conclusion='SKIPPED'),{'__typename':'StatusContext','context':'ci/legacy','state':'SUCCESS'}])
  for rollup,reason in (([run('Unit tests'),run('Integration tests',conclusion='FAILURE')],'failing: Integration tests=FAILURE'),
                        ([run('Unit tests',status='IN_PROGRESS',conclusion='')],'still running: Unit tests'),
                        ([{'__typename':'StatusContext','context':'ci/legacy','state':'ERROR'}],'failing: ci/legacy=ERROR'),
                        ([run('Lint',conclusion='SKIPPED')],'no passing check'),([],'no passing check')):
   with self.subTest(reason=reason),self.assertRaisesRegex(m['Refused'],reason): m['require_passing'](rollup)
if __name__=='__main__': unittest.main()
