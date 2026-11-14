import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
from pathlib import Path
import json,os,runpy,subprocess,sys,tempfile,unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
ROOT=Path(__file__).resolve().parent.parent
SYNC=runpy.run_path(str(ROOT/'scripts/sync-install.py'))
INSTALL=runpy.run_path(str(ROOT/'scripts/install.py'))
PAYLOAD=SYNC['PAYLOAD']
def quiet(fn,*args):
 with redirect_stdout(StringIO()) as out: fn(*args)
 return out.getvalue()
class SyncTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.home=Path(self.tmp.name); self.dst=self.home/'.dori/elobot'
  (self.home/'project').mkdir()
  with redirect_stdout(StringIO()): self.assertEqual(INSTALL['install'](self.home,True,self.home/'project'),0)
  (self.dst/'.sync-manifest.json').unlink()
  p=self.dst/'config.json'; c=json.loads(p.read_text()); c['leadPane']='test-pane'; p.write_text(json.dumps(c,indent=2)+'\n')
  launcher=self.home/'.local/bin/helio'; launcher.parent.mkdir(parents=True); launcher.write_bytes((ROOT/'scripts/helio-wsl').read_bytes())
  (self.dst/'env').write_text('private'); (self.dst/'trusted-users').write_text('123'); (self.dst/'report-channels').write_text('456')
 def snapshot(self): return {p.relative_to(self.home):p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
 def test_apply_installs_locked_dependencies_offline_and_propagates_failure(self):
  quiet(SYNC['run'],self.home,'adopt')
  inbound=self.home/'.dori/discord-inbound'; (inbound/'node_modules').mkdir()
  tools=self.home/'tools'; tools.mkdir(); log=self.home/'dependencies.jsonl'
  bun=tools/'bun'
  bun.write_text(f'#!{sys.executable}\n'
                 'import json,os,sys\n'
                 'with open(os.environ["DEPENDENCY_LOG"],"a") as f: f.write(json.dumps({"argv":sys.argv[1:],"cwd":os.getcwd(),"home":os.environ["HOME"]})+"\\n")\n'
                 'sys.exit(int(os.environ.get("DEPENDENCY_FAIL","0")))\n')
  bun.chmod(0o700)
  state=self.dst/'state/accepted'; state.parent.mkdir(exist_ok=True); state.write_text('keep accepted work')
  with patch.dict(os.environ,{'PATH':str(tools)+os.pathsep+os.environ['PATH'],'DEPENDENCY_LOG':str(log)}):
   quiet(SYNC['run'],self.home,'preview')
   self.assertFalse(log.exists())
   quiet(SYNC['run'],self.home,'apply')
   row=json.loads(log.read_text().splitlines()[-1])
   self.assertEqual(row,{'argv':['install','--offline','--frozen-lockfile','--ignore-scripts'],
                         'cwd':str(inbound),'home':str(self.home)})
   with patch.dict(os.environ,{'DEPENDENCY_FAIL':'17'}), redirect_stdout(StringIO()), self.assertRaisesRegex(SystemExit,'dependency'):
    SYNC['run'](self.home,'apply')
   self.assertEqual(state.read_text(),'keep accepted work')
 def test_update_applies_worker_cap_and_hibernation_from_helio_env(self):
  settings=self.home/'.config/helio/helio.env'; settings.parent.mkdir(parents=True,exist_ok=True)
  settings.write_text('HELIO_MAX_WORKERS=2\nHELIO_HIBERNATE_AFTER_MIN=45\n'); settings.chmod(0o600)
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  config=json.loads((self.dst/'config.json').read_text())
  self.assertEqual((config['maxWorkers'],config['hibernateAfterMin'],config['leadPane']),(2,45,'test-pane'))
 def test_update_adds_source_inspector_to_legacy_config_and_preserves_other_hooks(self):
  path=self.dst/'config.json'; config=json.loads(path.read_text())
  config['hooks'].pop('inspectJobSource',None); previous=dict(config['hooks'])
  path.write_text(json.dumps(config,indent=2)+'\n')
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  hooks=json.loads(path.read_text())['hooks']
  self.assertEqual(hooks.get('inspectJobSource'),['helio','recovery','source','{source}','--job','{job}'])
  self.assertEqual({k:v for k,v in hooks.items() if k!='inspectJobSource'},previous)
 def test_update_adds_phase_effect_hooks_to_legacy_installation(self):
  path=self.dst/'config.json'; config=json.loads(path.read_text())
  config['hooks'].pop('beforeWake',None); config['hooks'].pop('beforeComplete',None)
  path.write_text(json.dumps(config,indent=2)+'\n')
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  hooks=json.loads(path.read_text())['hooks']
  for name,effect in [('beforeWake','wake'),('beforeComplete','complete')]:
   self.assertEqual(hooks[name],['helio','pr','phase','authorize','--lane','{key}','--effect',effect,
                                 '--lane-revision','{revision}'])
 def test_install_writes_a_baseline_that_updates_cleanly(self):
  home=self.home/'fresh'; (home/'project').mkdir(parents=True)
  quiet(INSTALL['install'],home,True,home/'project')
  (home/'.dori/elobot/report-channels').write_text('456')
  out=quiet(SYNC['run'],home,'preview')
  self.assertIn('Managed updates: none',out)
 def test_update_repairs_owner_execute_bit_on_unchanged_entrypoints(self):
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  path=self.dst/'start'; content=path.read_bytes(); path.chmod(0o600)
  quiet(SYNC['run'],self.home,'apply')
  self.assertTrue(path.stat().st_mode & 0o100)
  self.assertEqual(path.read_bytes(),content)
 def test_update_repairs_its_own_linked_dori_entrypoint_but_preserves_other_installations(self):
  quiet(SYNC['run'],self.home,'adopt')
  kit=self.home/'kit'; src=kit/'vendor/dori-mode/scripts/src'; src.mkdir(parents=True)
  (kit/'discord-inbound').symlink_to(ROOT/'discord-inbound',target_is_directory=True)
  (src/'messenger').symlink_to(ROOT/'vendor/dori-mode/scripts/src/messenger',target_is_directory=True)
  (src/'session-state.ts').symlink_to(ROOT/'vendor/dori-mode/scripts/src/session-state.ts')
  launcher=src/'cli.ts'; launcher.write_text('#!/bin/sh\nprintf DORI_READY\n'); launcher.chmod(0o600)
  binary=self.home/'.bun/bin/dori'; binary.parent.mkdir(parents=True); binary.symlink_to(launcher)
  with patch.dict(SYNC['run'].__globals__,{'ROOT':kit}):
   quiet(SYNC['run'],self.home,'preview')
   self.assertFalse(os.access(launcher,os.X_OK))
   quiet(SYNC['run'],self.home,'apply')
   self.assertEqual(subprocess.run([str(binary)],capture_output=True,text=True,check=True).stdout,'DORI_READY')
   other=self.home/'other-dori'; other.write_text('keep other installation'); other.chmod(0o600)
   binary.unlink(); binary.symlink_to(other)
   quiet(SYNC['run'],self.home,'apply')
   self.assertFalse(os.access(other,os.X_OK))
   self.assertEqual(other.read_text(),'keep other installation')
 def test_preserves_private_files_and_detects_changed_managed_files(self):
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  self.assertEqual((self.dst/'env').read_text(),'private'); self.assertEqual((self.dst/'trusted-users').read_text(),'123')
  self.assertEqual(json.loads((self.dst/'config.json').read_text())['leadPane'],'test-pane')
  p=self.dst/'config.json'; config=json.loads(p.read_text()); config['leadPane']='new-pane'; p.write_text(json.dumps(config,indent=2)+'\n')
  quiet(SYNC['run'],self.home,'apply')
  self.assertEqual(json.loads(p.read_text())['leadPane'],'new-pane')
  (self.dst/'start').write_text('local edit')
  with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertEqual((self.dst/'start').read_text(),'local edit')
 def test_rendered_prompts_follow_profile_and_fill_placeholders(self):
  quiet(SYNC['run'],self.home,'adopt')
  for name in ('setup-prompt.md','work-policy.md'):
   data=(self.dst/name).read_bytes()
   self.assertNotIn(b'{{',data)
   self.assertIn(b'Runtime profile: isolated',data)
   self.assertNotIn(b'Runtime profile: owner',data)
  self.assertIn(str(self.home/'project').encode(),(self.dst/'docs/discord-qa-workflow.md').read_bytes()+(self.dst/'work-policy.md').read_bytes()+(self.dst/'setup-prompt.md').read_bytes())
 def test_installed_env_values_reach_templates(self):
  quiet(SYNC['run'],self.home,'adopt')
  (self.dst/'env').write_text("export HELIO_TEST_CHANNEL='99999999999'\n")
  quiet(SYNC['run'],self.home,'apply')
  self.assertIn(b'99999999999',(self.dst/'work-policy.md').read_bytes()+(self.dst/'setup-prompt.md').read_bytes()+(self.dst/'docs/discord-qa-workflow.md').read_bytes())
 def test_keeps_runbook_aliases_idempotent(self):
  name='oracle-restart-workflow.md'
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply'); quiet(SYNC['run'],self.home,'apply')
  self.assertTrue((self.dst/name).is_symlink())
  self.assertEqual((self.dst/name).read_bytes(),(self.dst/'docs'/name).read_bytes())
 def test_preserves_locally_modified_launcher_even_with_old_baseline(self):
  launcher=self.home/'.local/bin/helio'
  quiet(SYNC['run'],self.home,'adopt')
  manifest=self.dst/'.sync-manifest.json'
  baseline=json.loads(manifest.read_text()); baseline['@launcher']='old baseline'; manifest.write_text(json.dumps(baseline))
  launcher.write_text('isolated host wrapper')
  quiet(SYNC['run'],self.home,'apply')
  self.assertEqual(launcher.read_text(),'isolated host wrapper')
  self.assertEqual(json.loads(manifest.read_text())['@launcher'],'old baseline')
 def test_moved_inbound_files_are_retired_only_when_unchanged(self):
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  manifest=self.dst/'.sync-manifest.json'; old=self.home/'.dori/discord-inbound/filter.ts'; shipped=b'old flat module'
  old.write_bytes(shipped)
  baseline=json.loads(manifest.read_text()); baseline['@inbound/filter.ts']=SYNC['digest'](shipped); baseline['@inbound/gone.ts']='x'; manifest.write_text(json.dumps(baseline))
  out=quiet(SYNC['run'],self.home,'apply')
  self.assertIn('@inbound/filter.ts',out); self.assertFalse(old.exists())
  self.assertTrue((self.home/'.dori/discord-inbound/intake/filter.ts').is_file())
  self.assertFalse({'@inbound/filter.ts','@inbound/gone.ts'}&set(json.loads(manifest.read_text())))
  old.write_bytes(b'local edit')
  baseline=json.loads(manifest.read_text()); baseline['@inbound/filter.ts']=SYNC['digest'](shipped); manifest.write_text(json.dumps(baseline))
  with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertEqual(old.read_bytes(),b'local edit')
 def test_installs_new_inbound_payload_but_refuses_unadopted_local_changes(self):
  quiet(SYNC['run'],self.home,'adopt')
  name='@inbound/ack.ts'; manifest=self.dst/'.sync-manifest.json'
  baseline=json.loads(manifest.read_text()); del baseline[name]; manifest.write_text(json.dumps(baseline))
  target=self.home/'.dori/discord-inbound/ack.ts'; target.unlink()
  quiet(SYNC['run'],self.home,'apply')
  self.assertEqual(target.read_bytes(),(ROOT/'discord-inbound/ack.ts').read_bytes())
  baseline=json.loads(manifest.read_text()); del baseline[name]; manifest.write_text(json.dumps(baseline))
  target.write_text('local change')
  with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertEqual(target.read_text(),'local change')
 def test_update_ships_the_skill_to_homes_installed_before_it(self):
  quiet(SYNC['run'],self.home,'adopt')
  name='skills/karpathy-guidelines/SKILL.md'; manifest=self.dst/'.sync-manifest.json'
  baseline=json.loads(manifest.read_text()); del baseline[name]; manifest.write_text(json.dumps(baseline))
  (self.dst/name).unlink(); (self.dst/name).parent.rmdir()
  quiet(SYNC['run'],self.home,'apply')
  self.assertEqual((self.dst/name).read_bytes(),(ROOT/'agent'/name).read_bytes())
  self.assertIn('Managed updates: none',quiet(SYNC['run'],self.home,'preview'))
 def test_new_helper_payload_is_checked_before_any_writes(self):
  quiet(SYNC['run'],self.home,'adopt')
  manifest=self.dst/'.sync-manifest.json'; payload='helio-sessions.py'; target=self.dst/payload
  source=(ROOT/'agent/helpers'/payload).read_bytes()
  for state in ('missing','identical','different','symlink'):
   with self.subTest(state=state):
    baseline=json.loads(manifest.read_text()); baseline.pop(payload,None); manifest.write_text(json.dumps(baseline))
    if target.exists() or target.is_symlink(): target.unlink()
    if state=='identical': target.write_bytes(source)
    elif state=='different': target.write_text('owner payload')
    elif state=='symlink': target.symlink_to(ROOT/'agent/helpers'/payload)
    before=self.snapshot()
    if state in ('different','symlink'):
     with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
     self.assertEqual(self.snapshot(),before)
    else:
     quiet(SYNC['run'],self.home,'preview'); self.assertEqual(self.snapshot(),before)
     quiet(SYNC['run'],self.home,'apply'); quiet(SYNC['run'],self.home,'apply')
     self.assertEqual(target.read_bytes(),source)
     self.assertEqual(json.loads(manifest.read_text())[payload],SYNC['digest'](source))
     self.assertEqual((self.dst/'env').read_text(),'private')
    if target.is_symlink(): target.unlink()
    target.write_bytes(source)
 def test_missing_tracked_payload_is_not_silently_recreated(self):
  quiet(SYNC['run'],self.home,'adopt')
  target=self.dst/'helio-sessions.py'; target.unlink()
  with redirect_stdout(StringIO()), self.assertRaisesRegex(SystemExit,'helio-sessions.py'): SYNC['run'](self.home,'apply')
  self.assertFalse(target.exists())
 def test_retired_files_are_removed_only_when_unmodified(self):
  quiet(SYNC['run'],self.home,'adopt')
  retired=self.dst/'channel-policy.env'
  retired.write_text('export DORI_DISCORD_ALLOWED=local\n')
  before=self.snapshot()
  out=StringIO()
  with redirect_stdout(out), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertIn('channel-policy.env',out.getvalue()); self.assertEqual(self.snapshot(),before)
  manifest=self.dst/'.sync-manifest.json'; baseline=json.loads(manifest.read_text())
  baseline['channel-policy.env']=SYNC['digest'](retired.read_bytes()); manifest.write_text(json.dumps(baseline))
  quiet(SYNC['run'],self.home,'apply')
  self.assertFalse(retired.exists()); self.assertNotIn('channel-policy.env',json.loads(manifest.read_text()))
 def test_previously_shipped_files_count_only_for_their_profile(self):
  quiet(SYNC['run'],self.home,'adopt')
  target=self.dst/'setup-prompt.md'; legacy=b'reviewed owner prompt from the old kit\n'
  target.write_bytes(legacy)
  shipped=SYNC['SHIPPED']['owner'].setdefault('setup-prompt.md',set()); shipped.add(SYNC['digest'](legacy))
  self.addCleanup(shipped.discard,SYNC['digest'](legacy))
  before=self.snapshot()
  with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertEqual(self.snapshot(),before)
  manifest=self.dst/'.sync-manifest.json'; baseline=json.loads(manifest.read_text()); baseline.pop('_profile'); manifest.write_text(json.dumps(baseline))
  quiet(lambda: SYNC['run'](self.home,'apply',False,'owner'))
  self.assertIn(b'Runtime profile: owner',target.read_bytes())
  self.assertEqual(json.loads(manifest.read_text())['_profile'],'owner')
 def test_converged_files_advance_stale_or_missing_baselines_without_rewrites(self):
  quiet(lambda: SYNC['run'](self.home,'adopt',True)); quiet(lambda: SYNC['run'](self.home,'apply',True))
  manifest=self.dst/'.sync-manifest.json'
  targets={name:self.dst/name for name in ('inbound','context','ack','browser-env','setup-prompt.md')}
  targets['@inbound/inbound.ts']=self.home/'.dori/discord-inbound/inbound.ts'
  targets['@messenger/http.ts']=self.dst/'vendor/dori-mode/scripts/src/messenger/http.ts'
  targets['@launcher']=self.home/'.local/bin/helio'
  originals={name:(path.read_bytes(),path.stat().st_ino) for name,path in targets.items()}
  for state in ('stale','missing'):
   with self.subTest(state=state):
    baseline=json.loads(manifest.read_text())
    for name in targets:
     if state=='stale': baseline[name]=SYNC['digest'](b'previous version')
     else: del baseline[name]
    manifest.write_text(json.dumps(baseline)); before=manifest.read_bytes()
    quiet(lambda: SYNC['run'](self.home,'preview',True)); self.assertEqual(manifest.read_bytes(),before)
    quiet(lambda: SYNC['run'](self.home,'apply',True))
    updated=json.loads(manifest.read_text())
    for name,path in targets.items():
     self.assertEqual((path.read_bytes(),path.stat().st_ino),originals[name])
     self.assertEqual(updated[name],SYNC['digest'](originals[name][0]))
 def test_converged_file_does_not_hide_genuine_local_conflict(self):
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  manifest=self.dst/'.sync-manifest.json'; baseline=json.loads(manifest.read_text())
  baseline['inbound']=SYNC['digest'](b'previous version'); manifest.write_text(json.dumps(baseline))
  (self.dst/'work-policy.md').write_text('intentional owner protections')
  before=self.snapshot()
  for action in ('preview','apply'):
   with self.subTest(action=action):
    out=StringIO()
    with redirect_stdout(out), self.assertRaises(SystemExit): SYNC['run'](self.home,action)
    self.assertIn('work-policy.md',out.getvalue()); self.assertNotIn('inbound',out.getvalue())
    self.assertEqual(self.snapshot(),before)
 def test_raw_source_is_not_convergence_when_install_transforms_it(self):
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  manifest=self.dst/'.sync-manifest.json'; target=self.dst/'setup-prompt.md'
  target.write_bytes((ROOT/'agent/prompts/lead.md').read_bytes())
  baseline=json.loads(manifest.read_text()); baseline['setup-prompt.md']=SYNC['digest'](b'previous version'); manifest.write_text(json.dumps(baseline))
  before=manifest.read_bytes()
  with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertEqual(target.read_bytes(),(ROOT/'agent/prompts/lead.md').read_bytes()); self.assertEqual(manifest.read_bytes(),before)
 def test_preserved_config_fields_cannot_be_adopted_through_desired_equality(self):
  quiet(SYNC['run'],self.home,'adopt'); quiet(SYNC['run'],self.home,'apply')
  target=self.dst/'config.json'; config=json.loads(target.read_text()); config['guard']['loadAlert']+=1
  target.write_text(json.dumps(config,indent=2)+'\n')
  before=target.read_bytes(); manifest=self.dst/'.sync-manifest.json'; baseline=manifest.read_bytes()
  with redirect_stdout(StringIO()), self.assertRaises(SystemExit): SYNC['run'](self.home,'apply')
  self.assertEqual(target.read_bytes(),before); self.assertEqual(manifest.read_bytes(),baseline)
if __name__=='__main__': unittest.main()
