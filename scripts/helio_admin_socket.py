"""Owner-UID Unix framing for the administration broker."""
from __future__ import annotations

from collections.abc import Callable, Mapping
import json
import os
from pathlib import Path
import socket
import socketserver
import stat
import struct

type Json = str | int | float | bool | None | list[Json] | dict[str, Json]


class TransportError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def receive(connection: socket.socket, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        part = connection.recv(size - len(result))
        if not part:
            raise TransportError("invalid", "Incomplete administration request")
        result.extend(part)
    return bytes(result)


def serve(path: Path, owner_uid: int, dispatch: Callable[[Mapping[str, Json]], Json]) -> None:
    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            connection = self.request
            connection.settimeout(90)
            try:
                _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != owner_uid:
                    raise TransportError("denied", "Unapproved administration peer")
                size = struct.unpack("!I", receive(connection, 4))[0]
                if not 0 < size <= 32_768:
                    raise TransportError("invalid", "Invalid administration request size")
                request = json.loads(receive(connection, size))
                if not isinstance(request, dict):
                    raise TransportError("invalid", "Invalid administration request")
                response = dispatch(request)
            except TransportError as error:
                response = {"ok": False, "code": error.code, "error": str(error)}
            except (OSError, ValueError):
                response = {"ok": False, "code": "invalid", "error": "Invalid or incomplete administration request"}
            payload = json.dumps(response, separators=(",", ":")).encode()
            connection.sendall(struct.pack("!I", len(payload)) + payload)

    if path.exists() or path.is_symlink():
        raise TransportError("invalid", "Administration socket already exists")
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise TransportError("invalid", "Unsafe administration socket directory")
    with socketserver.ThreadingUnixStreamServer(str(path), Handler) as server:
        os.chown(path, owner_uid, -1)
        os.chmod(path, 0o600)
        print("ADMIN_READY", flush=True)
        try:
            server.serve_forever()
        finally:
            path.unlink(missing_ok=True)
