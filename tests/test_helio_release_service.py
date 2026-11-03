import datetime,runpy,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace

M=runpy.run_path(str(__import__('pathlib').Path(__file__).resolve().parent.parent/'scripts'/'helio_release_service.py'))
OWNER='123456789012345678';TRUSTED='234567890123456789';CHANNEL='345678901234567890';MESSAGE='456789012345678901';REV='a'*40;OLD='b'*40

class ReleaseTests(unittest.TestCase):
 def setUp(self):
  self.config={'token':'dummy','owner':OWNER,'trusted':[TRUSTED],'allowed':[CHANNEL]}
  self.message={'id':MESSAGE,'channel_id':CHANNEL,'author':{'id':TRUSTED},'content':'approve restart elobot '+REV,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  self.state={'ok':True,'clean':True,'head':OLD,'tip':REV,'branch':'main','update_on_start':True,'start_file':'main.py','expected_service':True,'active':True,'restart_permission':True}
  self.request={'action':'restart','channel_id':CHANNEL,'message_id':MESSAGE,'revision':REV}
 def fetch(self,path,token):
  return dict(self.message) if '/messages/' in path else {'id':CHANNEL,'type':0}
 def test_trusted_confirmation_and_owner_confirmation(self):
  self.assertEqual(M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch),TRUSTED)
  self.message['author']={'id':OWNER}
  self.assertEqual(M['verify_confirmation'](CHANNEL,MESSAGE,REV,self.config,self.fetch),OWNER)
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

if __name__=='__main__':unittest.main()
