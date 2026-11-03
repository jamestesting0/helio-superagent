import os,runpy,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

M=runpy.run_path(str(__import__('pathlib').Path(__file__).resolve().parent.parent/'scripts'/'helio_beta_run.py'))

class BetaRunTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.home=Path(self.tmp.name)
  self.project=self.home/'PythonProjects/elo-bot';self.project.mkdir(parents=True)
  (self.project/'beta.py').write_text('BETA_SYNC_FROM_MAIN = False\n')
  python=self.project/'.venv/bin/python';python.parent.mkdir(parents=True);python.write_text('#!/bin/sh\n');python.chmod(0o700)
  config=self.home/'.dori/elobot';config.mkdir(parents=True)
  (config/'beta.env').write_text('BOT_BETA_TOKEN=test\nMONGO_DB_URL=mongodb://beta\n')
  (config/'beta-mongo.env').write_text('MONGO_DB_URL=mongodb://beta\n')
  for name in ('beta.env','beta-mongo.env'):(config/name).chmod(0o600)
 def tearDown(self):self.tmp.cleanup()
 def prepare(self,**kwargs):
  g=M['prepare'].__globals__
  with patch.dict(g,{'pwd':SimpleNamespace(getpwnam=lambda _:SimpleNamespace(pw_uid=os.getuid()))}):
   return M['prepare'](self.home,kwargs.get('cwd',self.project),kwargs.get('broker',True),kwargs.get('uid',os.getuid()))
 def test_scoped_environment_removes_unrelated_tokens(self):
  with patch.dict(os.environ,{'BOT_MAIN_TOKEN':'main-secret','DORI_DISCORD_TOKEN':'discord-secret','MONGO_DB_URL':'mongodb://main'}):
   python,script,env=self.prepare()
  self.assertTrue(python.endswith('/.venv/bin/python'));self.assertTrue(script.endswith('/beta.py'))
  self.assertNotIn('BOT_MAIN_TOKEN',env);self.assertNotIn('DORI_DISCORD_TOKEN',env);self.assertEqual(env['MONGO_DB_URL'],'mongodb://beta')
 def test_refuses_wrong_scope_or_disabled_broker(self):
  for kwargs in ({'broker':False},{'uid':os.getuid()+1},{'cwd':self.home}):
   with self.subTest(kwargs=kwargs),self.assertRaises(M['RunError']):self.prepare(**kwargs)
 def test_refuses_main_sync_or_broader_env(self):
  script=self.project/'beta.py';script.write_text('BETA_SYNC_FROM_MAIN = True\n')
  with self.assertRaises(M['RunError']):self.prepare()
  script.write_text('BETA_SYNC_FROM_MAIN = False\n')
  env=self.home/'.dori/elobot/beta.env';env.write_text('BOT_BETA_TOKEN=test\nBOT_MAIN_TOKEN=secret\nMONGO_DB_URL=mongodb://beta\n')
  with self.assertRaises(M['RunError']):self.prepare()
  env.write_text('BOT_BETA_TOKEN=test\nMONGO_DB_URL=mongodb://other\n')
  with self.assertRaises(M['RunError']):self.prepare()

if __name__=='__main__':unittest.main()
