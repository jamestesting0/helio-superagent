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
    class R: returncode=0; stdout=json.dumps({'state':'OPEN','headRefOid':sha,'headRefName':'fix'}) if 'view' in argv else json.dumps([{'state':'SUCCESS'}])
    return R()
   g=m['main'].__globals__; env={'DORI_DISCORD_TOKEN':'fake','DORI_DISCORD_OWNER_ID':'1','DORI_DISCORD_ALLOWED':'50'}
   argv=['release-check','--message','60','--action','merge','--target',target,'--revision',sha]
   with patch.dict(os.environ,env),patch.dict(g,{'BASE':base,'STATE':state,'api':api}),patch.object(sys,'argv',argv),patch.object(g['subprocess'],'run',run),redirect_stdout(StringIO()):
    self.assertEqual(m['main'](),0)
    live['content']='changed'
    with redirect_stderr(StringIO()): self.assertEqual(m['main'](),2)
if __name__=='__main__': unittest.main()
