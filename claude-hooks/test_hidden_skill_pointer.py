import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hidden-skill-pointer.py")


class HiddenSkillPointerTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.home = os.path.join(self.root, "home")
        self.project = os.path.join(self.root, "project")
        os.makedirs(os.path.join(self.home, ".claude"))
        os.makedirs(os.path.join(self.project, ".claude"))
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_CONFIG")}
        self.environment["HOME"] = self.home
        self.environment["XDG_CACHE_HOME"] = os.path.join(self.root, "cache")
        self.environment.pop("THRONE_DATA_HOME", None)
        self.session = 0
        self.write_user_overrides({"alphaskill": "user-invocable-only", "betaskill": "name-only", "gammaskill": "off"})

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write_user_overrides(self, overrides):
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as handle:
            json.dump({"skillOverrides": overrides}, handle)

    def add_skill(self, folder, name):
        skill_folder = os.path.join(folder, ".claude", "skills", name)
        os.makedirs(skill_folder, exist_ok=True)
        path = os.path.join(skill_folder, "SKILL.md")
        with open(path, "w") as handle:
            handle.write("say hello\n")
        return path

    def run_hook(self, payload, new_session=True):
        if new_session:
            self.session += 1
        payload = {"session_id": "session-" + str(self.session), "cwd": self.project, **payload}
        return subprocess.run(
            [sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True, env=self.environment
        )

    def prompt(self, text, new_session=True):
        return self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": text}, new_session)

    def read(self, path, content, new_session=True):
        payload = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
            "tool_input": {"file_path": path},
            "tool_response": {"type": "text", "file": {"filePath": path, "content": content}},
        }
        return self.run_hook(payload, new_session)

    def context(self, result):
        self.assertEqual(result.returncode, 0)
        if not result.stdout:
            return ""
        return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]

    def test_a_prompt_naming_a_hidden_skill_in_the_middle_of_a_sentence_points_the_agent_at_its_file(self):
        path = self.add_skill(self.project, "alphaskill")
        result = self.prompt("when you are done, run /alphaskill. thanks")
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "UserPromptSubmit")
        self.assertEqual(
            output["additionalContext"],
            "/alphaskill is a skill hidden from your listing. Its file is " + path + ". Read it and follow it.",
        )

    def test_a_longer_name_or_a_path_segment_that_contains_a_hidden_name_points_at_nothing(self):
        self.add_skill(self.project, "alphaskill")
        for text in ["run /alphaskill-more", "look in /tmp/alphaskill", "see docs/alphaskill", "run /alphaskill_two"]:
            self.assertEqual(self.context(self.prompt(text)), "", text)

    def test_a_skill_turned_off_or_left_visible_gets_no_pointer(self):
        self.add_skill(self.project, "gammaskill")
        self.add_skill(self.project, "deltaskill")
        self.assertEqual(self.context(self.prompt("run /gammaskill and /deltaskill")), "")

    def test_the_skill_is_found_in_the_working_folder_before_the_users_skills_folder(self):
        project_path = self.add_skill(self.project, "alphaskill")
        self.add_skill(self.home, "alphaskill")
        self.assertIn(project_path, self.context(self.prompt("run /alphaskill")))
        os.remove(project_path)
        self.assertIn(
            os.path.join(self.home, ".claude", "skills", "alphaskill", "SKILL.md"),
            self.context(self.prompt("run /alphaskill")),
        )

    def test_a_worktree_session_finds_the_skill_in_its_main_checkout_before_the_users_skills_folder(self):
        checkout = os.path.join(self.root, "checkout")
        os.makedirs(checkout)
        quiet = {"capture_output": True, "check": True, "env": self.environment}
        subprocess.run(["git", "-C", checkout, "init", "-q"], **quiet)
        worktree = os.path.join(self.root, "worktree")
        subprocess.run(["git", "-C", checkout, "worktree", "add", "-q", "--orphan", "-b", "side", worktree], **quiet)
        checkout_path = self.add_skill(checkout, "alphaskill")
        self.add_skill(self.home, "alphaskill")
        result = self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": "run /alphaskill", "cwd": worktree})
        self.assertIn(os.path.realpath(checkout_path), self.context(result))

    def test_a_hidden_skill_with_no_file_anywhere_gets_no_pointer(self):
        self.assertEqual(self.context(self.prompt("run /alphaskill")), "")

    def test_calling_the_skill_tool_with_a_hidden_name_is_allowed_and_points_at_its_file(self):
        path = self.add_skill(self.project, "alphaskill")
        result = self.run_hook({"hook_event_name": "PreToolUse", "tool_name": "Skill", "tool_input": {"skill": "alphaskill"}})
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertNotIn("permissionDecision", output)
        self.assertIn(path, output["additionalContext"])

    def test_reading_a_todo_file_under_the_throne_data_home_that_names_a_hidden_skill_points_at_it(self):
        path = self.add_skill(self.project, "alphaskill")
        todo = os.path.join(self.home, ".throne", "data", "someone", "todo", "01_task.md")
        self.assertIn(path, self.context(self.read(todo, "then run /alphaskill")))
        self.environment["THRONE_DATA_HOME"] = os.path.join(self.root, "elsewhere")
        self.assertEqual(self.context(self.read(todo, "then run /alphaskill")), "")
        self.assertIn(path, self.context(self.read(os.path.join(self.root, "elsewhere", "brief.md"), "run /alphaskill")))

    def test_reading_instruction_files_agent_docs_and_skill_files_that_name_a_hidden_skill_points_at_it(self):
        self.add_skill(self.project, "alphaskill")
        for name in ["CLAUDE.md", "AGENTS.md", "agent_docs/topic.md", ".claude/skills/other/SKILL.md", "skills/other/notes.md"]:
            path = os.path.join(self.project, name)
            self.assertIn("/alphaskill is a skill", self.context(self.read(path, "run /alphaskill")), name)

    def test_reading_a_source_file_or_a_plain_readme_that_names_a_hidden_skill_points_at_nothing(self):
        self.add_skill(self.project, "alphaskill")
        for name in ["src/tool.ts", "README.md", "docs/guide.md", "agent_docs/script.py"]:
            self.assertEqual(self.context(self.read(os.path.join(self.project, name), "run /alphaskill")), "", name)

    def test_a_skills_own_skill_file_does_not_point_at_itself(self):
        path = self.add_skill(self.project, "alphaskill")
        self.add_skill(self.project, "betaskill")
        context = self.context(self.read(path, "run /alphaskill then /betaskill"))
        self.assertNotIn("/alphaskill is", context)
        self.assertIn("/betaskill is", context)

    def test_each_hidden_skill_is_pointed_at_once_per_session(self):
        self.add_skill(self.project, "alphaskill")
        self.assertNotEqual(self.context(self.prompt("run /alphaskill")), "")
        self.assertEqual(self.context(self.prompt("run /alphaskill again", new_session=False)), "")
        self.assertNotEqual(self.context(self.prompt("run /alphaskill")), "")

    def test_a_prompt_naming_two_hidden_skills_gets_one_line_for_each(self):
        self.add_skill(self.project, "alphaskill")
        self.add_skill(self.project, "betaskill")
        lines = self.context(self.prompt("run /betaskill, then /alphaskill")).splitlines()
        self.assertEqual([line.split(" ")[0] for line in lines], ["/alphaskill", "/betaskill"])

    def test_project_settings_hide_a_skill_and_override_the_user_setting(self):
        self.add_skill(self.project, "alphaskill")
        self.add_skill(self.project, "deltaskill")
        with open(os.path.join(self.project, ".claude", "settings.local.json"), "w") as handle:
            json.dump({"skillOverrides": {"alphaskill": "on", "deltaskill": "name-only"}}, handle)
        context = self.context(self.prompt("run /alphaskill and /deltaskill"))
        self.assertNotIn("/alphaskill", context)
        self.assertIn("/deltaskill is", context)

    def test_a_broken_settings_file_prints_nothing_and_exits_cleanly(self):
        self.add_skill(self.project, "alphaskill")
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as handle:
            handle.write("{ not json")
        result = self.prompt("run /alphaskill")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        result = subprocess.run([sys.executable, HOOK], input="not json", capture_output=True, text=True, env=self.environment)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_settings_with_no_hidden_skill_do_no_other_work(self):
        self.write_user_overrides({"gammaskill": "off"})
        self.environment["PATH"] = ""
        result = self.prompt("run /gammaskill")
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertFalse(os.path.exists(self.environment["XDG_CACHE_HOME"]))


if __name__ == "__main__":
    unittest.main()
