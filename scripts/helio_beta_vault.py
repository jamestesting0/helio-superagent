#!/usr/bin/env python3
"""Append-only BSON preimage vault for a future isolated beta broker.

This service is not installed or trusted until its service account, socket,
and Helio runtime boundary have been independently provisioned and verified.
"""
from __future__ import annotations
import argparse, base64, binascii, hashlib, json, os, re, socket, stat, struct, sys
from pathlib import Path
from bson import BSON
from bson.errors import BSONError
from datetime import datetime, timezone

MAX_DOCUMENT = 16 * 1024 * 1024
MAX_REQUEST = 24 * 1024 * 1024
OP_ID = re.compile(r"^[0-9a-f]{32}$")
COLLECTION = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$")

class VaultError(Exception): pass

def require_private_directory(root: Path) -> None:
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise VaultError("vault directory must be private and owned by the service user")

def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def write_exclusive(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())

def store_preimage(root: Path, request: dict) -> dict:
    require_private_directory(root)
    if not isinstance(request, dict) or set(request) != {"database", "collection", "operation_id", "reason", "document_bson"}:
        raise VaultError("invalid request fields")
    database, collection, operation, reason = (request.get(k) for k in ("database", "collection", "operation_id", "reason"))
    if database != "elo_beta": raise VaultError("only elo_beta can be archived")
    if not isinstance(collection, str) or not COLLECTION.fullmatch(collection) or collection.startswith("system."):
        raise VaultError("invalid collection")
    if not isinstance(operation, str) or not OP_ID.fullmatch(operation): raise VaultError("invalid operation id")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 500: raise VaultError("invalid reason")
    encoded=request.get("document_bson")
    if not isinstance(encoded, str) or len(encoded) > (MAX_DOCUMENT * 4 // 3 + 8): raise VaultError("invalid document size")
    try:
        raw=base64.b64decode(encoded, validate=True)
        if not raw or len(raw)>MAX_DOCUMENT: raise VaultError("invalid document size")
        document=BSON(raw).decode()
    except (ValueError, binascii.Error, TypeError, BSONError) as error: raise VaultError("invalid BSON preimage") from error
    if "_id" not in document: raise VaultError("preimage must contain _id")
    digest=hashlib.sha256(raw).hexdigest()
    meta={"database":database,"collection":collection,"operation_id":operation,"reason":reason,"bson_sha256":digest,"size":len(raw)}
    target=root/operation
    try: target.mkdir(mode=0o700)
    except FileExistsError:
        if target.is_symlink() or not target.is_dir(): raise VaultError("unsafe existing archive")
        try:
            old=json.loads((target/"manifest.json").read_text())
            old_data=(target/"preimage.bson").read_bytes()
        except (OSError, ValueError): raise VaultError("existing archive incomplete; do not overwrite") from None
        existing={k:v for k,v in old.items() if k != "stored_at"}
        if existing!=meta or not old.get("stored_at") or hashlib.sha256(old_data).hexdigest()!=digest: raise VaultError("operation ID already belongs to a different preimage")
        return {"operation_id":operation,"bson_sha256":digest,"status":"already_stored"}
    # An incomplete directory is intentionally preserved for owner inspection.
    write_exclusive(target/"preimage.bson", raw)
    meta["stored_at"]=datetime.now(timezone.utc).isoformat()
    write_exclusive(target/"manifest.json", (json.dumps(meta,sort_keys=True)+"\n").encode())
    sync_dir(target); sync_dir(root)
    return {"operation_id":operation,"bson_sha256":digest,"status":"stored"}

def receive_exact(conn, length):
    parts=[]
    while length:
        chunk=conn.recv(min(length,65536))
        if not chunk: raise VaultError("incomplete request")
        parts.append(chunk);length-=len(chunk)
    return b"".join(parts)

def serve(root: Path, socket_path: Path, allowed_uid: int, socket_gid: int | None = None) -> None:
    require_private_directory(root)
    if socket_path.exists() or socket_path.is_symlink(): raise VaultError("socket path already exists")
    parent=socket_path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
        raise VaultError("socket parent is not service-owned and protected")
    if allowed_uid != os.geteuid() and socket_gid is None: raise VaultError("a socket group is required for a different agent UID")
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    bound_identity=None
    try:
        server.bind(str(socket_path))
        info=socket_path.lstat();bound_identity=(info.st_dev,info.st_ino)
        if socket_gid is not None: os.chown(socket_path,-1,socket_gid)
        os.chmod(socket_path,0o660 if socket_gid is not None else 0o600);server.listen(8)
        while True:
            conn,_=server.accept()
            with conn:
                conn.settimeout(10)
                try:
                    _,uid,_=struct.unpack("3i",conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize("3i")))
                    if uid != allowed_uid: raise VaultError("peer is not authorized")
                    size=struct.unpack("!I",receive_exact(conn,4))[0]
                    if not 0<size<=MAX_REQUEST: raise VaultError("invalid request size")
                    request=json.loads(receive_exact(conn,size))
                    result={"ok":True,"result":store_preimage(root,request)}
                except (VaultError, OSError, ValueError, TypeError): result={"ok":False,"error":"backup refused or failed"}
                response=json.dumps(result).encode()
                try: conn.sendall(struct.pack("!I",len(response))+response)
                except OSError: pass
    finally:
        server.close()
        if bound_identity is not None:
            try:
                info=socket_path.lstat()
                if stat.S_ISSOCK(info.st_mode) and (info.st_dev,info.st_ino)==bound_identity: socket_path.unlink()
            except FileNotFoundError: pass

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',type=Path,required=True);p.add_argument('--socket',type=Path,required=True);p.add_argument('--allowed-uid',type=int,required=True);p.add_argument('--socket-gid',type=int)
    a=p.parse_args();serve(a.directory,a.socket,a.allowed_uid,a.socket_gid)

if __name__ == "__main__":
    try:main()
    except (OSError,VaultError) as error:print(f"BETA_VAULT_ERROR {error}",file=sys.stderr);sys.exit(1)
