import os
import pwd
import runpy
import tempfile
import unittest
from pathlib import Path

P = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_owner_policy.py"))
ME = pwd.getpwuid(os.getuid())


class AgentFileTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.home = self.root / "home"
        (self.home / ".dori/elobot").mkdir(parents=True)
        self.outside = self.root / "outside"
        self.outside.mkdir()

    def test_round_trip_with_mode(self) -> None:
        P["write_agent_file"](str(self.home), ME, ".dori/elobot/state.json", b"{}\n", 0o644)
        self.assertEqual(P["read_agent_file"](str(self.home), ".dori/elobot/state.json"), b"{}\n")
        self.assertEqual((self.home / ".dori/elobot/state.json").stat().st_mode & 0o777, 0o644)

    def test_a_symlinked_directory_is_refused_and_its_target_untouched(self) -> None:
        (self.home / ".local").symlink_to(self.outside)
        with self.assertRaises(OSError):
            P["write_agent_file"](str(self.home), ME, ".local/node", b"x")
        self.assertEqual(list(self.outside.iterdir()), [])
        self.assertIsNone(P["read_agent_file"](str(self.home), ".local/node"))

    def test_a_hard_link_is_replaced_without_changing_the_linked_file(self) -> None:
        victim = self.outside / "victim"
        victim.write_text("keep")
        os.link(victim, self.home / ".dori/elobot/env")
        P["write_agent_file"](str(self.home), ME, ".dori/elobot/env", b"new")
        self.assertEqual(victim.read_text(), "keep")
        self.assertEqual((self.home / ".dori/elobot/env").read_text(), "new")

    def test_links_and_fifos_are_not_read(self) -> None:
        (self.outside / "secret").write_text("no")
        (self.home / ".dori/elobot/env").symlink_to(self.outside / "secret")
        os.mkfifo(self.home / ".dori/elobot/pipe")
        self.assertIsNone(P["read_agent_file"](str(self.home), ".dori/elobot/env"))
        self.assertIsNone(P["read_agent_file"](str(self.home), ".dori/elobot/pipe"))
        self.assertIsNone(P["read_agent_file"](str(self.home), ".dori/elobot/missing"))


if __name__ == "__main__":
    unittest.main()
