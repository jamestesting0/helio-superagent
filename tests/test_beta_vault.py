import base64,hashlib,json,os,runpy,socket,stat,struct,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from bson import BSON,ObjectId

SCRIPT=Path(__file__).resolve().parent.parent/'scripts/helio_beta_vault.py'
M=runpy.run_path(str(SCRIPT))
class VaultTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)/'vault';self.root.mkdir(mode=0o700)
  self.raw=BSON.encode({'_id':ObjectId('a'*24),'state':'waiting','value':7})
  self.req={'database':'elo_beta','collection':'matches','operation_id':'a'*32,'reason':'beta test blocker','document_bson':base64.b64encode(self.raw).decode()}
 def test_stores_exact_bson_durably_and_is_idempotent(self):
  result=M['store_preimage'](self.root,self.req);self.assertEqual(result['status'],'stored')
  path=self.root/('a'*32);self.assertEqual((path/'preimage.bson').read_bytes(),self.raw)
  manifest=json.loads((path/'manifest.json').read_text());self.assertEqual(manifest['bson_sha256'],hashlib.sha256(self.raw).hexdigest());self.assertTrue(manifest['stored_at'])
  self.assertEqual(stat.S_IMODE((path/'preimage.bson').stat().st_mode),0o600)
  self.assertEqual(M['store_preimage'](self.root,self.req)['status'],'already_stored')
  changed={**self.req,'reason':'different'}
  with self.assertRaises(M['VaultError']):M['store_preimage'](self.root,changed)
 def test_rejects_wrong_database_invalid_path_and_invalid_bson(self):
  for update in ({'database':'elo_bot'},{'collection':'../secret'},{'operation_id':'../escape'},{'document_bson':base64.b64encode(b'not bson').decode()},{'document_bson':base64.b64encode(BSON.encode({'x':1})).decode()}):
   with self.subTest(update=update),self.assertRaises(M['VaultError']):M['store_preimage'](self.root,{**self.req,**update})
  self.assertEqual(list(self.root.iterdir()),[])
 def test_refuses_insecure_root_or_existing_incomplete_archive(self):
  self.root.chmod(0o755)
  with self.assertRaises(M['VaultError']):M['store_preimage'](self.root,self.req)
  self.root.chmod(0o700);(self.root/('a'*32)).mkdir(mode=0o700)
  with self.assertRaises(M['VaultError']):M['store_preimage'](self.root,self.req)
 def test_socket_returns_ack_only_after_archive_and_rejects_bad_request(self):
  sock=Path(self.tmp.name)/'vault.sock'
  proc=subprocess.Popen([sys.executable,str(SCRIPT),'--directory',str(self.root),'--socket',str(sock),'--allowed-uid',str(os.getuid())],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  try:
   for _ in range(100):
    if sock.exists():break
    if proc.poll() is not None:self.fail('vault exited before readiness')
    time.sleep(.02)
   def call(obj):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as c:
     c.settimeout(3);c.connect(str(sock));raw=json.dumps(obj).encode();c.sendall(struct.pack('!I',len(raw))+raw)
     def receive(n):
      out=b''
      while len(out)<n:
       chunk=c.recv(n-len(out))
       if not chunk:raise RuntimeError('short response')
       out+=chunk
      return out
     size=struct.unpack('!I',receive(4))[0];return json.loads(receive(size))
   self.assertFalse(call({'database':'elo_bot'})['ok'])
   result=call(self.req);self.assertTrue(result['ok']);self.assertEqual(result['result']['status'],'stored')
   self.assertEqual((self.root/('a'*32)/'preimage.bson').read_bytes(),self.raw)
  finally:
   proc.terminate();proc.wait(timeout=5)
   if proc.stdout:proc.stdout.close()
   if proc.stderr:proc.stderr.close()
 def test_socket_rejects_unapproved_peer_uid(self):
  sock=Path(self.tmp.name)/'deny.sock'
  proc=subprocess.Popen([sys.executable,str(SCRIPT),'--directory',str(self.root),'--socket',str(sock),'--allowed-uid',str(os.getuid()+1),'--socket-gid',str(os.getgid())],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  try:
   for _ in range(100):
    if sock.exists():break
    if proc.poll() is not None:self.fail('vault exited before readiness')
    time.sleep(.02)
   with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as c:
    c.settimeout(3);c.connect(str(sock));raw=json.dumps(self.req).encode();c.sendall(struct.pack('!I',len(raw))+raw)
    header=c.recv(4);self.assertEqual(len(header),4);length=struct.unpack('!I',header)[0]
    data=b''
    while len(data)<length:data+=c.recv(length-len(data))
    self.assertFalse(json.loads(data)['ok'])
   self.assertEqual(list(self.root.iterdir()),[])
  finally:
   proc.terminate();proc.wait(timeout=5)
   if proc.stdout:proc.stdout.close()
   if proc.stderr:proc.stderr.close()
if __name__=='__main__':unittest.main()
