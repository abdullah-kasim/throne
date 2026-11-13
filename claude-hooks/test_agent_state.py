import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-state.py")
AGENT_NAME = "shadow-example-01"


class AgentStateTest(unittest.TestCase):
    def setUp(self):
        self.throne_home = tempfile.mkdtemp()
        self.agent_directory = os.path.join(self.throne_home, "data", AGENT_NAME)
        os.makedirs(self.agent_directory)
        self.state_file = os.path.join(self.agent_directory, "state.json")
        self.environment = dict(os.environ)
        self.environment["THRONE_DATA_HOME"] = self.throne_home
        self.environment["THRONE_AGENT_NAME"] = AGENT_NAME
        self.received_message = os.path.join(self.throne_home, "received-message.txt")
        stub_cli = os.path.join(self.throne_home, "throne-cli")
        with open(stub_cli, "w", encoding="utf-8") as handle:
            handle.write(f"#!/bin/sh\necho \"$*\" > {self.received_message}.arguments\ncat > {self.received_message}\n")
        os.chmod(stub_cli, 0o755)
        self.environment["THRONE_AGENT_STATE_CLI"] = stub_cli

    def submit_a_prompt(self, payload=None):
        text = payload if payload is not None else json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": "go on"})
        return subprocess.run([sys.executable, HOOK], input=text, capture_output=True, text=True, env=self.environment)

    def read_state(self):
        with open(self.state_file, encoding="utf-8") as handle:
            return json.load(handle)

    def test_a_stale_reapable_is_working_after_the_next_prompt(self):
        with open(self.state_file, "w", encoding="utf-8") as handle:
            json.dump({"state": "reapable", "blockedBy": [], "waitingOn": None, "reapableReason": "completed",
                       "declaredAt": "2026-11-01T00:00:00Z", "declaredBy": "agent"}, handle)
        result = self.submit_a_prompt()
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        state = self.read_state()
        self.assertEqual((state["state"], state["declaredBy"], state["reapableReason"]), ("working", "turn-start", None))

    def test_an_old_blocked_file_is_retired_by_the_next_prompt(self):
        with open(os.path.join(self.agent_directory, "blocked.json"), "w", encoding="utf-8") as handle:
            json.dump({"blockedAt": "2026-11-01T00:00:00Z"}, handle)
        self.submit_a_prompt()
        self.assertEqual(sorted(os.listdir(self.agent_directory)), ["state.json"])

    def test_nothing_happens_without_an_agent_name(self):
        del self.environment["THRONE_AGENT_NAME"]
        self.assertEqual(self.submit_a_prompt().returncode, 0)
        self.assertEqual(os.listdir(self.agent_directory), [])

    def test_an_agent_with_no_data_directory_gets_none_created(self):
        self.environment["THRONE_AGENT_NAME"] = "not-a-recorded-agent"
        self.assertEqual(self.submit_a_prompt().returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.throne_home, "data", "not-a-recorded-agent")))

    def test_unreadable_input_never_fails_the_prompt(self):
        for payload in ["not json", "[]", ""]:
            self.assertEqual(self.submit_a_prompt(payload).returncode, 0, payload)


    def end_a_turn(self, hook_input):
        payload = dict({"hook_event_name": "Stop", "stop_hook_active": False}, **hook_input)
        return subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True,
                              env=self.environment)

    def message_handed_to_throne(self):
        with open(f"{self.received_message}.arguments", encoding="utf-8") as handle:
            self.assertEqual(handle.read().strip(), "my-state --turn-end")
        with open(self.received_message, encoding="utf-8") as handle:
            return handle.read()

    def test_a_turn_end_hands_the_final_message_to_throne(self):
        message = 'Started.\n{"blocked":true} BLOCKED_BY_own-background-run (focused tests)'
        self.assertEqual(self.end_a_turn({"last_assistant_message": message}).returncode, 0)
        self.assertEqual(self.message_handed_to_throne(), message)
        self.assertFalse(os.path.exists(self.state_file))

    def test_a_turn_end_without_the_message_reads_the_last_assistant_text_in_the_transcript(self):
        transcript = os.path.join(self.throne_home, "transcript.jsonl")
        entries = [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "{\"reapable\":\"completed\"}"}]}},
            {"type": "user", "message": {"content": "go on"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "{\"blocked\":true} __BLOCKED_BY_shadow-a__"}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}},
        ]
        with open(transcript, "w", encoding="utf-8") as handle:
            handle.write("\n".join(json.dumps(entry) for entry in entries) + "\nnot json\n")
        self.assertEqual(self.end_a_turn({"transcript_path": transcript}).returncode, 0)
        self.assertEqual(self.message_handed_to_throne(), '{"blocked":true} __BLOCKED_BY_shadow-a__')

    def test_a_turn_end_with_no_message_calls_nothing(self):
        self.assertEqual(self.end_a_turn({"last_assistant_message": "  "}).returncode, 0)
        self.assertFalse(os.path.exists(self.received_message))


if __name__ == "__main__":
    unittest.main()
