"""Natural-language approvals stay bound to sender, action, target and revision."""
import datetime
import runpy
import unittest
from pathlib import Path

A = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts/helio_approval.py"))
REPO = "jamestesting0/elo-bot"
BOT = "999000000000000001"
HEAD = "a1b2c3d4" + "e" * 32
NOW = datetime.datetime(2026, 11, 3, 12, 0, tzinfo=datetime.timezone.utc)


def message(content, minutes_ago=1, referenced=None):
    sent = (NOW - datetime.timedelta(minutes=minutes_ago)).isoformat()
    return {"content": content, "timestamp": sent, **({"referenced_message": referenced} if referenced else {})}


def helio_says(content):
    return {"content": content, "author": {"id": BOT}}


class IntentTests(unittest.TestCase):
    def accepted(self, action, msg, pr=123):
        A["check_intent"](action, msg, BOT, REPO, pr if action == "merge" else None, now=NOW)

    def refused(self, action, msg, pr=123):
        with self.assertRaises(A["Refused"]):
            self.accepted(action, msg, pr)

    def test_clear_natural_requests_are_accepted(self):
        self.accepted("merge", message("yeah merge #123 please"))
        self.accepted("merge", message("ship it", referenced={"content": "PR https://github.com/jamestesting0/elo-bot/pull/123", "author": {"id": "5"}}))
        self.accepted("merge", message("approve merge jamestesting0/elo-bot#123 " + HEAD))
        self.accepted("restart", message("ok restart the bot"))

    def test_yes_counts_only_as_a_reply_to_helios_own_question(self):
        self.accepted("merge", message("yes", referenced=helio_says("Merge jamestesting0/elo-bot#123 (head a1b2c3d)?")))
        self.accepted("restart", message("go ahead", referenced=helio_says("Restart elobot at a1b2c3d?")))
        self.refused("merge", message("yes", referenced={"content": "Merge #123?", "author": {"id": "5"}}))
        self.refused("merge", message("yes"))

    def test_unrelated_or_ambiguous_messages_are_refused(self):
        self.refused("merge", message("lol #123"))
        self.refused("restart", message("nice work"))
        self.refused("merge", message("merge it"))
        self.refused("merge", message("merge #123 and #124"))
        self.refused("merge", message("merge #124"))
        self.refused("merge", message("merge it <#1218071208197623880>"))

    def test_stale_and_future_messages_are_refused(self):
        self.refused("merge", message("merge #123", minutes_ago=16))
        self.refused("merge", message("merge #123", minutes_ago=-5))


class RevisionTests(unittest.TestCase):
    def activity(self, after, minutes_ago):
        pushed = (NOW - datetime.timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")
        return lambda repo, branch: [{"after": after, "timestamp": pushed}]

    def test_named_sha_pins_without_network(self):
        def no_network(repo, branch):
            raise AssertionError("must not query GitHub")
        A["check_revision"](HEAD, message("merge #123 a1b2c3d"), REPO, "fix", activity=no_network)

    def test_naming_a_different_sha_is_refused_without_network(self):
        def no_network(repo, branch):
            raise AssertionError("must not query GitHub")
        with self.assertRaises(A["Refused"]):
            A["check_revision"](HEAD, message("merge #123 at deadbeef"), REPO, "fix", activity=no_network)

    def test_push_before_message_pins_the_revision(self):
        A["check_revision"](HEAD, message("merge #123", minutes_ago=1), REPO, "fix", activity=self.activity(HEAD, 5))

    def test_push_after_message_or_moved_branch_is_refused(self):
        for activity in (self.activity(HEAD, 0), self.activity("f" * 40, 5), lambda repo, branch: []):
            with self.subTest(activity=activity), self.assertRaises(A["Refused"]):
                A["check_revision"](HEAD, message("merge #123", minutes_ago=1), REPO, "fix", activity=activity)


if __name__ == "__main__":
    unittest.main()
