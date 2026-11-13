import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-exit-marker.py")
AGENT_NAME = "stager-south"


class AgentExitMarkerTest(unittest.TestCase):
    def setUp(self):
        self.throne_home = tempfile.mkdtemp()
        self.agent_directory = os.path.join(self.throne_home, "data", AGENT_NAME)
        os.makedirs(self.agent_directory)
        self.marker = os.path.join(self.agent_directory, "told-to-exit")
        self.environment = dict(os.environ)
        self.environment["THRONE_DATA_HOME"] = self.throne_home
        self.environment["THRONE_AGENT_NAME"] = AGENT_NAME

    def run_hook(self, hook_input):
        payload = hook_input if isinstance(hook_input, str) else json.dumps(hook_input)
        return subprocess.run(
            [sys.executable, HOOK], input=payload, capture_output=True, text=True, env=self.environment
        )

    def end_the_session(self, reason):
        return self.run_hook({"hook_event_name": "SessionEnd", "reason": reason, "session_id": "session-1"})

    def test_the_marker_is_written_when_the_user_quits(self):
        result = self.end_the_session("prompt_input_exit")
        self.assertEqual(result.returncode, 0)
        with open(self.marker, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["session_id"], "session-1")

    def test_a_signal_kill_or_a_clear_writes_no_marker(self):
        for reason in ["other", "clear", "resume", "logout"]:
            self.assertEqual(self.end_the_session(reason).returncode, 0, reason)
            self.assertFalse(os.path.exists(self.marker), reason)

    def test_the_marker_is_removed_when_the_agents_next_session_starts(self):
        self.end_the_session("prompt_input_exit")
        result = self.run_hook({"hook_event_name": "SessionStart", "source": "resume", "session_id": "session-1"})
        self.assertEqual(result.returncode, 0)
        self.assertFalse(os.path.exists(self.marker))

    def test_nothing_happens_without_an_agent_name(self):
        del self.environment["THRONE_AGENT_NAME"]
        result = self.end_the_session("prompt_input_exit")
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertEqual(os.listdir(self.agent_directory), [])

    def test_an_agent_with_no_data_directory_gets_none_created(self):
        self.environment["THRONE_AGENT_NAME"] = "not-a-recorded-agent"
        self.assertEqual(self.end_the_session("prompt_input_exit").returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.throne_home, "data", "not-a-recorded-agent")))

    def test_unreadable_input_never_fails_the_session(self):
        for payload in ["not json", "[]", ""]:
            result = self.run_hook(payload)
            self.assertEqual((result.returncode, result.stdout), (0, ""), payload)


if __name__ == "__main__":
    unittest.main()
