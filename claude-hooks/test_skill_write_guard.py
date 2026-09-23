import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skill-write-guard.py")
specification = importlib.util.spec_from_file_location("skill_write_guard", HOOK)
guard = importlib.util.module_from_spec(specification)
specification.loader.exec_module(guard)


class IsSkillFileTest(unittest.TestCase):
    def test_recognized_skill_tree_shapes(self):
        for path in [
            ".claude/skills/foo/SKILL.md",
            "/a/b/.claude/skills/foo/SKILL.md",
            ".agents/skills/foo/SKILL.md",
            "/a/b/skills/.claude/skills/foo/SKILL.md",
        ]:
            self.assertTrue(guard.is_skill_file(path), path)

    def test_unrecognized_paths(self):
        for path in [
            "SKILL.md",
            ".claude/skills/foo/README.md",
            "/a/b/.claude/skills/SKILL.md",
            "src/tools.ts",
        ]:
            self.assertFalse(guard.is_skill_file(path), path)


class ForeignHomePathTest(unittest.TestCase):
    def test_own_and_other_home_paths_are_hits(self):
        own_home = os.path.expanduser("~")
        for content in [own_home + "/notes", "/Users/theuser/project", "/home/otheruser/project"]:
            self.assertTrue(guard.foreign_home_path_hits(content), content)

    def test_no_home_path_is_clean(self):
        self.assertEqual(guard.foreign_home_path_hits("no path here at all"), [])


class HookProcessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.private_refs = os.path.join(self.directory, "private-refs.txt")
        with open(self.private_refs, "w") as handle:
            handle.write("bannedterm\n")
        self.environment = dict(os.environ)
        self.environment["THRONE_PRIVATE_REFS"] = self.private_refs

    def write_skill_file(self, content):
        skill_directory = os.path.join(self.directory, ".claude", "skills", "example")
        os.makedirs(skill_directory, exist_ok=True)
        path = os.path.join(skill_directory, "SKILL.md")
        with open(path, "w") as handle:
            handle.write(content)
        return path

    def run_hook(self, file_path):
        payload = json.dumps({"tool_name": "Write", "tool_input": {"file_path": file_path}})
        return subprocess.run(
            [sys.executable, HOOK], input=payload, capture_output=True, text=True, env=self.environment
        )

    def test_a_skill_write_with_a_banned_pattern_is_denied_naming_the_line(self):
        path = self.write_skill_file("intro\nthis line has bannedterm in it\n")
        result = self.run_hook(path)
        self.assertEqual(result.returncode, 0)
        decision = json.loads(result.stdout)
        self.assertEqual(decision["decision"], "block")
        self.assertIn("line 2", decision["reason"])
        self.assertIn("bannedterm", decision["reason"])

    def test_a_clean_skill_write_gets_a_reminder(self):
        path = self.write_skill_file("this is a perfectly clean skill file\n")
        result = self.run_hook(path)
        self.assertEqual(result.returncode, 0)
        decision = json.loads(result.stdout)
        self.assertIn("/skill-writer", decision["hookSpecificOutput"]["additionalContext"])

    def test_a_non_skill_path_produces_no_advisory(self):
        path = os.path.join(self.directory, "README.md")
        with open(path, "w") as handle:
            handle.write("bannedterm\n")
        result = self.run_hook(path)
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_a_skill_write_with_a_real_absolute_home_path_is_denied(self):
        path = self.write_skill_file("see /Users/theuser/project for reference\n")
        result = self.run_hook(path)
        self.assertEqual(result.returncode, 0)
        decision = json.loads(result.stdout)
        self.assertEqual(decision["decision"], "block")
        self.assertIn("/Users/theuser", decision["reason"])

    def test_unreadable_input_never_blocks(self):
        for payload in ["not json", "[]", '{"tool_input": {"file_path": 7}}']:
            result = subprocess.run(
                [sys.executable, HOOK], input=payload, capture_output=True, text=True, env=self.environment
            )
            self.assertEqual((result.returncode, result.stdout), (0, ""), payload)


if __name__ == "__main__":
    unittest.main()
