"""Exercise the launcher's broker mounts with real socket replacement."""
import ast
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
PROBE = """
import socket, sys
for _ in range(2):
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(sys.argv[1])
    print("connected", flush=True)
    if not sys.stdin.readline():
        break
"""


class BrokerMountTests(unittest.TestCase):
    def test_broker_socket_replacement_is_visible_without_restarting_sandbox(self):
        tree = ast.parse((ROOT / "scripts/helio_isolated_launcher.py").read_text())
        command = next(node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == "cmd" for target in node.targets))
        self.assertIsInstance(command, ast.List)
        for directory, filename in (("helio-release-service", "release.sock"),
                                    ("helio-beta-service", "maintenance.sock")):
            with self.subTest(broker=directory), tempfile.TemporaryDirectory() as temp:
                destination = f"/run/{directory}"
                bind = next(command.elts[index:index + 3] for index, value in enumerate(command.elts)
                            if isinstance(value, ast.Constant) and value.value == "--ro-bind"
                            and isinstance(command.elts[index + 1], ast.Constant)
                            and str(command.elts[index + 1].value).startswith(destination))
                source = Path(temp) / filename
                mounted = str(bind[2].value)
                origin = temp if bind[1].value == destination else str(source)
                server = socket.socket(socket.AF_UNIX)
                process = None
                try:
                    server.bind(str(source))
                    server.listen(4)
                    process = subprocess.Popen([
                        "bwrap", "--unshare-user", "--unshare-pid", "--die-with-parent",
                        "--ro-bind", "/", "/", "--tmpfs", "/run", "--dir", destination,
                        str(bind[0].value), origin, mounted, "--",
                        sys.executable, "-c", PROBE, f"{destination}/{filename}",
                    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0], "sandbox did not start")
                    self.assertEqual(process.stdout.readline().strip(), "connected")
                    server.close()
                    source.unlink()
                    server = socket.socket(socket.AF_UNIX)
                    server.bind(str(source))
                    server.listen(4)
                    output, error = process.communicate("\n", timeout=5)
                    self.assertEqual(process.returncode, 0, error)
                    self.assertEqual(output.strip(), "connected")
                finally:
                    server.close()
                    if process is not None:
                        if process.poll() is None:
                            process.kill()
                        process.communicate(timeout=5)
