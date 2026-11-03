import json,runpy,subprocess,sys,tempfile,unittest
from copy import deepcopy
from pathlib import Path

SCRIPT=Path(__file__).resolve().parent.parent/'scripts/helio-beta.py'
M=runpy.run_path(str(SCRIPT))
class BetaPreparationTests(unittest.TestCase):
 def setUp(self):
  self.plan={'database':'elo_beta','purpose':'prepare a beta match','operations':[{'collection':'matches','id':{'$oid':'a'*24},'action':'update','reason':'clear stale test state','before':{'_id':{'$oid':'a'*24},'state':'waiting'},'set':{'state':'ready'},'unset':[]}]}
 def test_valid_plan_only_summarizes_and_hashes_preimage(self):
  result=M['validate_plan'](self.plan);self.assertEqual(result[0]['collection'],'matches');self.assertEqual(result[0]['paths'],['state']);self.assertEqual(len(result[0]['before_sha256']),64)
 def test_rejects_other_databases_system_collections_and_bulk_filters(self):
  for change in ('db','system','filter'):
   p=deepcopy(self.plan)
   if change=='db':p['database']='elo_bot'
   elif change=='system':p['operations'][0]['collection']='system.users'
   else:p['operations'][0]['filter']={'$ne':None}
   with self.subTest(change=change),self.assertRaises(ValueError):M['validate_plan'](p)
 def test_rejects_bad_ids_preimages_and_unsafe_fields(self):
  variants=[]
  p=deepcopy(self.plan);p['operations'][0]['id']={'$ne':None};variants.append(p)
  p=deepcopy(self.plan);p['operations'][0]['before']['_id']='different';variants.append(p)
  p=deepcopy(self.plan);p['operations'][0]['set']={'_id':'new'};variants.append(p)
  p=deepcopy(self.plan);p['operations'][0]['set']={'$where':'x'};variants.append(p)
  p=deepcopy(self.plan);p['operations'][0]['set']={'match':1,'match.status':2};variants.append(p)
  for plan in variants:
   with self.subTest(plan=plan),self.assertRaises(ValueError):M['validate_plan'](plan)
 def test_numeric_ids_accept_canonical_extended_json_and_deduplicate_across_bson_numeric_types(self):
  p=deepcopy(self.plan);op=p['operations'][0];op['id']={'$numberInt':'7'};op['before']['_id']={'$numberLong':'7'}
  self.assertEqual(len(M['validate_plan'](p)),1)
  second=deepcopy(op);second['id']=7;second['before']['_id']=7;p['operations'].append(second)
  with self.assertRaises(ValueError):M['validate_plan'](p)
 def test_rejects_duplicate_document_and_unbounded_actions(self):
  p=deepcopy(self.plan);p['operations'].append(deepcopy(p['operations'][0]))
  with self.assertRaises(ValueError):M['validate_plan'](p)
  p=deepcopy(self.plan);second=deepcopy(p['operations'][0]);second['id']['$oid']='A'*24;second['before']['_id']['$oid']='A'*24;p['operations'].append(second)
  with self.assertRaises(ValueError):M['validate_plan'](p)
  p=deepcopy(self.plan);p['operations'][0]['action']='drop_database'
  with self.assertRaises(ValueError):M['validate_plan'](p)
 def test_scope_checker_rejects_atlas_admin_and_missing_privileges(self):
  auth={'authenticatedUsers':[{'user':'beta'}],'authenticatedUserPrivileges':[{'resource':{'db':'','collection':''},'actions':['find','insert','update','remove','dropDatabase']}]}
  self.assertFalse(M['evaluate_privileges'](auth)[0]);self.assertFalse(M['evaluate_privileges']({})[0])
  auth['authenticatedUserPrivileges']=[{'resource':{'db':'elo_beta','collection':''},'actions':['find','insert','update','remove']}]
  self.assertTrue(M['evaluate_privileges'](auth)[0])
  auth['authenticatedUserPrivileges'][0]['actions'].extend(['createSearchIndexes','listSearchIndexes','updateSearchIndex','dropSearchIndex','bypassDocumentValidation','validate'])
  self.assertTrue(M['evaluate_privileges'](auth)[0])
  auth['authenticatedUserPrivileges'][0]['actions'].append('dropCollection')
  self.assertFalse(M['evaluate_privileges'](auth)[0])
  auth['authenticatedUserPrivileges'][0]['actions'].remove('dropCollection')
  auth['authenticatedUserPrivileges'].append({'resource':{'db':'elo_bot','collection':''},'actions':['find']})
  self.assertFalse(M['evaluate_privileges'](auth)[0])
  auth['authenticatedUserPrivileges']=[{'resource':{'db':'elo_beta','collection':''},'actions':['find','insert','update','remove','unknownPriv']}]
  self.assertFalse(M['evaluate_privileges'](auth)[0])
  auth['authenticatedUserPrivileges']=[{'resource':{'cluster':True},'actions':['find']}]
  self.assertFalse(M['evaluate_privileges'](auth)[0])
 def test_process_probe_reports_exposed_files_but_never_attests_isolation(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);home=root/'home';project=root/'project';home.mkdir();project.mkdir();(project/'.env').write_text('dummy')
   result=M['process_exposure'](home,project,root/'absent-wsl')
   self.assertTrue(result['project_env_readable']);self.assertFalse(result['windows_wsl_executable_accessible'])
 def test_status_reports_not_ready_with_nonzero_exit(self):
  result=subprocess.run([sys.executable,str(SCRIPT),'status'],capture_output=True,text=True)
  self.assertNotEqual(result.returncode,0);self.assertFalse(json.loads(result.stdout)['writes_enabled'])
 def test_apply_is_unconditionally_disabled(self):
  result=subprocess.run([sys.executable,str(SCRIPT),'apply'],capture_output=True,text=True)
  self.assertNotEqual(result.returncode,0);self.assertIn('disabled',result.stderr)
 def test_offline_plan_does_not_claim_to_have_backed_up_or_written(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'plan.json';p.write_text(json.dumps(self.plan))
   result=subprocess.run([sys.executable,str(SCRIPT),'plan',str(p)],capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr);output=json.loads(result.stdout)
   self.assertEqual(output['status'],'validated_offline_only');self.assertFalse(output['writes_enabled']);self.assertFalse(output['backup_created'])
 def test_inspect_pins_database_and_refuses_admin_before_reading(self):
  from unittest.mock import patch
  from bson import ObjectId
  g=M['inspect_document'].__globals__; calls=[]
  auth={'authenticatedUsers':[{'user':'beta'}],'authenticatedUserPrivileges':[{'resource':{'db':'elo_beta','collection':''},'actions':['find','insert','update','remove']}]}
  class Collection:
   def find_one(self,query):calls.append(query);return {'_id':query['_id'],'state':'waiting'}
  class DB:
   def command(self,cmd):return {'authInfo':auth}
   def __getitem__(self,name):
    self.assert_collection=name
    return Collection()
  class Client:
   def __getitem__(self,name):
    if name!='elo_beta':raise AssertionError('other database accessed')
    return DB()
   def close(self):pass
  with patch.dict(g,{'connect_beta':lambda path:Client()}):
   result=M['inspect_document']('unused','matches','{"$oid":"aaaaaaaaaaaaaaaaaaaaaaaa"}')
   self.assertEqual(calls,[{'_id':ObjectId('a'*24)}]);self.assertEqual(result['state'],'waiting')
   calls.clear();auth['authenticatedUserPrivileges'].append({'resource':{'db':'','collection':''},'actions':['find']})
   with self.assertRaises(M['Blocked']):M['inspect_document']('unused','matches','"123"')
   self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
