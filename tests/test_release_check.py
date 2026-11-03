import runpy,unittest,os,json,sqlite3,tempfile,sys
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
m=runpy.run_path(str(Path(__file__).resolve().parent.parent/'scripts/release-check.py'))
class ReleaseCheckTests(unittest.TestCase):
 def setUp(self):
  self.sha='a'*40; self.target='jamestesting0/elo-bot#42'; self.text=f'approve merge {self.target} {self.sha}'
  self.payload={'author_id':'42','channel_id':'50','message_id':'60','content':self.text}
  self.live={'id':'60','channel_id':'50','author':{'id':'42','bot':False},'content':self.text}
 def check(self,**kw):
  args=dict(payload=self.payload,live=self.live,action='merge',target=self.target,revision=self.sha,owner='1',trusted={'42'},channel_ok=True,is_dm=False); args.update(kw); return m['verify'](**args)
 def test_current_approver_specific_head(self): self.assertEqual(self.check(),'42')
 def test_revoked_and_wrong_target_refused(self):
  with self.assertRaises(m['Refused']): self.check(trusted=set())
  with self.assertRaises(m['Refused']): self.check(revision='b'*40)
 def test_changed_message_and_bot_refused(self):
  self.live['content']='approve anything'
  with self.assertRaises(m['Refused']): self.check()
  self.live['content']=self.text; self.live['author']['bot']=True
  with self.assertRaises(m['Refused']): self.check()
 def test_owner_requires_permitted_location(self):
  with self.assertRaises(m['Refused']): self.check(owner='42',channel_ok=False)
  self.assertEqual(self.check(owner='42',channel_ok=True),'42')
class ReleaseCliTests(unittest.TestCase):
 def test_pending_approval_must_match_live_message_and_checks(self):
  with tempfile.TemporaryDirectory() as tmp:
   base=Path(tmp); state=base/'state'; state.mkdir(); (base/'trusted-users').write_text('42'); (base/'release-approvers').write_text('42')
   sha='a'*40; target='jamestesting0/elo-bot#42'; text=f'approve merge {target} {sha}'
   payload={'author_id':'42','channel_id':'50','message_id':'60','content':text}
   db=sqlite3.connect(state/'discord-delivery.sqlite'); db.execute('CREATE TABLE delivery(stream TEXT,id TEXT,payload TEXT)'); db.execute('INSERT INTO delivery VALUES(?,?,?)',('inbound','60',json.dumps(payload))); db.commit(); db.close()
   live={'id':'60','channel_id':'50','author':{'id':'42','bot':False},'content':text}
   def api(path,token): return live if '/messages/' in path else {'id':'50','type':0}
   def run(argv,**kw):
    class R: returncode=0; stdout=json.dumps({'state':'OPEN','headRefOid':sha}) if 'view' in argv else json.dumps([{'state':'SUCCESS'}])
    return R()
   g=m['main'].__globals__; env={'DORI_DISCORD_TOKEN':'fake','DORI_DISCORD_OWNER_ID':'1','DORI_DISCORD_ALLOWED':'50'}
   argv=['release-check','--message','60','--action','merge','--target',target,'--revision',sha]
   with patch.dict(os.environ,env),patch.dict(g,{'BASE':base,'STATE':state,'api':api}),patch.object(sys,'argv',argv),patch.object(g['subprocess'],'run',run),redirect_stdout(StringIO()):
    self.assertEqual(m['main'](),0)
    live['content']='changed';
    with redirect_stderr(StringIO()): self.assertEqual(m['main'](),2)
if __name__=='__main__': unittest.main()
