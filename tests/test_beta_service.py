import json
import multiprocessing
import os
import runpy
import socket
import struct
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

M=runpy.run_path(str(__import__('pathlib').Path(__file__).resolve().parent.parent/'scripts'/'helio_beta_service.py'))
CURRENT_CGROUP=Path('/proc/self/cgroup').read_text().strip().split(':',2)[2]


class Collection:
    def find_one(self,query):return {'_id':'demo','state':'old'}
    def update_one(self,query,changes):return SimpleNamespace(matched_count=1)


class Database:
    name='elo_beta'
    def command(self,_):return {'authInfo':{'authenticatedUsers':[{'user':'beta'}],'authenticatedUserPrivileges':[{'resource':{'db':'elo_beta','collection':''},'actions':['find','insert','update','remove']}]}}
    def __getitem__(self,name):return Collection()


def send(path,payload):
    raw=json.dumps(payload).encode()
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(3);client.connect(str(path));client.sendall(struct.pack('!I',len(raw))+raw)
        size=struct.unpack('!I',M['vault']['receive_exact'](client,4))[0]
        return json.loads(M['vault']['receive_exact'](client,size))


class ServiceTests(unittest.TestCase):
    def test_exclusions_file_must_be_explicitly_root_owned_and_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'deny.json'
            path.write_text(json.dumps({'database':'elo_beta','complete':False,'records':[]}))
            with self.assertRaises(M['ServiceError']):M['read_exclusions'](path)
            path.chmod(0o644)
            real=os.fstat
            as_root=lambda fd:SimpleNamespace(st_mode=real(fd).st_mode,st_uid=0,st_size=real(fd).st_size)
            with unittest.mock.patch.object(os,'fstat',as_root):
                with self.assertRaises(M['ServiceError']):M['read_exclusions'](path)
                path.write_text(json.dumps({'database':'elo_beta','complete':True,'records':[]}))
                self.assertEqual(M['read_exclusions'](path),set())

    def test_socket_accepts_one_scoped_request_and_preserves_preimage(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);sock=root/'socket';allowed=os.getuid();group=os.getgid()
            process=multiprocessing.get_context('fork').Process(target=M['serve'],args=(root,sock,allowed,group,Database(),{('other','string:protected')},CURRENT_CGROUP))
            process.start()
            try:
                for _ in range(100):
                    if sock.exists():break
                    time.sleep(.01)
                self.assertTrue(sock.exists())
                self.assertEqual(send(sock,{'action':'health'}),{'ok':True,'status':'ready','database':'elo_beta'})
                refused=send(sock,{'operation_id':'z'*32,'plan':{}})
                self.assertFalse(refused['ok'])
                plan={'database':'elo_beta','purpose':'test','operations':[{'collection':'test_records','id':'demo','action':'update','reason':'test','before':{'_id':'demo','state':'old'},'set':{'state':'new'}}]}
                result=send(sock,{'operation_id':'f'*32,'plan':plan})
                self.assertTrue(result['ok']);self.assertEqual(result['result']['status'],'applied')
                self.assertTrue((root/('f'*32)/'preimage.bson').is_file())
                repeat=send(sock,{'operation_id':'f'*32,'plan':plan})
                self.assertFalse(repeat['ok'])
            finally:
                process.terminate();process.join(3)

    def test_socket_rejects_wrong_peer_uid(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);sock=root/'socket'
            process=multiprocessing.get_context('fork').Process(target=M['serve'],args=(root,sock,os.getuid()+1,os.getgid(),Database(),{('other','string:protected')},CURRENT_CGROUP))
            process.start()
            try:
                for _ in range(100):
                    if sock.exists():break
                    time.sleep(.01)
                self.assertTrue(sock.exists())
                try:
                    response=send(sock,{'operation_id':'a'*32,'plan':{}})
                except (ConnectionResetError,BrokenPipeError):
                    response={'ok':False}
                self.assertFalse(response['ok'])
            finally:
                process.terminate();process.join(3)

    def test_scope_check_matches_only_exact_cgroup(self):
        self.assertTrue(M['peer_in_scope'](os.getpid(),CURRENT_CGROUP))
        self.assertFalse(M['peer_in_scope'](os.getpid(),CURRENT_CGROUP+'/other'))

    def test_changed_database_privileges_are_rechecked_before_write(self):
        class Broadened(Database):
            def command(self,_):
                result=super().command(_)
                result['authInfo']['authenticatedUserPrivileges'].append({'resource':{'db':'elo_bot','collection':''},'actions':['find']})
                return result
        with tempfile.TemporaryDirectory() as temp:
            plan={'database':'elo_beta','purpose':'test','operations':[{'collection':'test_records','id':'demo','action':'update','reason':'test','before':{'_id':'demo'},'set':{'state':'new'}}]}
            with self.assertRaises(M['ServiceError']):M['process_request'](Broadened(),Path(temp),{('other','string:protected')},{'operation_id':'f'*32,'plan':plan})


if __name__=='__main__':unittest.main()
