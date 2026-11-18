import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stager-tree-refresh.py")
PAYLOAD = json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": "go on", "cwd": "/somewhere"})


class StagerTreeRefreshHookTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.environment = dict(os.environ)

    def stub_cli(self, body):
        path = os.path.join(self.folder, "throne-cli")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n" + body)
        os.chmod(path, 0o755)
        self.environment["THRONE_STAGER_TREE_REFRESH_CLI"] = path

    def submit_a_prompt(self):
        return subprocess.run([sys.executable, HOOK], input=PAYLOAD, capture_output=True, text=True, env=self.environment)

    def test_the_refresh_line_is_shown_with_the_prompt(self):
        received = os.path.join(self.folder, "received")
        self.stub_cli(f'echo "$*" > {received}.arguments\ncat > {received}\necho "Fast-forwarded this Stager checkout"\n')
        result = self.submit_a_prompt()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"], "Fast-forwarded this Stager checkout")
        with open(f"{received}.arguments", encoding="utf-8") as handle:
            self.assertEqual(handle.read().strip(), "refresh-stager-tree")
        with open(received, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), PAYLOAD)

    def test_a_tree_needing_no_refresh_prints_nothing(self):
        self.stub_cli("exit 0\n")
        self.assertEqual((self.submit_a_prompt().returncode, self.submit_a_prompt().stdout), (0, ""))

    def test_a_refresh_failure_is_reported_on_stderr_and_does_not_block_the_prompt(self):
        self.environment["THRONE_STAGER_TREE_REFRESH_CLI"] = os.path.join(self.folder, "missing-cli")
        result = self.submit_a_prompt()
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertIn("stager-tree-refresh:", result.stderr)


if __name__ == "__main__":
    unittest.main()
