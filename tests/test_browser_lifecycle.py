import json,runpy,unittest
import subprocess,tempfile
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock,patch
from contextlib import redirect_stdout,redirect_stderr
from io import StringIO
m=runpy.run_path(str(Path(__file__).resolve().parent.parent/'scripts/helio-browser.py'))
class BrowserLifecycleTests(unittest.TestCase):
 def test_commands_default_to_qa_a_and_select_multiple_accounts_explicitly(self):
  g=m['main'].__globals__
  cases=[([],['qa-a']),(['open'],['qa-a']),(['ready'],['qa-a']),(['close'],['qa-a']),(['status'],['qa-a']),
         (['ready','--accounts','3'],['qa-a','qa-b','qa-c']),(['open','--profile','qa-b'],['qa-b'])]
  for arguments,expected in cases:
   with self.subTest(arguments=arguments):
    selected=[]
    def browser(name):
     selected.append(name); return 0
    with patch.dict(g,{'open_browser':browser,'ready_browser':browser,'close_browser':browser,'browser_pids':browser}),patch.object(g['sys'],'argv',['helio-browser',*arguments]),redirect_stdout(StringIO()):
     self.assertEqual(m['main'](),0)
     self.assertEqual(selected,expected)
 def test_open_uses_the_exported_wayland_display_for_every_profile(self):
  g=m['open_browser'].__globals__
  for name in ('helio','qa-a','qa-b','qa-c'):
   with self.subTest(profile=name),tempfile.TemporaryDirectory() as directory:
    root=Path(directory); launcher=root/'helio-chrome'; launcher.touch()
    calls=iter([[],[123]])
    process=SimpleNamespace(wait=Mock(side_effect=subprocess.TimeoutExpired('chrome',1)),poll=lambda:None)
    with patch.dict(g,{'ROOT':root,'PROFILE':root/'profile','LAUNCHER':launcher,'browser_pids':lambda name='helio':next(calls)}),patch.dict(g['os'].environ,{'WAYLAND_DISPLAY':'wayland-0'},clear=True),patch.object(g['subprocess'],'Popen',return_value=process) as launch,redirect_stdout(StringIO()):
     self.assertEqual(m['open_browser'](name),0)
     self.assertIn('--ozone-platform=wayland',launch.call_args.args[0])
 def test_open_refuses_a_browser_that_exits_after_its_process_appears(self):
  g=m['open_browser'].__globals__
  with tempfile.TemporaryDirectory() as directory:
   calls=iter([[],[123]])
   process=SimpleNamespace(wait=lambda timeout:1,poll=lambda:1)
   with patch.dict(g,{'ROOT':Path(directory),'browser_pids':lambda name='helio':next(calls)}),patch.object(g['subprocess'],'Popen',return_value=process),redirect_stdout(StringIO()) as output,redirect_stderr(StringIO()):
    self.assertEqual(m['open_browser']('qa-a'),1)
    self.assertNotIn('opened.',output.getvalue())
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
  results=iter([SimpleNamespace(returncode=0,stdout=json.dumps([{'name':x,'status':'ok'} for x in names])),SimpleNamespace(returncode=0,stdout=json.dumps([{'id':'qa-a-instance','browser_name':'chrome','version_skew':False,'unresponsive':False}]))])
  with patch.dict(g,{'accounts':lambda:{'qa-a':{'browser':'qa-a-instance','account':'Dominik'}},'browser_pids':lambda name='qa-a':[123], 'open_browser':lambda name='qa-a':0}),patch.object(g['subprocess'],'run',side_effect=lambda *a,**k:next(results)),redirect_stdout(StringIO()):
   self.assertEqual(m['ready_browser'](),0)
 def test_ready_does_not_accept_another_profile(self):
  g=m['ready_browser'].__globals__
  names=['daemon running','daemon local process identity','protocol compatible','extension connected','browser protocol compatible']
  results=iter([SimpleNamespace(returncode=0,stdout=json.dumps([{'name':x,'status':'ok'} for x in names])),SimpleNamespace(returncode=0,stdout=json.dumps([{'id':'other-instance','label':'Helio','browser_name':'chrome'}]))])
  ticks=iter([0,1,2,3,31])
  with patch.dict(g,{'accounts':lambda:{'qa-a':{'browser':'qa-a-instance','account':'Dominik'}},'browser_pids':lambda name='qa-a':[123], 'open_browser':lambda name='qa-a':0}),patch.object(g['subprocess'],'run',side_effect=lambda *a,**k:next(results)),patch.object(g['time'],'monotonic',side_effect=lambda:next(ticks)),patch.object(g['time'],'sleep'),redirect_stderr(StringIO()):
   self.assertEqual(m['ready_browser'](),1)
if __name__=='__main__': unittest.main()
