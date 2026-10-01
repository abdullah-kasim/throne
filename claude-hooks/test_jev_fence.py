import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev-fence.py")
specification = importlib.util.spec_from_file_location("jev_fence", HOOK)
fence = importlib.util.module_from_spec(specification)
specification.loader.exec_module(fence)

HOME = os.path.expanduser("~")
CONFIGURED_KEY = "/srv/keys/typesafe.key"


def bash(command, cwd="/srv/work"):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}


def tool(tool_name, **tool_input):
    return {"tool_name": tool_name, "tool_input": tool_input}


def rule_for(payload):
    return fence.refused_rule(payload, CONFIGURED_KEY)


class AnAgentCannotReadOrCopyTheJevKeyFile(unittest.TestCase):
    def test_every_spelling_of_the_default_key_path_is_refused_in_bash(self):
        for command in [
            "cat ~/.jev-key",
            "cat $HOME/.jev-key",
            'cat "${HOME}/.jev-key"',
            "cat " + HOME + "/.jev-key",
            "cp ~/.jev-key /Users/theuser/tmp/scratch-home/.jev-key",
            "ln -s ~/.jev-key ~/tmp/home/",
            "head -c 4 ~/.jev-key-old",
            "HOME=/scratch node tool.js < ~/.jev-key",
            "python3 -c \"print(open('" + HOME + "/.jev-key').read())\"",
            "node -e \"require('fs').readFileSync(require('os').homedir() + '/.jev-key')\"",
            "python3 <<'EOF'\nprint(open('" + HOME + "/.jev-key').read())\nEOF",
        ]:
            self.assertEqual(rule_for(bash(command)), fence.KEY_FILE_RULE, command)

    def test_the_key_path_named_in_the_live_config_is_refused(self):
        self.assertEqual(rule_for(bash("cat " + CONFIGURED_KEY)), fence.KEY_FILE_RULE)
        self.assertEqual(rule_for(tool("Read", file_path=CONFIGURED_KEY)), fence.KEY_FILE_RULE)

    def test_file_tools_opening_a_key_file_are_refused(self):
        for tool_name in ["Read", "Write", "Edit", "MultiEdit"]:
            payload = tool(tool_name, file_path=HOME + "/.jev-key", content="x")
            self.assertEqual(rule_for(payload), fence.KEY_FILE_RULE, tool_name)
        self.assertEqual(rule_for(tool("Grep", pattern="a", path="~/.jev-key")), fence.KEY_FILE_RULE)

    def test_the_configured_key_path_is_read_from_config_user_ts(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory)
        config_path = os.path.join(directory, "config.user.ts")
        with open(config_path, "w") as handle:
            handle.write("export default {\n  recall: {\n    jevKeyFile: '~/.secrets/typesafe',\n  },\n};\n")
        self.assertEqual(fence.configured_key_file(config_path), HOME + "/.secrets/typesafe")
        self.assertIsNone(fence.configured_key_file(os.path.join(directory, "missing.ts")))

    def test_an_unreadable_config_still_refuses_the_default_key_path(self):
        self.assertEqual(fence.refused_rule(bash("cat ~/.jev-key"), None), fence.KEY_FILE_RULE)


class AnAgentCannotImportTheJevSdkOutsideTheJevBackend(unittest.TestCase):
    def test_writing_a_script_that_imports_the_sdk_is_refused(self):
        for tool_name, tool_input in [
            ("Write", {"file_path": "/Users/theuser/tmp/probe.mjs", "content": "import { TypeSafeClient } from '@typesafe-ai/sdk';\n"}),
            ("Write", {"file_path": "/srv/throne/src/other.ts", "content": "const sdk = await import('@typesafe-ai/sdk');\n"}),
            ("Edit", {"file_path": "/srv/probe.cjs", "old_string": "x", "new_string": "const s = require(\"@typesafe-ai/sdk\");"}),
            ("MultiEdit", {"file_path": "/srv/probe.ts", "edits": [{"old_string": "a", "new_string": "import '@typesafe-ai/sdk/dist/index.mjs';"}]}),
        ]:
            self.assertEqual(rule_for(tool(tool_name, **tool_input)), fence.SDK_IMPORT_RULE, tool_input)

    def test_running_inline_code_that_imports_the_sdk_is_refused(self):
        for command in [
            "node -e \"import('@typesafe-ai/sdk').then(sdk => sdk)\"",
            "node --input-type=module <<'EOF'\nimport { TypeSafeClient } from '@typesafe-ai/sdk';\nEOF",
            "cat > ~/tmp/probe.mjs <<'EOF'\nimport { TypeSafeClient } from '@typesafe-ai/sdk';\nEOF\nnode ~/tmp/probe.mjs",
            "echo \"import { TypeSafeClient } from '@typesafe-ai/sdk'\" > ~/tmp/probe.mts",
            "npx tsx -e \"const { TypeSafeClient } = require('/srv/throne/node_modules/@typesafe-ai/sdk')\"",
        ]:
            self.assertEqual(rule_for(bash(command)), fence.SDK_IMPORT_RULE, command)

    def test_the_jev_backend_itself_may_import_the_sdk(self):
        payload = tool(
            "Edit",
            file_path="/srv/throne/src/relevance-classifier/jev-backend.ts",
            old_string="a",
            new_string="const { TypeSafeClient } = await import('@typesafe-ai/sdk');",
        )
        self.assertIsNone(rule_for(payload))


class AnAgentCannotEditTheJevTokenLimitsInConfigUserTs(unittest.TestCase):
    def test_editing_either_limit_is_refused(self):
        for field in ["jevTokensPerDay", "jevTokensPerHour"]:
            payload = tool(
                "Edit",
                file_path="/srv/throne/config.user.ts",
                old_string="    " + field + ": 15_000_000,",
                new_string="    " + field + ": 90_000_000,",
            )
            self.assertEqual(rule_for(payload), fence.LIMIT_EDIT_RULE, field)

    def test_adding_a_limit_line_or_writing_a_config_with_one_is_refused(self):
        added = tool("Edit", file_path="/srv/config.user.ts", old_string="recall: {", new_string="recall: {\n    jevTokensPerHour: 9e9,")
        written = tool("Write", file_path="/nonexistent/config.user.ts", content="recall: { jevTokensPerDay: 1 }")
        self.assertEqual(rule_for(added), fence.LIMIT_EDIT_RULE)
        self.assertEqual(rule_for(written), fence.LIMIT_EDIT_RULE)

    def test_a_bash_command_writing_a_limit_into_config_user_ts_is_refused(self):
        for command in [
            "sed -i '' 's/jevTokensPerDay: .*/jevTokensPerDay: 1e12,/' /srv/throne/config.user.ts",
            "perl -pi -e 's/jevTokensPerHour: \\d+/jevTokensPerHour: 1/' config.user.ts",
            "python3 -c \"p='config.user.ts'; open(p,'w').write(open(p).read().replace('jevTokensPerDay: 1','jevTokensPerDay: 9'))\"",
        ]:
            self.assertEqual(rule_for(bash(command)), fence.LIMIT_EDIT_RULE, command)


class AnAgentCannotRunAWorktreeBuildOfRecallThatHasNoJevLimiter(unittest.TestCase):
    def build(self, backend_source):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        backend_directory = os.path.join(root, "dist", "src", "relevance-classifier")
        os.makedirs(backend_directory)
        with open(os.path.join(backend_directory, "jev-backend.js"), "w") as handle:
            handle.write(backend_source)
        return root

    def test_every_limited_command_of_a_build_without_the_limiter_is_refused(self):
        root = self.build("import { NO } from \"./classifier.types.js\";\n")
        for command in [
            "node " + root + "/dist/src/tools.js recall --hook",
            "THRONE_LIVE_ROOT=/x node " + root + "/dist/src/tools.js rank --json",
            root + "/bin/throne-cli sift log.txt",
            "node dist/src/tools.js jev-probe --question q --state s",
        ]:
            self.assertEqual(rule_for(bash(command, cwd=root)), fence.UNLIMITED_BUILD_RULE, command)

    def test_a_build_carrying_the_limiter_runs(self):
        root = self.build("import { reserveJevTokens } from \"./jev-budget.js\";\n")
        self.assertIsNone(rule_for(bash("node " + root + "/dist/src/tools.js recall --hook")))
        self.assertIsNone(rule_for(bash("./bin/throne-cli rank --json", cwd=root)))

    def test_other_commands_of_an_old_build_are_not_refused(self):
        root = self.build("")
        self.assertIsNone(rule_for(bash("node " + root + "/dist/src/tools.js campaign-evidence --base x")))


class TheFenceRefusalNamesRecallRankSiftModifyConfigAndThroneJevProbe(unittest.TestCase):
    def run_hook(self, payload, config_text=None):
        throne_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, throne_root)
        os.makedirs(os.path.join(throne_root, "claude-hooks"))
        hook_copy = os.path.join(throne_root, "claude-hooks", "jev-fence.py")
        shutil.copy(HOOK, hook_copy)
        if config_text is not None:
            with open(os.path.join(throne_root, "config.user.ts"), "w") as handle:
                handle.write(config_text)
        return subprocess.run([sys.executable, hook_copy], input=json.dumps(payload), capture_output=True, text=True)

    def test_the_refusal_is_a_pretooluse_deny_naming_the_rule_and_the_sanctioned_routes(self):
        result = self.run_hook(bash("cat ~/.jev-key"))
        self.assertEqual(result.returncode, 0)
        decision = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(decision["hookEventName"], "PreToolUse")
        self.assertEqual(decision["permissionDecision"], "deny")
        reason = decision["permissionDecisionReason"]
        for phrase in [fence.KEY_FILE_RULE, "throne recall", "throne rank", "throne sift", "/modify-config", "to test a Jev question, use throne jev-probe", "no bypass"]:
            self.assertIn(phrase, reason)

    def test_the_hook_reads_the_key_path_from_the_config_beside_it(self):
        config = "recall: {\n  jevKeyFile: '/srv/keys/typesafe.key',\n}\n"
        result = self.run_hook(tool("Read", file_path=CONFIGURED_KEY), config)
        self.assertIn(fence.KEY_FILE_RULE, json.loads(result.stdout)["hookSpecificOutput"]["permissionDecisionReason"])

    def test_an_allowed_call_and_unreadable_input_print_nothing(self):
        self.assertEqual(self.run_hook(bash("ls")).stdout, "")
        for text in ["not json", "[]"]:
            result = subprocess.run([sys.executable, HOOK], input=text, capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout), (0, ""), text)


class OrdinaryWorkThatOnlyMentionsTheKeyPathOrTheSdkNameIsNotRefused(unittest.TestCase):
    def test_ordinary_calls_pass(self):
        for payload in [
            tool("Read", file_path="/srv/throne/src/relevance-classifier/jev-backend.ts"),
            tool("Read", file_path="/srv/throne/docs/CONFIG.md"),
            tool("Edit", file_path="/srv/throne/docs/CONFIG.md", old_string="a", new_string="the key lives in `~/.jev-key`; `import { TypeSafeClient } from '@typesafe-ai/sdk'`"),
            tool("Write", file_path="/srv/notes.md", content="never cat ~/.jev-key"),
            bash("grep -rn jevKeyFile src"),
            bash("grep -rn '~/.jev-key' docs agent_docs"),
            bash("rg \"from '@typesafe-ai/sdk'\" src"),
            bash("git grep -n \"$HOME/.jev-key\""),
            bash("throne recall --memory-dir /x \"task\""),
            bash("throne rank --json a b"),
            bash("throne sift log.txt"),
            bash("throne jev-probe --question q --state s"),
            bash("cat docs/CONFIG.md"),
            bash("git commit -m 'Explain that ~/.jev-key is read only by the backend'"),
            bash("cat > ~/tmp/note.md <<'EOF'\nthe key is ~/.jev-key and the SDK is import('@typesafe-ai/sdk')\nEOF"),
            bash("npm run typecheck"),
        ]:
            self.assertIsNone(rule_for(payload), payload)


class EditingOtherConfigUserTsFieldsIsNotRefused(unittest.TestCase):
    def test_other_fields_can_be_edited(self):
        for payload in [
            tool("Edit", file_path="/srv/throne/config.user.ts", old_string="hookEnabled: false", new_string="hookEnabled: true"),
            tool(
                "Edit",
                file_path="/srv/throne/config.user.ts",
                old_string="    jevTokensPerDay: 15_000_000,\n    jevEnabled: false,",
                new_string="    jevTokensPerDay: 15_000_000,\n    jevEnabled: true,",
            ),
            bash("sed -i '' 's/hookEnabled: false/hookEnabled: true/' /srv/throne/config.user.ts"),
            bash("grep -n jevTokensPerDay /srv/throne/config.user.ts"),
        ]:
            self.assertIsNone(rule_for(payload), payload)

    def test_rewriting_the_whole_file_with_the_limits_unchanged_passes(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory)
        path = os.path.join(directory, "config.user.ts")
        with open(path, "w") as handle:
            handle.write("recall: {\n  jevTokensPerDay: 15_000_000,\n  hookEnabled: false,\n}\n")
        payload = tool("Write", file_path=path, content="recall: {\n  jevTokensPerDay: 15_000_000,\n  hookEnabled: true,\n}\n")
        self.assertIsNone(rule_for(payload))


if __name__ == "__main__":
    unittest.main()
