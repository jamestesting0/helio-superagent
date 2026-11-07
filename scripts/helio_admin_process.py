"""Bound output from an isolated worker without limiting its database file sizes."""
from __future__ import annotations

import os
import selectors
import signal
import subprocess
import time


class RuntimeFailure(Exception):
    """An isolated operation has no bounded, known response."""


def run_bounded(command: list[str]) -> bytes:
    output = bytearray()
    total = 0
    deadline = time.monotonic() + 80
    with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as child, selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ, True)
        selector.register(child.stderr, selectors.EVENT_READ, False)
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeFailure("Runtime operation timed out")
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > 2_000_000:
                        raise RuntimeFailure("Runtime output exceeded its limit")
                    if key.data:
                        output.extend(chunk)
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
        except (RuntimeFailure, subprocess.TimeoutExpired):
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise RuntimeFailure("Runtime did not return a bounded result; inspect its saved receipt") from None
        if child.returncode:
            raise RuntimeFailure("The administration worker stopped; inspect its saved receipt")
    return bytes(output)
