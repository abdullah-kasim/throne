import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web-fetch-failure-pointer.py")


class WebFetchFailurePointerTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.home = os.path.join(self.root, "home")
        self.project = os.path.join(self.root, "project")
        self.bin = os.path.join(self.root, "bin")
        for folder in (self.home, self.project, self.bin):
            os.makedirs(folder)
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_CONFIG")}
        self.environment["HOME"] = self.home
        self.environment["XDG_CACHE_HOME"] = os.path.join(self.root, "cache")
        self.environment["PATH"] = self.bin + os.pathsep + "/usr/bin:/bin"
        self.version_log = os.path.join(self.root, "version-calls")
        self.install_agent_browser("exit 0")
        self.session = 0

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def install_agent_browser(self, body):
        path = os.path.join(self.bin, "agent-browser")
        with open(path, "w") as handle:
            handle.write("#!/bin/sh\necho called >> '{log}'\n{body}\n".format(log=self.version_log, body=body))
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)

    def run_hook(self, payload, new_session=True):
        if new_session:
            self.session += 1
        payload = {"session_id": "session-" + str(self.session), "cwd": self.project, **payload}
        return subprocess.run(
            [sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True, env=self.environment
        )

    def web_fetch_refused(self, address, new_session=True):
        return self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "WebFetch",
                "tool_input": {"url": address, "prompt": "title?"},
                "tool_response": {"bytes": 0, "code": 403, "codeText": "Forbidden", "url": address},
            },
            new_session,
        )

    def bash_failed(self, command, error="Exit code 22", new_session=True):
        return self.run_hook(
            {
                "hook_event_name": "PostToolUseFailure",
                "tool_name": "Bash",
                "tool_input": {"command": command},
                "error": error,
                "is_interrupt": False,
            },
            new_session,
        )

    def bash_succeeded(self, command, stdout, new_session=True):
        return self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": command},
                "tool_response": {"stdout": stdout, "stderr": "", "interrupted": False},
            },
            new_session,
        )

    def advice(self, result):
        self.assertEqual(result.returncode, 0)
        if not result.stdout:
            return ""
        return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]

    def test_a_web_fetch_answered_with_403_gets_both_agent_browser_commands(self):
        text = self.advice(self.web_fetch_refused("https://blocked.example.com/"))
        self.assertIn("The fetch of https://blocked.example.com/ failed.", text)
        self.assertIn("agent-browser drives a real browser", text)
        self.assertIn("agent-browser open https://blocked.example.com/\n", text)
        self.assertRegex(text, r'agent-browser open https://blocked.example.com/ --user-agent "Mozilla/5\.0 .*Chrome/[0-9.]+ Safari/537\.36"')
        self.assertLessEqual(len(text.splitlines()), 4)

    def test_the_advice_is_shown_to_the_model_for_the_event_that_carried_the_failure(self):
        output = json.loads(self.web_fetch_refused("https://blocked.example.com/").stdout)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "PostToolUse")

    def test_a_web_fetch_that_raised_an_error_gets_advice(self):
        result = self.run_hook(
            {
                "hook_event_name": "PostToolUseFailure",
                "tool_name": "WebFetch",
                "tool_input": {"url": "https://blocked.example.com/page"},
                "error": "getaddrinfo ENOTFOUND blocked.example.com",
            }
        )
        self.assertIn("agent-browser open https://blocked.example.com/page", self.advice(result))

    def test_a_successful_web_fetch_gets_nothing(self):
        result = self.run_hook(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "WebFetch",
                "tool_input": {"url": "https://example.com/"},
                "tool_response": {"code": 200, "url": "https://example.com/"},
            }
        )
        self.assertEqual(self.advice(result), "")

    def test_a_curl_that_exited_non_zero_gets_advice(self):
        text = self.advice(self.bash_failed("curl -sS -f https://httpbin.org/status/403"))
        self.assertIn("agent-browser open https://httpbin.org/status/403", text)

    def test_a_wget_that_exited_non_zero_gets_advice(self):
        text = self.advice(self.bash_failed("wget -q -O /dev/null https://example.org/", "Exit code 4"))
        self.assertIn("agent-browser open https://example.org/", text)

    def test_a_curl_that_exited_zero_but_printed_a_refusing_status_gets_advice(self):
        result = self.bash_succeeded('curl -sS -o /dev/null -w "%{http_code}" https://httpbin.org/status/429', "429")
        self.assertIn("agent-browser open https://httpbin.org/status/429", self.advice(result))

    def test_a_curl_that_succeeded_gets_nothing(self):
        result = self.bash_succeeded('curl -sS -o /dev/null -w "%{http_code}" https://example.com/', "200")
        self.assertEqual(self.advice(result), "")

    def test_a_failed_bash_call_that_fetches_nothing_gets_nothing(self):
        self.assertEqual(self.advice(self.bash_failed("grep https://example.com/ notes.txt", "Exit code 1")), "")

    def test_local_private_and_tailnet_addresses_get_nothing(self):
        for address in (
            "http://localhost:8430/api",
            "http://127.0.0.1:3000/",
            "http://[::1]:80/",
            "http://10.0.0.5/",
            "http://192.168.1.20/",
            "http://172.16.4.4/",
            "https://box.tail1234.ts.net/throne",
            "http://100.101.1.2:8430/throne",
        ):
            self.assertEqual(self.advice(self.bash_failed("curl -f " + address)), "", address)
            self.assertEqual(self.advice(self.web_fetch_refused(address)), "", address)

    def test_the_same_address_is_advised_once_per_session(self):
        self.assertNotEqual(self.advice(self.web_fetch_refused("https://blocked.example.com/")), "")
        self.assertEqual(self.advice(self.web_fetch_refused("https://blocked.example.com/", new_session=False)), "")
        self.assertNotEqual(self.advice(self.web_fetch_refused("https://other.example.com/", new_session=False)), "")
        self.assertNotEqual(self.advice(self.web_fetch_refused("https://blocked.example.com/")), "")

    def test_nothing_is_printed_when_agent_browser_does_not_run(self):
        self.install_agent_browser("echo 'agent-browser is not provided by the active node' >&2; exit 1")
        self.assertEqual(self.advice(self.web_fetch_refused("https://blocked.example.com/")), "")

    def test_nothing_is_printed_when_agent_browser_is_missing(self):
        os.remove(os.path.join(self.bin, "agent-browser"))
        self.assertEqual(self.advice(self.web_fetch_refused("https://blocked.example.com/")), "")

    def test_nothing_is_printed_when_agent_browser_hangs_past_the_time_limit(self):
        self.install_agent_browser("sleep 10")
        self.assertEqual(self.advice(self.web_fetch_refused("https://blocked.example.com/")), "")

    def test_whether_agent_browser_runs_is_checked_once_per_session(self):
        self.web_fetch_refused("https://one.example.com/")
        self.web_fetch_refused("https://two.example.com/", new_session=False)
        with open(self.version_log) as handle:
            self.assertEqual(len(handle.read().splitlines()), 1)

    def test_the_skill_is_named_when_the_working_folder_has_one(self):
        skill = os.path.join(self.project, ".claude", "skills", "agent-browser", "SKILL.md")
        os.makedirs(os.path.dirname(skill))
        open(skill, "w").close()
        self.assertIn("The agent-browser skill is at " + skill + ".", self.advice(self.web_fetch_refused("https://blocked.example.com/")))

    def test_the_home_skill_is_named_when_the_working_folder_has_none(self):
        skill = os.path.join(self.home, ".claude", "skills", "agent-browser", "SKILL.md")
        os.makedirs(os.path.dirname(skill))
        open(skill, "w").close()
        self.assertIn(skill, self.advice(self.web_fetch_refused("https://blocked.example.com/")))

    def test_no_skill_line_when_no_skill_exists(self):
        self.assertNotIn("skill", self.advice(self.web_fetch_refused("https://blocked.example.com/")))

    def test_a_broken_payload_prints_nothing_and_exits_zero(self):
        result = subprocess.run([sys.executable, HOOK], input="{ not json", capture_output=True, text=True, env=self.environment)
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_an_unwritable_cache_prints_nothing_and_exits_zero(self):
        blocker = os.path.join(self.root, "cache")
        open(blocker, "w").close()
        result = self.web_fetch_refused("https://blocked.example.com/")
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_the_hook_never_blocks_or_rewrites_the_call(self):
        output = json.loads(self.web_fetch_refused("https://blocked.example.com/").stdout)
        self.assertEqual(set(output), {"hookSpecificOutput"})
        self.assertEqual(set(output["hookSpecificOutput"]), {"hookEventName", "additionalContext"})


if __name__ == "__main__":
    unittest.main()
