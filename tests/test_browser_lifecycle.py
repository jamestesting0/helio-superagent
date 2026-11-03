import json,runpy,unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout,redirect_stderr
from io import StringIO
m=runpy.run_path(str(Path(__file__).resolve().parent.parent/'scripts/helio-browser.py'))
class BrowserLifecycleTests(unittest.TestCase):
 def test_close_refuses_active_session_without_signalling_browser(self):
  g=m['close_browser'].__globals__
  with patch.dict(g,{'browser_pids':lambda name='helio':[123], 'active_sessions':lambda:[{'session_id':'active'}]}),patch.object(g['os'],'kill') as kill,redirect_stderr(StringIO()):
   self.assertEqual(m['close_browser'](),2); kill.assert_not_called()
 def test_close_signals_only_matched_browser_when_idle(self):
  g=m['close_browser'].__globals__; calls=iter([[123],[]])
  with patch.dict(g,{'browser_pids':lambda name='helio':next(calls), 'active_sessions':lambda:[]}),patch.object(g['os'],'kill') as kill,redirect_stdout(StringIO()):
   self.assertEqual(m['close_browser'](),0); kill.assert_called_once_with(123,g['signal'].SIGTERM)
 def test_no_browser_is_a_noop(self):
  g=m['close_browser'].__globals__
  with patch.dict(g,{'browser_pids':lambda name='helio':[]}),patch.object(g['os'],'kill') as kill,redirect_stdout(StringIO()):
   self.assertEqual(m['close_browser'](),0); kill.assert_not_called()
 def test_ready_opens_and_verifies_the_dedicated_browser(self):
  g=m['ready_browser'].__globals__
  names=['daemon running','daemon local process identity','protocol compatible','extension connected','browser protocol compatible']
  results=iter([SimpleNamespace(returncode=0,stdout=json.dumps([{'name':x,'status':'ok'} for x in names])),SimpleNamespace(returncode=0,stdout=json.dumps([{'label':'Helio','browser_name':'chrome','version_skew':False,'unresponsive':False}]))])
  with patch.dict(g,{'browser_pids':lambda name='helio':[123], 'open_browser':lambda name='helio':0}),patch.object(g['subprocess'],'run',side_effect=lambda *a,**k:next(results)),redirect_stdout(StringIO()):
   self.assertEqual(m['ready_browser'](),0)
 def test_ready_does_not_accept_another_profile(self):
  g=m['ready_browser'].__globals__
  names=['daemon running','daemon local process identity','protocol compatible','extension connected','browser protocol compatible']
  results=iter([SimpleNamespace(returncode=0,stdout=json.dumps([{'name':x,'status':'ok'} for x in names])),SimpleNamespace(returncode=0,stdout=json.dumps([{'label':'Personal','browser_name':'chrome'}]))])
  ticks=iter([0,1,2,3,31])
  with patch.dict(g,{'browser_pids':lambda name='helio':[123], 'open_browser':lambda name='helio':0}),patch.object(g['subprocess'],'run',side_effect=lambda *a,**k:next(results)),patch.object(g['time'],'monotonic',side_effect=lambda:next(ticks)),patch.object(g['time'],'sleep'),redirect_stderr(StringIO()):
   self.assertEqual(m['ready_browser'](),1)
if __name__=='__main__': unittest.main()
