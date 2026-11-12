import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import json, runpy, socket, struct, tempfile, threading, unittest
from pathlib import Path

M=runpy.run_path(str(__import__('pathlib').Path(__file__).resolve().parent.parent/'scripts'/'helio_beta_client.py'))

class ClientTests(unittest.TestCase):
 def serve_once(self,path,response):
  server=socket.socket(socket.AF_UNIX);server.bind(str(path));server.listen(1)
  def worker():
   try:
    client,_=server.accept()
    with client:
     size=struct.unpack('!I',M['receive_exact'](client,4))[0]
     request=json.loads(M['receive_exact'](client,size))
     reply=response(request);payload=json.dumps(reply).encode()
     client.sendall(struct.pack('!I',len(payload))+payload)
   finally:server.close()
  thread=threading.Thread(target=worker,daemon=True);thread.start()
  return thread
 def test_accepts_matching_receipt(self):
  with tempfile.TemporaryDirectory() as temp:
   path=Path(temp)/'socket';thread=self.serve_once(path,lambda request:{'ok':True,'result':{'operation_id':request['operation_id'],'status':'applied'}})
   self.assertEqual(M['submit']({'database':'elo_beta'},'a'*32,str(path))['status'],'applied');thread.join(2)
 def test_rejects_wrong_receipt_and_service_refusal(self):
  for response in ({'ok':True,'result':{'operation_id':'wrong','status':'applied'}},{'ok':False}):
   with self.subTest(response=response),tempfile.TemporaryDirectory() as temp:
    path=Path(temp)/'socket';thread=self.serve_once(path,lambda request:response)
    with self.assertRaises(M['ClientError']):M['submit']({},'a'*32,str(path))
    thread.join(2)
 def test_nonisolated_account_cannot_apply(self):
  with self.assertRaises(M['ClientError']):M['apply']('/does/not/exist',lambda _:None)

if __name__=='__main__':unittest.main()
