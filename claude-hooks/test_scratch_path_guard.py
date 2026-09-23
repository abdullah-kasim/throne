import importlib.util
import json
import os
import subprocess
import sys
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scratch-path-guard.py")
specification = importlib.util.spec_from_file_location("scratch_path_guard", HOOK)
guard = importlib.util.module_from_spec(specification)
specification.loader.exec_module(guard)


class HomeSpellingTest(unittest.TestCase):
    def test_removals_that_spell_home_indirectly_are_caught(self):
        for command, spelling in {
            "J=~/a/b/c; rm -f $J/*": "~",
            "rm -rf ~/tmp/build": "~",
            "sudo rm -f ~/x": "~",
            'rm -rf "$HOME/tmp/x"': "$HOME",
            "cd x && rmdir ${HOME}/old": "$HOME",
        }.items():
            self.assertEqual(guard.home_spelling_in(command), spelling, command)

    def test_literal_paths_and_non_removals_pass(self):
        for command in [
            "rm -f /home/someone/tmp/build/*",
            "J=/a/b/c; rm -f $J/*",
            "ls ~/tmp",
            "cat ~/notes.md | grep rm",
            "git rm --cached file~",
            "echo 'rm ~/x'",
            "npm run format",
        ]:
            self.assertIsNone(guard.home_spelling_in(command), command)

    def test_prose_about_removals_is_not_a_removal(self):
        heredoc = "cat > notes.md <<'EOF'\nnever run rm -rf ~/tmp by hand\nEOF\necho done"
        commit = "git commit -m 'stop rm ~/x from stalling'"
        for command in [heredoc, commit]:
            self.assertIsNone(guard.home_spelling_in(command), command)

    def test_a_removal_after_a_heredoc_is_still_caught(self):
        command = "cat > notes.md <<EOF\nhello\nEOF\nrm -rf ~/tmp/build"
        self.assertEqual(guard.home_spelling_in(command), "~")


class ScratchPathTest(unittest.TestCase):
    def refused_guidance(self, command):
        refusal = guard.scratch_path_refusal(command)
        return None if refusal is None else refusal[0]

    def test_writes_moves_and_removals_under_the_shared_tmp_are_refused(self):
        for command in [
            "echo hi > /tmp/x",
            "echo hi >> /tmp/x",
            "npm test 2>/tmp/err.txt",
            'echo hi > "/tmp/x"',
            "echo hi | tee /tmp/x",
            "echo hi | tee -a /tmp/x",
            "mktemp /tmp/build.XXXX",
            "mktemp -p /tmp",
            "mktemp --tmpdir=/tmp",
            "cp notes.md /tmp/notes.md",
            "mv /tmp/a /home/someone/tmp/a",
            "touch /tmp/marker",
            "mkdir -p /tmp/work",
            "rm -rf /tmp/work",
            "rmdir /tmp/work",
            "sudo rm -f /tmp/x",
            "cd x && touch /private/tmp/marker",
            "mkdir -p /private/tmp/claude-501/scratchpad/x",
            "cat <<EOF > /tmp/a\nbody\nEOF",
        ]:
            self.assertIs(self.refused_guidance(command), guard.SHARED_TMP_GUIDANCE, command)

    def test_writes_to_a_single_segment_root_path_are_refused(self):
        for command in [
            "npm run lint > /tmp_lintout.txt 2>&1; tail -50 /tmp_lintout.txt; rm -f /tmp_lintout.txt",
            "rm -f /tmp_lintout.txt",
            "echo x > /out.txt",
            "touch /tmp_x",
        ]:
            self.assertIs(self.refused_guidance(command), guard.ROOT_PATH_GUIDANCE, command)

    def test_reads_and_home_scratch_writes_pass(self):
        for command in [
            "cat /tmp/foo",
            "ls -la /tmp",
            "grep -r needle /tmp/logs",
            "head -5 /private/tmp/claude-501/x",
            "cp /tmp/report.txt /home/someone/tmp/report.txt",
            "echo hi > /home/someone/tmp/x",
            "rm -rf /home/someone/tmp/x",
            "mktemp -d",
            "npm test > /dev/null 2>&1",
            "ls /",
            "cd /opt && ls",
        ]:
            self.assertIsNone(guard.scratch_path_refusal(command), command)

    def test_quoted_prose_and_heredoc_bodies_about_tmp_are_inert(self):
        for command in [
            "git commit -m 'never write > /tmp/x'",
            "echo 'rm -rf /tmp/x'",
            "cat > /home/someone/tmp/notes.md <<'EOF'\necho hi > /tmp/x\nrm -f /tmp_lintout.txt\nEOF",
        ]:
            self.assertIsNone(guard.scratch_path_refusal(command), command)


class HookProcessTest(unittest.TestCase):
    def run_hook(self, command):
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
        return subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True)

    def decision_for(self, command):
        result = self.run_hook(command)
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout)["hookSpecificOutput"]

    def test_a_caught_removal_is_denied_with_the_literal_home_path(self):
        decision = self.decision_for("J=~/a/b/c; rm -f $J/*")
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn(os.path.expanduser("~"), decision["permissionDecisionReason"])

    def test_a_shared_tmp_write_is_denied_naming_the_home_tmp_directory_and_the_scratchpad(self):
        decision = self.decision_for("echo hi > /tmp/x")
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn(os.path.expanduser("~/tmp"), decision["permissionDecisionReason"])
        self.assertIn("/private/tmp/claude-<uid>/", decision["permissionDecisionReason"])

    def test_the_command_that_trapped_a_shadow_is_denied_with_the_root_path_reason(self):
        decision = self.decision_for("npm run lint > /tmp_lintout.txt 2>&1; rm -f /tmp_lintout.txt")
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn("filesystem root", decision["permissionDecisionReason"])
        self.assertIn(os.path.expanduser("~/tmp"), decision["permissionDecisionReason"])

    def test_an_ordinary_command_produces_no_decision(self):
        for command in ["ls ~/tmp", "cat /tmp/foo", "rm -rf " + os.path.expanduser("~/tmp/x")]:
            result = self.run_hook(command)
            self.assertEqual((result.returncode, result.stdout), (0, ""), command)

    def test_unreadable_input_never_blocks(self):
        for payload in ["not json", "[]", '{"tool_input": {"command": 7}}']:
            result = subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout), (0, ""), payload)


if __name__ == "__main__":
    unittest.main()
