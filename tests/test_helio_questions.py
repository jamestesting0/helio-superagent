import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import io
import json,os,runpy,sqlite3,tempfile,unittest
import urllib.error
import selectors
import subprocess
import sys
import time
from datetime import datetime
from contextlib import closing,redirect_stderr,redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT=Path(__file__).resolve().parent.parent/'scripts/helio-questions.py'
class QuestionTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.m=runpy.run_path(str(SCRIPT));self.g=self.m['create_question'].__globals__
  self.state=Path(self.temp.name);self.patcher=patch.dict(self.g,{'STATE':self.state,'OWNER':'99','TOKEN':'fake','ALLOWED':{'100'}});self.patcher.start();self.addCleanup(self.patcher.stop)
  home=patch.dict(os.environ,{'HOME':str(self.state)});home.start();self.addCleanup(home.stop)
  self.db=self.m['db_connect']();self.addCleanup(self.db.close)
  self.now=datetime.fromisoformat('2026-11-03T12:00:00+00:00').timestamp()
  self.clock=patch('time.time',return_value=self.now)
  self.clock.start()
  self.addCleanup(self.clock.stop)
 def test_staff_answers_use_published_trust_instead_of_the_watchers_startup_environment(self):
  policy=self.state/'.dori/elobot/policy/policy.json';policy.parent.mkdir(parents=True)
  policy.write_text(json.dumps({'version':1,'revision':'a'*64,'values':{'HELIO_TRUSTED_USERS':'77'}}))
  with patch.dict(os.environ,{'DORI_DISCORD_TRUSTED_IDS':'77'}):
   self.assertTrue(self.m['may_answer']({'audience':'staff'},'77'))
   replacement=policy.with_suffix('.next')
   replacement.write_text(json.dumps({'version':1,'revision':'b'*64,'values':{'HELIO_TRUSTED_USERS':'66'}}))
   replacement.replace(policy)
   self.assertFalse(self.m['may_answer']({'audience':'staff'},'77'))
   self.assertTrue(self.m['may_answer']({'audience':'staff'},'66'))
 def pending_answer(self,**changes):
  message={'message_id':'400','channel_id':'200','reply_to':'300','author_id':'99','role':'OWNER_REQUEST','scope':'may-request-work','content':'Use option one','sent_at':'2026-11-03T12:00:00Z','preparation_complete':True}
  message['discord_origin']={'version':1,'message_id':'400','channel_id':'200','author_id':'99','guild_id':None,'bot':False,'webhook_id':None,'mention_ids':[],'reply_to':'300','reply_author_id':'88'}
  message.update(changes)
  return message
 def stage_answer(self,message,accepted=False):
  with closing(sqlite3.connect(self.state/'discord-delivery.sqlite')) as delivery:
   delivery.execute('CREATE TABLE IF NOT EXISTS delivery(stream TEXT,id TEXT,payload TEXT)')
   delivery.execute('CREATE TABLE IF NOT EXISTS acceptance(stream TEXT,id TEXT)')
   delivery.execute('DELETE FROM delivery')
   delivery.execute('DELETE FROM acceptance')
   delivery.execute('INSERT INTO delivery VALUES (?,?,?)',('inbound','400',json.dumps(message)))
   if accepted:
    delivery.execute("INSERT INTO acceptance VALUES ('inbound','400')")
   delivery.commit()
 def test_lane_watcher_reports_persisted_expiry_once_and_replays_it_after_restart(self):
  for qid,lane,status in (('expired-one','lane-one','expired'),('answered-one','lane-one','answered'),('expired-other','lane-two','expired')):
   self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,updated) VALUES (?,?,?,?,?,?,?,?)",
    (qid,qid,lane,'owner','99','Question?',status,int(self.now*1000)))
  self.db.commit()
  def line(process: subprocess.Popen[bytes]) -> str:
   self.assertIsNotNone(process.stdout)
   output=bytearray();deadline=time.monotonic()+8
   with selectors.DefaultSelector() as selector:
    selector.register(process.stdout,selectors.EVENT_READ)
    while True:
     self.assertTrue(selector.select(max(0,deadline-time.monotonic())),'question watcher did not emit the expected event')
     char=os.read(process.stdout.fileno(),1)
     self.assertTrue(char,'question watcher exited before its event')
     if char==b'\n':return output.decode()
     output.extend(char)
  env={**os.environ,'DORI_STATE_DIR':str(self.state),'HOME':str(self.state),'PYTHONDONTWRITEBYTECODE':'1'}
  for _ in range(2):
   with subprocess.Popen([sys.executable,str(SCRIPT),'watch','--lane','lane-one'],env=env,
     stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE) as process:
    try:
     self.assertTrue(line(process).startswith('QUESTION_READY '))
     following=[]
     while not following or not following[-1].startswith('QUESTION_PENDING '):
      following.append(line(process))
     expired=[json.loads(event.partition(' ')[2]) for event in following if event.startswith('QUESTION_EXPIRED ')]
     self.assertEqual([(row['id'],row['lane'],row['status'],row['read']) for row in expired],
      [('expired-one','lane-one','expired','helio question show expired-one')])
    finally:
     process.terminate();process.communicate(timeout=3)
 def test_reconciliation_reauthorizes_pending_answers_and_preserves_eligible_replies(self):
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",('q1','fp','lane-one','thread','77','Question?','awaiting_answer','200','300',int(self.now*1000)))
  self.db.commit()
  cases=[
   ('owner dm',{}, {},'99',True,'OWNER_REQUEST','may-request-work'),
   ('trusted dm',{}, {'DORI_DISCORD_TRUSTED_IDS':'77'},'77',True,'TRUSTED_REQUEST','trusted-pr-merge-restart'),
   ('untrusted dm',{}, {},'77',False,None,None),
   ('normal owner non-ping',{'guild_id':'900'}, {},'99',False,None,None),
   ('normal owner ping',{'guild_id':'900','mention_ids':['88']}, {},'99',True,'OWNER_REQUEST','may-request-work'),
   ('normal human non-ping',{'guild_id':'900'}, {},'77',False,None,None),
   ('normal explicit ping',{'guild_id':'900','mention_ids':['88']}, {},'77',True,'STAFF_QUESTION','answer-only'),
   ('normal other ping',{'guild_id':'900','mention_ids':['89']}, {},'77',False,None,None),
   ('embedded ping only',{'guild_id':'900'}, {},'77',False,None,None),
   ('trusted channel human',{'guild_id':'900'}, {'DORI_DISCORD_TRUSTED_CHANNELS':'100'},'77',True,'STAFF_QUESTION','answer-only'),
   ('revoked channel trust',{'guild_id':'900'}, {},'77',False,None,None),
   ('revoked user trust',{'guild_id':'900','mention_ids':['88']}, {},'77',True,'STAFF_QUESTION','answer-only'),
   ('current reporter',{'guild_id':'900','mention_ids':['88']}, {'DORI_DISCORD_REPORT_CHANNELS':'100'},'77',True,'STAFF_QUESTION','may-report-issue'),
   ('bot with owner id',{'bot':True}, {},'99',False,None,None),
   ('bot with recipient id',{'guild_id':'900','bot':True,'mention_ids':['88']}, {},'77',False,None,None),
   ('webhook',{'webhook_id':'55'}, {},'99',False,None,None),
   ('different author',{}, {},'78',False,None,None),
   ('bot itself',{}, {'DORI_DISCORD_TRUSTED_IDS':'88'},'88',False,None,None),
   ('owner question rejects recipient',{}, {'DORI_DISCORD_TRUSTED_IDS':'77'},'77',False,None,None),
  ]
  for name,origin,env,author,allowed,role,scope in cases:
   with self.subTest(name=name):
    self.db.execute("UPDATE questions SET status='awaiting_answer',audience=?,answer_id=NULL,answer_text=NULL",('owner' if name=='owner question rejects recipient' else 'thread',))
    self.db.commit()
    message=self.pending_answer(author_id=author,role='TRUSTED_REQUEST',scope='trusted-pr-merge-restart')
    if name=='embedded ping only':
     message['content']='Forwarded evidence: <@88> Use option one'
    message['discord_origin'].update(origin,author_id=author)
    self.stage_answer(message)
    def request(method,path,body=None):
     if path=='/users/@me':
      return {'id':'88'}
     if path=='/channels/200':
      return {'id':'200','type':11 if origin.get('guild_id') else 1,'guild_id':origin.get('guild_id'),'parent_id':'100' if origin.get('guild_id') else None}
     if path=='/channels/100':
      return {'id':'100','type':0,'guild_id':'900','parent_id':None}
     raise AssertionError(path)
    with patch.dict('os.environ',env,clear=True),patch.dict(self.g,{'request':request}):
     self.m['reconcile_pending'](self.db)
    row=self.db.execute("SELECT * FROM questions WHERE id='q1'").fetchone()
    self.assertEqual(row['status'],'answered' if allowed else 'awaiting_answer')
    if allowed:
     self.assertEqual((row['answer_id'],row['answer_author'],row['answer_role'],row['answer_scope'],row['answer_text']),('400',author,role,scope,'Use option one'))
     self.assertEqual(row['answer_source'],'reply')
 def test_reconciliation_fails_closed_on_legacy_stale_or_unverifiable_records(self):
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",('q1','fp','lane-one','owner','99','Question?','awaiting_answer','200','300',int(self.now*1000)))
  self.db.commit()
  cases=[
   ('legacy',{'discord_origin':None},{}),
   ('incomplete',{'preparation_complete':False},{}),
   ('unknown version',{}, {'version':2}),
   ('missing bot proof',{}, {'bot':None}),
   ('malformed mentions',{}, {'mention_ids':'88'}),
   ('identity mismatch',{}, {'message_id':'401'}),
   ('author mismatch',{}, {'author_id':'77'}),
   ('reply mismatch',{}, {'reply_to':'301'}),
   ('unknown age',{'sent_at':None},{}),
   ('invalid date',{'sent_at':'2026-02-30T12:00:00Z'},{}),
   ('expired',{'sent_at':'2026-10-31T11:59:59Z'},{}),
   ('location changed',{}, {'guild_id':'900'}),
   ('malformed replay identity',{'channel_id':['200']},{}),
   ('missing webhook proof',{}, {'webhook_id':False}),
   ('invalid reply author',{}, {'reply_author_id':{}}),
  ]
  for name,changes,origin in cases:
   with self.subTest(name=name):
    self.db.execute("UPDATE questions SET status='awaiting_answer',answer_id=NULL,answer_text=NULL")
    self.db.commit()
    message=self.pending_answer(**changes)
    if origin:
     message['discord_origin'].update(origin)
    self.stage_answer(message)
    def request(method,path,body=None):
     if path=='/users/@me':
      return {'id':'88'}
     if path=='/channels/200':
      return {'id':'200','type':1}
     raise AssertionError(path)
    with patch.dict('os.environ',{},clear=True),patch.dict(self.g,{'request':request}):
     self.m['reconcile_pending'](self.db)
    self.assertEqual(self.db.execute("SELECT status FROM questions WHERE id='q1'").fetchone()['status'],'awaiting_answer')
 def test_reconciliation_rejects_answers_after_question_expiry_even_when_the_reply_is_fresh(self):
  for age,expected in ((71,'answered'),(72,'awaiting_answer'),(73,'awaiting_answer')):
   with self.subTest(age=age):
    self.db.execute('DELETE FROM questions')
    self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
     ('q1','fp','lane-one','owner','99','Question?','awaiting_answer','200','300',int((self.now-age*3600)*1000)))
    self.db.commit()
    self.stage_answer(self.pending_answer())
    def request(method,path,body=None):
     if path=='/users/@me':return {'id':'88'}
     if path=='/channels/200':return {'id':'200','type':1}
     raise AssertionError(path)
    with patch.dict('os.environ',{},clear=True),patch.dict(self.g,{'request':request}):
     self.m['reconcile_pending'](self.db)
    self.assertEqual(self.db.execute("SELECT status FROM questions WHERE id='q1'").fetchone()['status'],expected)
 def test_reconciliation_preserves_accepted_old_answers_and_exact_expiry_boundary(self):
  for sent_at,accepted in [('2026-10-31T12:00:00Z',False),('2026-10-01T12:00:00Z',True)]:
   with self.subTest(sent_at=sent_at,accepted=accepted):
    self.db.execute('DELETE FROM questions')
    self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",('q1','fp','lane-one','owner','99','Question?','awaiting_answer','200','300',int(self.now*1000)))
    self.db.commit()
    self.stage_answer(self.pending_answer(sent_at=sent_at),accepted)
    def request(method,path,body=None):
     if path=='/users/@me':
      return {'id':'88'}
     if path=='/channels/200':
      return {'id':'200','type':1}
     raise AssertionError(path)
    with patch.dict('os.environ',{},clear=True),patch.dict(self.g,{'request':request}):
     self.m['reconcile_pending'](self.db)
    self.assertEqual(self.db.execute("SELECT status FROM questions WHERE id='q1'").fetchone()['status'],'answered')
 def test_reconciliation_refuses_revoked_or_unavailable_current_channel_policy(self):
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",('q1','fp','lane-one','thread','77','Question?','awaiting_answer','200','300',int(self.now*1000)))
  self.db.commit()
  cases=[
   ('allowlist revoked',{'999'},{},None),
   ('ancestry unavailable',{'100'},{},'/channels/100'),
   ('identity unavailable',{'100'},{},'/users/@me'),
   ('channel unavailable',{'100'},{},'/channels/200'),
   ('overlapping policy',{'100'},{'DORI_DISCORD_TRUSTED_CHANNELS':'100','DORI_DISCORD_NORMAL_CHANNELS':'100'},None),
   ('invalid policy id',{'100'},{'DORI_DISCORD_TRUSTED_CHANNELS':'invalid'},None),
   ('normal child trusted parent',{'100'},{'DORI_DISCORD_TRUSTED_CHANNELS':'100','DORI_DISCORD_NORMAL_CHANNELS':'200'},None),
   ('category cannot confer trust',{'100'},{'DORI_DISCORD_TRUSTED_CHANNELS':'100'},None),
  ]
  for name,allowed,env,failure in cases:
   with self.subTest(name=name):
    message=self.pending_answer(author_id='77')
    message['discord_origin'].update(author_id='77',guild_id='900',mention_ids=['88'])
    self.stage_answer(message)
    def request(method,path,body=None):
     if path==failure:
      raise self.m['DiscordError'](403)
     if path=='/users/@me':
      return {'id':'88'}
     if path=='/channels/200':
      return {'id':'200','type':11,'guild_id':'900','parent_id':'100'}
     if path=='/channels/100':
      return {'id':'100','type':4 if name=='category cannot confer trust' else 0,'guild_id':'900','parent_id':None}
     raise AssertionError(path)
    with patch.dict('os.environ',env,clear=True),patch.dict(self.g,{'request':request,'ALLOWED':allowed}):
     self.m['reconcile_pending'](self.db)
    self.assertEqual(self.db.execute("SELECT status FROM questions WHERE id='q1'").fetchone()['status'],'awaiting_answer')
 def test_reconciliation_warns_safely_and_retains_pending_records_when_discord_is_unavailable(self):
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",('q1','fp','lane-one','thread','77','private question','awaiting_answer','200','300',int(self.now*1000)))
  self.db.commit()
  secret='private failure detail with credentials'
  cases=[
   ('/users/@me',self.m['DiscordError'](403)),
   ('/channels/200',urllib.error.URLError(secret)),
   ('/channels/100',TimeoutError(secret)),
   ('/channels/200',OSError(secret)),
  ]
  for failed_path,error in cases:
   with self.subTest(path=failed_path,error=type(error).__name__):
    message=self.pending_answer(author_id='77',content='private answer')
    message['discord_origin'].update(author_id='77',guild_id='900',mention_ids=['88'])
    self.stage_answer(message)
    before=tuple(self.db.execute("SELECT * FROM questions WHERE id='q1'").fetchone())
    def request(method,path,body=None):
     if path==failed_path:
      raise error
     if path=='/users/@me':
      return {'id':'88'}
     if path=='/channels/200':
      return {'id':'200','type':11,'guild_id':'900','parent_id':'100'}
     raise AssertionError(path)
    stderr=io.StringIO()
    stdout=io.StringIO()
    with patch.dict('os.environ',{},clear=True),patch.dict(self.g,{'request':request}),redirect_stderr(stderr),redirect_stdout(stdout):
     self.m['reconcile_pending'](self.db)
    self.assertEqual(tuple(self.db.execute("SELECT * FROM questions WHERE id='q1'").fetchone()),before)
    with closing(sqlite3.connect(self.state/'discord-delivery.sqlite')) as delivery:
     self.assertEqual(json.loads(delivery.execute("SELECT payload FROM delivery WHERE id='400'").fetchone()[0]),message)
    self.assertEqual(stdout.getvalue(),'')
    lines=stderr.getvalue().splitlines()
    self.assertEqual(len(lines),1)
    prefix,_,payload=lines[0].partition(' ')
    self.assertEqual(prefix,'QUESTION_WARN')
    self.assertEqual(json.loads(payload),{'message_id':'400','reason':'authorization-unavailable','retained_pending':True})
 def test_owner_question_is_sent_once_and_persisted(self):
  calls=[]
  def request(method,path,body=None):
   calls.append((method,path,body))
   if path=='/users/@me/channels':return {'id':'200'}
   if path=='/channels/200/messages':return {'id':'300'}
   raise AssertionError(path)
  with patch.dict(self.g,{'request':request}):
   first=self.m['create_question'](self.db,'lane-one','owner','','Which fixture?')
   second=self.m['create_question'](self.db,'lane-one','owner','','Which fixture?')
  self.assertEqual(first['status'],'awaiting_answer');self.assertEqual(first['message_id'],'300');self.assertEqual(first['recipient'],'99');self.assertEqual(first['id'],second['id'])
  self.assertEqual(len(calls),2);self.assertEqual(calls[1][2]['allowed_mentions'],{'parse':[]});self.assertEqual(calls[1][2]['nonce'],first['id']);self.assertTrue(calls[1][2]['enforce_nonce'])
  self.assertEqual((self.state/'discord-questions.sqlite').stat().st_mode & 0o777,0o600)
 def test_withdraw_retires_only_a_sent_unanswered_question(self):
  def request(method,path,body=None):
   return {'id':'200'} if path=='/users/@me/channels' else {'id':'300'}
  with patch.dict(self.g,{'request':request}):
   sent=self.m['create_question'](self.db,'lead','owner','','Use this record?')
  run=lambda *argv:patch('sys.argv',['helio-questions',*argv])
  out=io.StringIO()
  with run('withdraw',sent['id']),redirect_stdout(out):self.assertEqual(self.m['main'](),0)
  self.assertEqual(json.loads(out.getvalue())['status'],'cancelled')
  out=io.StringIO()
  with run('list'),redirect_stdout(out):self.m['main']()
  self.assertEqual(json.loads(out.getvalue()),{'items':[],'next':None})
  with run('withdraw',sent['id']),self.assertRaises(ValueError):self.m['main']()
 def test_staff_question_goes_to_the_staff_chat_and_pings_owner_and_trusted_users(self):
  calls=[]
  def request(method,path,body=None):
   calls.append((method,path,body));return {'id':'300'}
  with patch.dict(self.g,{'request':request,'STAFF':'100'}),patch.dict('os.environ',{'DORI_DISCORD_TRUSTED_IDS':'77,78'}):
   sent=self.m['create_question'](self.db,'lead','staff','','Push the merge to PR #1?')
   row=self.db.execute('SELECT * FROM questions WHERE id=?',(sent['id'],)).fetchone()
   self.assertEqual([self.m['may_answer'](row,x) for x in ('99','77','78','66')],[True,True,True,False])
  self.assertEqual((sent['status'],sent['channel_id']),('awaiting_answer','100'))
  body=calls[-1][2]
  self.assertEqual(calls[-1][1],'/channels/100/messages')
  self.assertTrue(body['content'].startswith('<@99> <@77> <@78>\nQuestion ['))
  self.assertEqual(body['allowed_mentions'],{'parse':[],'users':['99','77','78']})
 def test_owner_and_thread_questions_ping_nobody(self):
  calls=[]
  def request(method,path,body=None):
   calls.append((method,path,body));return {'id':'200'} if path=='/users/@me/channels' else {'id':'300'}
  with patch.dict(self.g,{'request':request}),patch.dict('os.environ',{'DORI_DISCORD_TRUSTED_IDS':'77'}):
   self.m['create_question'](self.db,'lead','owner','','Rotate the production token?')
  self.assertEqual(calls[-1][2]['allowed_mentions'],{'parse':[]})
  self.assertFalse(calls[-1][2]['content'].startswith('<@'))
 def test_expanding_question_links_fit_the_final_payload_without_changing_stored_source(self):
  text=('https://github.com/o/r/pull/1 '*60)[:1500].rstrip()
  for audience,options in [('owner',None),('staff',['Continue','Stop'])]:
   with self.subTest(audience=audience):
    posts=[]
    def request(method,path,body=None):
     if path=='/users/@me/channels':return {'id':'200'}
     posts.append(body)
     self.assertLessEqual(len(body['content']),2000)
     return {'id':'300'}
    with patch.dict(self.g,{'request':request,'STAFF':'100'}),patch.dict(os.environ,{'DORI_DISCORD_TRUSTED_IDS':'77,78'}):
     sent=self.m['create_question'](self.db,'lead',audience,'',text,options)
    self.assertEqual(sent['status'],'awaiting_answer')
    row=self.db.execute('SELECT * FROM questions WHERE id=?',(sent['id'],)).fetchone()
    self.assertEqual(row['question'],text)
    content=posts[0]['content']
    self.assertIn(f"Question [{sent['id']}]\n",content)
    self.assertIn('[PR #1](<https://github.com/o/r/pull/1>)',content)
    self.assertEqual(content.count('[PR #1]('),content.count('https://github.com/o/r/pull/1>)'))
    self.assertTrue(content.endswith('Choose below or reply to this message.' if options else 'Please reply directly to this message so I can route your answer to the right task.'))
    self.assertEqual(posts[0]['allowed_mentions'],{'parse':[],'users':['99','77','78']} if audience=='staff' else {'parse':[]})
 def test_thread_question_uses_registered_allowed_lane(self):
  (self.state/'lanes').mkdir();(self.state/'lanes/lane-one.json').write_text(json.dumps({'thread':'discord:101'}))
  calls=[]
  def request(method,path,body=None):
   calls.append(path)
   if path=='/channels/101':return {'parent_id':'100'}
   if path=='/channels/101/messages':return {'id':'301'}
   raise AssertionError(path)
  with patch.dict(self.g,{'request':request}):q=self.m['create_question'](self.db,'lane-one','thread','77','What happened?')
  self.assertEqual((q['status'],q['channel_id'],q['recipient']),('awaiting_answer','101','77'))
 def test_delivery_error_is_preserved_and_ambiguous_failure_is_not_retried(self):
  def request(method,path,body=None):
   if path=='/users/@me/channels':return {'id':'200'}
   raise TimeoutError('simulated uncertainty')
  with patch.dict(self.g,{'request':request}):
   q=self.m['create_question'](self.db,'lane-one','owner','','Need a decision')
   self.assertEqual(q['status'],'delivery_unknown')
   with self.assertRaises(ValueError):self.m['send_question'](self.db,q['id'])
 def test_recovery_finds_only_the_bots_marked_question_and_reconciles_pending_reply(self):
  def fail(method,path,body=None):
   if path=='/users/@me/channels':return {'id':'200'}
   raise TimeoutError()
  with patch.dict(self.g,{'request':fail}):q=self.m['create_question'](self.db,'lane-one','owner','','Need a decision')
  delivery=sqlite3.connect(self.state/'discord-delivery.sqlite');delivery.execute('CREATE TABLE delivery(stream TEXT,id TEXT,payload TEXT)')
  incoming=self.pending_answer()
  delivery.execute('INSERT INTO delivery VALUES (?,?,?)',('inbound','400',json.dumps(incoming)));delivery.commit();delivery.close()
  def request(method,path,body=None):
   if path=='/users/@me':return {'id':'88'}
   if path=='/channels/200':
    return {'id':'200','type':1}
   if path=='/channels/200/messages?limit=100':return [{'id':'300','author':{'id':'88'},'content':f"Question [{q['id']}] text"}]
   raise AssertionError(path)
  with patch.dict(self.g,{'request':request}):result=self.m['recover'](self.db,q['id'])
  self.assertEqual((result['status'],result['answer_id'],result['answer_author']),('answered','400','99'))
 def test_staff_question_with_pings_recovers_the_accepted_post_without_sending_again(self):
  posts=[]
  def lost(method,path,body=None):
   if method=='POST':
    posts.append(body);raise TimeoutError('accepted but reply lost')
   raise AssertionError(path)
  with patch.dict(self.g,{'STAFF':'100','request':lost}):
   q=self.m['create_question'](self.db,'lead','staff','','Which option?')
  self.assertTrue(posts[0]['content'].startswith('<@99>\nQuestion ['))
  def history(method,path,body=None):
   if path=='/users/@me':return {'id':'88'}
   if path=='/channels/100/messages?limit=100':
    return [{'id':'300','author':{'id':'88'},'content':posts[0]['content']},
            {'id':'301','author':{'id':'other-bot'},'content':posts[0]['content']}]
   raise AssertionError(path)
  with patch.dict(self.g,{'request':history}):recovered=self.m['recover'](self.db,q['id'])
  self.assertEqual((recovered['status'],recovered['message_id']),('awaiting_answer','300'))
  self.assertEqual(len(posts),1)
 def test_unavailable_owner_dm_leaves_question_pending(self):
  with patch.dict(self.g,{'request':lambda *a,**kw:(_ for _ in ()).throw(self.m['DiscordError'](403))}):
   q=self.m['create_question'](self.db,'lane-one','owner','','Decision needed')
  self.assertEqual(q['status'],'send_failed');self.assertEqual(q['error'],'Discord HTTP 403')
 def test_two_senders_claim_a_queued_question_only_once(self):
  import threading
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,updated) VALUES (?,?,?,?,?,?,?,?)",('abc','fp','lane-one','owner','99','Question?','queued',0));self.db.commit()
  barrier=threading.Barrier(2);posts=[];errors=[]
  def channel(row):barrier.wait(timeout=5);return '200'
  def request(method,path,body=None):posts.append(path);return {'id':'300'}
  def run():
   db=self.m['db_connect']()
   try:self.m['send_question'](db,'abc')
   except Exception as e:errors.append(str(e))
   finally:db.close()
  with patch.dict(self.g,{'channel_for':channel,'request':request}):
   threads=[threading.Thread(target=run) for _ in range(2)]
   for t in threads:t.start()
   for t in threads:t.join(10)
  self.assertEqual(errors,[]);self.assertEqual(posts,['/channels/200/messages'])
  self.assertEqual(self.db.execute('SELECT status FROM questions').fetchone()['status'],'awaiting_answer')
 def test_github_question_links_suppress_embeds(self):
  format_links=self.m['format_links']
  self.assertEqual(format_links('See https://github.com/jamestesting0/elo-bot/issues/12.'),'See [Issue #12](<https://github.com/jamestesting0/elo-bot/issues/12>).')
  self.assertEqual(format_links('See <https://github.com/jamestesting0/elo-bot/pull/4>'),'See [PR #4](<https://github.com/jamestesting0/elo-bot/pull/4>)')
  for text in ('`https://github.com/o/r/pull/4`','```\nhttps://github.com/o/r/pull/4\n```','> https://github.com/o/r/pull/4','https://github.com/o/r/pull/4extra',
               '[Review](<https://github.com/o/r/pull/4>)'):
   with self.subTest(text=text):self.assertEqual(format_links(text),text)
 def test_disallowed_thread_never_receives_a_question(self):
  (self.state/'lanes').mkdir();(self.state/'lanes/lane-one.json').write_text(json.dumps({'thread':'discord:101'}));calls=[]
  def request(method,path,body=None):
   calls.append((method,path))
   return {'parent_id':None}
  with patch.dict(self.g,{'request':request}):q=self.m['create_question'](self.db,'lane-one','thread','77','What happened?')
  self.assertEqual(q['status'],'send_failed');self.assertFalse(any(method=='POST' for method,path in calls))

class QuestionChoiceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.m=runpy.run_path(str(SCRIPT));self.g=self.m['create_question'].__globals__
  self.state=Path(self.temp.name);self.bodies=[]
  def request(method,path,body=None):
   if path=='/users/@me/channels':return {'id':'200'}
   self.bodies.append(body);return {'id':'500'}
  patcher=patch.dict(self.g,{'STATE':self.state,'OWNER':'99','TOKEN':'fake','ALLOWED':{'100'},'request':request});patcher.start();self.addCleanup(patcher.stop)
  self.db=self.m['db_connect']();self.addCleanup(self.db.close)
 def test_yes_no_options_render_exactly_two_buttons_from_cli(self):
  with patch('sys.argv',['helio-questions','ask','--lane','lead','--audience','owner','--text','How long?','--option','Yes','--option','No']),redirect_stdout(io.StringIO()):
   self.assertEqual(self.m['main'](),0)
  q=self.db.execute('SELECT * FROM questions').fetchone()
  body=self.bodies[0]
  self.assertIn('How long?', body['content'])
  self.assertEqual(body['components'],[{'type':1,'components':[
   {'type':2,'style':2,'label':'Yes','custom_id':f"h1:q:{q['id']}:o0"},
   {'type':2,'style':2,'label':'No','custom_id':f"h1:q:{q['id']}:o1"}]}])
  row=self.db.execute('SELECT options,components FROM questions WHERE id=?',(q['id'],)).fetchone()
  self.assertEqual(json.loads(row[0]),['Yes','No']);self.assertEqual(json.loads(row[1]),body['components'])
 def test_open_questions_have_no_components_and_request_a_reply(self):
  q=self.m['create_question'](self.db,'lead','owner','','Anything else?')
  body=self.bodies[0]
  self.assertIn('Anything else?', body['content'])
  self.assertRegex(body['content'], r'(?i)reply')
  self.assertEqual(body.get('components',[]),[])
  self.assertEqual(self.db.execute('SELECT options FROM questions WHERE id=?',(q['id'],)).fetchone()[0],'[]')
 def test_menu_only_questions_need_options(self):
  self.m['create_question'](self.db,'lead','owner','','Which?',['a','b'],False)
  self.assertEqual(len(self.bodies[0]['components']),1)
  with self.assertRaises(ValueError):self.m['create_question'](self.db,'lead','owner','','Anything?',None,False)
 def test_approval_asks_hand_off_to_helio_confirm_without_a_question_row(self):
  calls=[];sha='a'*40
  def execvp(file,argv):calls.append(argv);raise SystemExit(0)
  asks=(['--action','pr','--target','o/r#4','--revision',sha],
        ['--lane','lead','--action','merge','--target','o/r#6','--revision',sha,'--channel','300','--reply-to','42'],
        ['--action','restart','--target','elobot','--revision',sha,'--channel','300'])
  with patch.dict(self.g,{'STAFF':'100','trusted_now':lambda:{'77'}}),patch('os.execvp',execvp),patch.dict(os.environ,{'HELIO_GITHUB_REPO':'o/r'}):
   for argv in asks:
    with patch('sys.argv',['helio-questions','ask',*argv]),self.assertRaises(SystemExit):self.m['main']()
  base=['helio','confirm','ask','--action']
  self.assertEqual(calls,[
   base+['pr','--target','o/r#4','--revision',sha,'--channel','100','--note','<@99> <@77> <https://github.com/o/r/issues/4>'],
   base+['merge','--target','o/r#6','--revision',sha,'--channel','300','--reply-to','42','--note','<https://github.com/o/r/pull/6>'],
   base+['restart','--target','elobot','--revision',sha,'--channel','300']])
  self.assertEqual(self.db.execute('SELECT COUNT(*) FROM questions').fetchone()[0],0)
 def test_approval_asks_refuse_question_flags_and_other_lanes(self):
  ask=['helio-questions','ask','--action','pr','--target','o/r#4','--revision','a'*40]
  for extra in (['--text','x'],['--option','a'],['--audience','owner'],['--no-other'],['--lane','lane-one'],['--reply-to','42']):
   with self.subTest(extra=extra),patch.dict(self.g,{'STAFF':'100'}),patch('sys.argv',ask+extra),patch('os.execvp') as ex:
    with self.assertRaises(ValueError):self.m['main']()
    ex.assert_not_called()
  with patch('sys.argv',['helio-questions','ask','--lane','lead','--audience','owner','--text','x','--channel','5']),redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
   self.m['main']()
 def test_invalid_option_sets_are_refused_before_sending(self):
  for options in (['only'],['a']*2,[str(i) for i in range(6)],['x'*81],[' ','b']):
   with self.subTest(options=options),self.assertRaises(ValueError):
    self.m['create_question'](self.db,'lead','owner','','How long?',options,False)
  self.assertEqual(self.bodies,[])
 def test_an_older_database_gains_the_click_columns(self):
  old=self.state/'old';old.mkdir()
  with closing(sqlite3.connect(old/'discord-questions.sqlite')) as db:
   db.execute('CREATE TABLE questions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, lane TEXT NOT NULL, audience TEXT NOT NULL, recipient TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, channel_id TEXT, message_id TEXT, answer_id TEXT, answer_author TEXT, answer_role TEXT, answer_scope TEXT, answer_text TEXT, error TEXT, updated INTEGER NOT NULL)');db.commit()
  (old/'discord-questions.sqlite').chmod(0o600)
  with patch.dict(self.g,{'STATE':old}):
   with closing(self.m['db_connect']()) as db:
    columns={r[1] for r in db.execute('PRAGMA table_info(questions)')}
  self.assertTrue({'options','components','answer_source','announced_at','cleared_at','pending_by','pending_at'}<=columns)
 def test_withdraw_cannot_overwrite_a_question_claimed_by_a_click(self):
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,updated) VALUES ('q','f','lead','owner','99','Q','awaiting_answer',0)");self.db.commit()
  self.db.execute("UPDATE questions SET status='answering' WHERE id='q'");self.db.commit()
  with self.assertRaisesRegex(ValueError,'changed'):self.m['write'](self.db,'q','cancelled','awaiting_answer',question='')
  self.assertEqual(tuple(self.db.execute("SELECT status,question FROM questions WHERE id='q'").fetchone()),('answering','Q'))
 def test_ack_keeps_a_clicked_answer_until_it_is_posted(self):
  for qid,announced,kept in (('q1',None,'8 hours'),('q2',5,None)):
   self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,answer_text,answer_source,announced_at,updated) VALUES (?,?,'lead','owner','99','Q','answered','8 hours','component',?,0)",(qid,qid,announced));self.db.commit()
   with patch('sys.argv',['helio-questions','ack',qid]),redirect_stdout(io.StringIO()):self.assertEqual(self.m['main'](),0)
   row=self.db.execute('SELECT status,answer_text FROM questions WHERE id=?',(qid,)).fetchone()
   self.assertEqual((row[0],row[1]),('done',kept))
 def test_an_answer_being_submitted_is_not_reported_as_pending(self):
  self.db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,updated) VALUES ('q','f','lead','owner','99','Q','answering',0)");self.db.commit()
  out=io.StringIO()
  with redirect_stdout(out):self.m['poll'](self.db,None,{})
  self.assertEqual(out.getvalue(),'')
if __name__=='__main__':unittest.main()
