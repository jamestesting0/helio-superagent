import datetime,runpy,tempfile,unittest,json,io
from contextlib import redirect_stdout
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

M=runpy.run_path(str(__import__('pathlib').Path(__file__).resolve().parent.parent/'scripts'/'helio_release_service.py'))
OWNER='123456789012345678';TRUSTED='234567890123456789';CHANNEL='345678901234567890';MESSAGE='456789012345678901';REV='a'*40;OLD='b'*40

BOT='777000000000000001'
def snowflake(minutes_ago):
 return str(int(((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=minutes_ago)).timestamp()*1000-1420070400000))<<22)

class ButtonReleaseTests(unittest.TestCase):
 def setUp(self):
  self.config={'token':'dummy','owner':OWNER,'trusted':[TRUSTED],'allowed':[CHANNEL]}
  self.prompt_id=snowflake(3);self.click=snowflake(2);self.result_id=str(int(self.click)+(1000<<22))
  self.prompt={'id':self.prompt_id,'channel_id':CHANNEL,'author':{'id':BOT,'bot':True},'content':'Restart Elo Bot on `aaaaaaa`?'}
  self.result={'id':self.result_id,'channel_id':CHANNEL,'author':{'id':BOT,'bot':True},'webhook_id':BOT,
   'content':f'✅ <@{TRUSTED}> confirmed restart on `aaaaaaa`','interaction_metadata':{'id':self.click,'type':3,'user':{'id':TRUSTED},'interacted_message_id':self.prompt_id}}
  self.state={'ok':True,'clean':True,'head':OLD,'tip':REV,'branch':'main','update_on_start':True,'start_file':'main.py','expected_service':True,'active':True,'restart_permission':True}
 def fetch(self,path,token):
  if path=='/users/@me':return {'id':BOT}
  if path.endswith('/'+self.prompt_id):return json.loads(json.dumps(self.prompt))
  if '/messages/' in path:return json.loads(json.dumps(self.result))
  return {'id':CHANNEL,'type':0}
 def verify(self):return M['verify_confirmation'](CHANNEL,self.result_id,REV,self.config,self.fetch)
 def test_a_trusted_click_on_the_exact_prompt_is_accepted(self):
  self.assertEqual(self.verify(),(TRUSTED,self.prompt_id))
 def test_every_mismatch_is_refused(self):
  cases={
   'untrusted clicker':lambda:(self.result['interaction_metadata'].update(user={'id':'999999999999999999'}),self.result.update(content='✅ <@999999999999999999> confirmed restart on `aaaaaaa`')),
   'other commit':lambda:self.prompt.update(content='Restart Elo Bot on `ccccccc`?'),
   'cancelled prompt':lambda:self.prompt.update(content='Restart Elo Bot on `aaaaaaa`?\n❌ Cancelled by <@1>'),
   'cancel shown as confirm':lambda:self.result.update(content='❌ Cancelled'),
   'other prompt':lambda:self.result['interaction_metadata'].update(interacted_message_id=snowflake(4)),
   'human author':lambda:self.result['author'].update(id=TRUSTED,bot=False),
   'not a click':lambda:self.result['interaction_metadata'].update(type=2),
   'clicked after expiry':lambda:self.prompt.update(id=snowflake(20)),
   'stale click':lambda:(self.prompt.update(id=snowflake(17)),self.result['interaction_metadata'].update(id=snowflake(16)),self.result.update(id=snowflake(16))),
  }
  for name,change in cases.items():
   with self.subTest(name):
    self.setUp();change()
    if name in ('clicked after expiry','stale click'):self.result['interaction_metadata']['interacted_message_id']=self.prompt['id'];self.prompt_id=self.prompt['id']
    with self.assertRaises(M['Refused']):self.verify()
 def test_one_prompt_restarts_once_even_with_another_result_message(self):
  calls=[]
  def run(*args,**kwargs):calls.append(args);return SimpleNamespace(returncode=0)
  with tempfile.TemporaryDirectory() as temp:
   db=Path(temp)/'audit.db'
   request={'action':'restart','channel_id':CHANNEL,'message_id':self.result_id,'revision':REV}
   M['perform'](request,self.config,'/ssh',db,self.fetch,lambda _:dict(self.state,head=REV),run)
   self.result['id']=str(int(self.result_id)+(1<<22))
   with self.assertRaises(M['Refused']):M['perform'](dict(request,message_id=self.result['id']),self.config,'/ssh',db,self.fetch,lambda _:dict(self.state),run)
  self.assertEqual(len(calls),1)

class ReleaseTests(unittest.TestCase):
 def setUp(self):
  self.config={'token':'dummy','owner':OWNER,'trusted':[TRUSTED],'allowed':[CHANNEL]}
  self.message={'id':MESSAGE,'channel_id':CHANNEL,'author':{'id':TRUSTED},'content':'approve restart elobot '+REV,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  self.state={'ok':True,'clean':True,'head':OLD,'tip':REV,'branch':'main','update_on_start':True,'start_file':'main.py','expected_service':True,'active':True,'restart_permission':True}
  self.request={'action':'restart','channel_id':CHANNEL,'message_id':MESSAGE,'revision':REV}
 def fetch(self,path,token):
  if path=='/users/@me':return {'id':'777000000000000001'}
  return dict(self.message) if '/messages/' in path else {'id':CHANNEL,'type':0}
 def test_natural_restart_request_pinned_by_push_time(self):
  pushed=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=5)).isoformat()
  self.message['content']='ok go ahead and restart the bot'
  activity=lambda repo,branch:[{'after':REV,'timestamp':pushed}]
  self.assertEqual(M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch,activity=activity),(TRUSTED,None))
  self.message['content']='nice'
  with self.assertRaises(M['Refused']):M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch,activity=activity)
  self.message['content']='restart it'
  later=lambda repo,branch:[{'after':REV,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}]
  with self.assertRaises(M['Refused']):M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch,activity=later)
 def test_trusted_confirmation_and_owner_confirmation(self):
  self.assertEqual(M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch),(TRUSTED,None))
  self.message['author']={'id':OWNER}
  self.assertEqual(M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch),(OWNER,None))
 def test_rejects_wrong_sender_wrong_revision_and_expired_message(self):
  for change in ('sender','content','age'):
   with self.subTest(change=change):
    original=dict(self.message)
    if change=='sender':self.message['author']={'id':'999999999999999999'}
    elif change=='content':self.message['content']='approve restart elobot '+('c'*40)
    else:self.message['timestamp']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=1)).isoformat()
    with self.assertRaises(M['Refused']):M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch)
    self.message=original
 def test_dirty_or_different_revision_blocks_without_restart(self):
  calls=[]
  with tempfile.TemporaryDirectory() as temp:
   for change in ('clean','tip','expected_service','restart_permission'):
    state=dict(self.state);state[change]=False if change!='tip' else 'c'*40
    with self.subTest(change=change),self.assertRaises(M['Refused']):
     M['perform'](self.request,self.config,'/ssh',Path(temp)/'audit.db',self.fetch,lambda _:state,lambda *a,**k:calls.append(a))
   self.assertEqual(calls,[])
 def test_one_confirmation_cannot_restart_twice_and_no_false_login_claim(self):
  calls=[];states=[dict(self.state),dict(self.state,head=REV)]
  def inspect(_):return states.pop(0) if states else dict(self.state)
  def run(*args,**kwargs):calls.append(args);return SimpleNamespace(returncode=0)
  with tempfile.TemporaryDirectory() as temp:
   db=Path(temp)/'audit.db'
   result=M['perform'](self.request,self.config,'/ssh',db,self.fetch,inspect,run)
   self.assertEqual(result['status'],'restarted');self.assertFalse(result['bot_login_verified'])
   with self.assertRaises(M['Refused']):M['perform'](self.request,self.config,'/ssh',db,self.fetch,inspect,run)
   self.assertEqual(len(calls),1)
 def test_uncertain_result_blocks_replay(self):
  def fail(*a,**k):raise TimeoutError()
  with tempfile.TemporaryDirectory() as temp:
   db=Path(temp)/'audit.db'
   result=M['perform'](self.request,self.config,'/ssh',db,self.fetch,lambda _:self.state,fail)
   self.assertEqual(result['status'],'uncertain')
   with self.assertRaises(M['Refused']):M['perform'](self.request,self.config,'/ssh',db,self.fetch,lambda _:self.state,fail)

class RemoteEvidenceTests(unittest.TestCase):
 def probe(self,reflog_time,updater=False):
  def run(argv,**kw):
   out=''
   if 'status' in argv:out=''
   elif 'rev-parse' in argv:out=REV
   elif 'ls-remote' in argv:out=REV+' refs/heads/main'
   elif 'reflog' in argv:out=REV+' HEAD@{'+str(reflog_time)+'}'
   elif argv[0]=='date':out='200'
   elif 'InvocationID' in argv:out='a'*32
   elif argv[0]=='systemctl':
    if 'InvocationID' in ' '.join(argv):out='a'*32
    else:out='ActiveState=active\nNRestarts=0\nExecMainStartTimestamp=Wed 2026-11-04 16:28:58 UTC\n'
   elif argv[0]=='journalctl':
    entries=[('Logged in as',201000000),(OWNER,202000000),('1212767017917218876',203000000)]
    if updater:entries.insert(0,('[git] Already up to date at '+REV[:7]+'.',200000000))
    if '--reverse' in argv:entries.reverse()
    out='\n'.join(json.dumps({'MESSAGE':text,'__REALTIME_TIMESTAMP':str(stamp)}) for text,stamp in entries)
   return SimpleNamespace(returncode=0,stdout=out)
  output=io.StringIO()
  with patch('subprocess.run',run),patch('builtins.open',lambda *a,**k:io.StringIO('{"repository_branch":"main"}')),redirect_stdout(output):
   exec(M['REMOTE_INSPECT'],{})
  return json.loads(output.getvalue())
 def test_login_and_revision_have_separate_evidence(self):
  result=self.probe(100)
  self.assertEqual(result['login_evidence'],'observed')
  self.assertEqual(result['running_revision'],REV)
  self.assertEqual(result['gateway_health'],'unverified')
 def test_checkout_moved_after_start_is_never_running_revision(self):
  result=self.probe(300)
  self.assertIsNone(result['running_revision'])
  self.assertEqual(result['login_evidence'],'observed')
 def test_updater_record_binds_revision_despite_same_second_reflog(self):
  result=self.probe(200,updater=True)
  self.assertEqual(result['running_revision'],REV)
  self.assertEqual(result['revision_evidence'],'invocation_updater_log')

if __name__=='__main__':unittest.main()
