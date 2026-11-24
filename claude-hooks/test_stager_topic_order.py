import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stager-topic-order.py")


class StagerTopicOrderHookTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.environment = dict(os.environ, THRONE_DATA_HOME=self.home, THRONE_AGENT_NAME="stager-board")

    def register(self, name, role):
        folder = os.path.join(self.home, "data", name)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "identity.md"), "w", encoding="utf-8") as handle:
            handle.write(f"# Identity — {name}\n\n- **Role:** {role}\n")
        return folder

    def save_topic(self, topic):
        with open(os.path.join(self.register("stager-board", "Stager"), "topic.md"), "w", encoding="utf-8") as handle:
            handle.write(topic + "\n")

    def submit(self, prompt="fix the footprint", payload=None):
        text = payload if payload is not None else json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": prompt})
        return subprocess.run([sys.executable, HOOK], input=text, capture_output=True, text=True, env=self.environment)

    def order(self, result):
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]

    def test_a_prompt_in_a_stager_session_gets_the_topic_order(self):
        self.register("stager-board", "Stager")
        self.assertIn("ORDER", self.order(self.submit()))

    def test_a_prompt_in_a_session_that_is_not_a_stager_gets_no_topic_order(self):
        self.register("stager-board", "Alpha")
        result = self.submit()
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.environment.pop("THRONE_AGENT_NAME")
        result = self.submit()
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_a_delivered_message_to_a_stager_gets_no_topic_order(self):
        self.register("stager-board", "Stager")
        result = self.submit("The plugin sent a message:\n<message52506>\nRegent said: hello\n</message52506>")
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_the_topic_order_quotes_the_saved_topic_and_says_to_hand_a_changed_topic_over(self):
        self.save_topic("the keyboard pcb")
        order = self.order(self.submit())
        self.assertIn("changes the topic from: the keyboard pcb.", order)
        self.assertIn("as wide as one project (a board, a repo)", order)
        self.assertIn("Record the verdict first with 'throne topic same' or 'throne topic changed <slug>", order)
        self.assertNotIn("topic: same", order)
        self.assertIn("do not answer the prompt", order)
        self.assertIn("relay it verbatim to a live stager-<slug>, or fork stager-<slug>, trimmed to 32 characters", order)
        self.assertIn("Do nothing else.", order)

    def test_the_topic_order_never_asks_for_a_description_with_a_changed_verdict(self):
        self.save_topic("the keyboard pcb")
        self.assertNotIn("changed <slug> --description", self.order(self.submit()))
        self.save_topic("")
        self.assertNotIn("changed <slug> --description", self.order(self.submit()))

    def test_with_no_saved_topic_the_order_asks_the_stager_to_name_the_topic(self):
        self.save_topic("")
        order = self.order(self.submit())
        self.assertIn("run 'throne topic none' for a greeting, a startup brief or a slash command", order)
        self.assertIn("'throne topic same --description \"<topic>\"'", order)

    def test_a_stager_prompt_after_a_prompt_with_no_recorded_verdict_says_so_in_the_order(self):
        self.save_topic("the keyboard pcb")
        self.assertTrue(self.order(self.submit()).startswith("ORDER"))
        result = self.submit()
        self.assertTrue(self.order(result).startswith("Your last prompt got no topic verdict"))
        self.assertIn("got no topic verdict", result.stderr)

    def test_a_recorded_verdict_clears_the_missed_verdict_notice(self):
        self.save_topic("the keyboard pcb")
        self.submit()
        with open(os.path.join(self.home, "data", "stager-board", "topic-verdicts.jsonl"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"verdict": "same", "at": "2999-01-01T00:00:00.000Z"}) + "\n")
        self.assertTrue(self.order(self.submit()).startswith("ORDER"))

    def test_a_failure_inside_the_topic_order_hook_lets_the_prompt_through(self):
        self.register("stager-board", "Stager")
        result = self.submit(payload="not json")
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertIn("stager-topic-order:", result.stderr)


if __name__ == "__main__":
    unittest.main()
