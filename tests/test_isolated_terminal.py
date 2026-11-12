"""Terminal state must return to shell defaults after an interrupted relay."""
import hermetic  # noqa: F401  # must precede anything that reads HOME or PATH
import ast
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import termios
from types import SimpleNamespace
import tty
import unittest

ROOT = Path(__file__).resolve().parent.parent


class IsolatedTerminalTests(unittest.TestCase):
    def test_interrupt_disables_child_mouse_reporting_and_leaves_alternate_screen(self):
        source = ast.parse((ROOT / "scripts/helio_isolated_launcher.py").read_text())
        definitions = ast.Module(body=[node for node in source.body
                                      if isinstance(node, ast.FunctionDef) and node.name in ("dimensions", "relay")],
                                 type_ignores=[])
        outer, terminal = pty.openpty()
        master, child = pty.openpty()
        try:
            saved = termios.tcgetattr(terminal)
            environment = dict(fcntl=fcntl, os=os, select=select, signal=signal, termios=termios, tty=tty,
                               sys=SimpleNamespace(stdin=SimpleNamespace(fileno=lambda: terminal),
                                                   stdout=SimpleNamespace(fileno=lambda: terminal)))
            exec(compile(definitions, str(ROOT / "scripts/helio_isolated_launcher.py"), "exec"), environment)
            os.write(child, b"\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?25l")
            polls = 0
            def poll():
                nonlocal polls
                polls += 1
                if polls == 1:
                    return None
                os.write(outer, b"\x1b[<35;17;18M\n")
                self.assertTrue(select.select([terminal], [], [], 1)[0])
                raise KeyboardInterrupt
            with self.assertRaises(KeyboardInterrupt):
                environment["relay"](master, SimpleNamespace(poll=poll))
            self.assertEqual(termios.tcgetattr(terminal), saved)
            self.assertEqual(select.select([terminal], [], [], 0)[0], [])
            output = b""
            while not output.endswith(b"\x1b[0m"):
                self.assertTrue(select.select([outer], [], [], 2)[0], f"terminal reset never arrived: {output!r}")
                output += os.read(outer, 65536)
            modes = {int(number): enabled == b"h"
                     for number, enabled in re.findall(rb"\x1b\[\?(\d+)([hl])", output)}
            self.assertEqual({mode: modes.get(mode) for mode in (1003, 1006, 1049, 25)},
                             {1003: False, 1006: False, 1049: False, 25: True})
        finally:
            for fd in (child, master, terminal, outer):
                os.close(fd)
