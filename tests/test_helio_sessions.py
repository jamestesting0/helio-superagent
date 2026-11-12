import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json,os,subprocess,sys,tempfile,unittest,uuid
from pathlib import Path

SCRIPT=Path(__file__).resolve().parent.parent/'agent/helpers/helio-sessions.py'
class HelioSessionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
  self.home=Path(self.tmp.name);self.project=self.home/'project';self.project.mkdir();self.state=self.home/'state'
  self.env={**os.environ,'HOME':str(self.home),'HELIO_PROJECT':str(self.project),'DORI_STATE_DIR':str(self.state)}
 def run_helper(self,mode):
  return subprocess.run([sys.executable,str(SCRIPT),mode],env=self.env,capture_output=True,text=True)
 def make_session(self,sid):
  root=self.home/'.omo/agent/sessions/project';root.mkdir(parents=True,exist_ok=True)
  p=root/f'2026-01-01_{sid}.jsonl';p.write_text(json.dumps({'type':'session','id':sid,'cwd':str(self.project)})+'\n');return p
 def test_new_and_resume_ignore_unregistered_workers_and_uncreated_leads(self):
  first=self.run_helper('new');self.assertEqual(first.returncode,0);sid=first.stdout.strip();uuid.UUID(sid)
  lead=self.make_session(sid);self.make_session(str(uuid.uuid4()))
  missing=self.run_helper('new');self.assertEqual(missing.returncode,0)
  selected=self.run_helper('latest');self.assertEqual(selected.returncode,0);self.assertEqual(selected.stdout.strip(),str(lead))
  latest=self.make_session(missing.stdout.strip());selected=self.run_helper('latest');self.assertEqual(selected.stdout.strip(),str(latest))
  self.assertEqual(self.state.joinpath('helio-lead-sessions.json').stat().st_mode & 0o777,0o600)
 def test_missing_and_running_lead_are_reported(self):
  missing=self.run_helper('latest');self.assertNotEqual(missing.returncode,0);self.assertIn('helio start',missing.stderr)
  sid=self.run_helper('new').stdout.strip();lead=self.make_session(sid)
  holders=lead.parent/'session-holders'/sid;holders.mkdir(parents=True);(holders/f'{os.getpid()}.json').write_text('{}')
  running=self.run_helper('latest');self.assertNotEqual(running.returncode,0);self.assertIn('already running',running.stderr)
 def test_refuses_other_project_and_bad_header(self):
  sid=self.run_helper('new').stdout.strip();p=self.make_session(sid)
  p.write_text(json.dumps({'type':'session','id':sid,'cwd':'/another/project'})+'\n')
  self.assertNotEqual(self.run_helper('latest').returncode,0)
if __name__=='__main__':unittest.main()
