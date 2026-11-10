import json
import os
import re
import subprocess
import sys

HIDDEN_OVERRIDE_VALUES = {"user-invocable-only", "name-only"}
PROJECT_SETTINGS_FILES = [
    os.path.join(".claude", "settings.json"),
    os.path.join(".claude", "settings.local.json"),
]
SKILL_FOLDER_FILE = re.compile(r"(?:^|/)skills/[^/]+/[^/]+\.md$")
INSTRUCTION_FILE_NAMES = {"CLAUDE.md", "AGENTS.md"}
AGENT_DOCS_FILE = re.compile(r"(?:^|/)agent_docs/.+\.md$")
OWN_SKILL_FILE = re.compile(r"(?:^|/)skills/([^/]+)/SKILL\.md$")
NAME_CHARACTER = r"[A-Za-z0-9_:/-]"
PATH_OR_WORD_CHARACTER = r"[A-Za-z0-9_./~-]"
GIT_SECONDS = 2


def home_directory():
    return os.path.expanduser("~")


def read_json_object(path):
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def hidden_skill_names(cwd):
    overrides = {}
    settings_files = [os.path.join(home_directory(), ".claude", "settings.json")]
    settings_files += [os.path.join(cwd, relative) for relative in PROJECT_SETTINGS_FILES]
    for path in settings_files:
        skill_overrides = read_json_object(path).get("skillOverrides")
        if isinstance(skill_overrides, dict):
            overrides.update(skill_overrides)
    return {name for name, value in overrides.items() if value in HIDDEN_OVERRIDE_VALUES}


def names_mentioned(text, names):
    found = []
    for name in sorted(names):
        pattern = r"(?<!{before})/{name}(?!{after})".format(
            before=PATH_OR_WORD_CHARACTER, name=re.escape(name), after=NAME_CHARACTER
        )
        if re.search(pattern, text):
            found.append(name)
    return found


def main_checkout(cwd):
    try:
        toplevel = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=GIT_SECONDS,
        ).stdout.strip()
        listing = subprocess.run(
            ["git", "-C", cwd, "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=GIT_SECONDS,
        ).stdout
    except Exception:
        return None
    first_line = listing.splitlines()[0] if listing else ""
    if not first_line.startswith("worktree "):
        return None
    checkout = first_line[len("worktree "):]
    if not toplevel or os.path.realpath(checkout) == os.path.realpath(toplevel):
        return None
    return checkout


def skill_file(name, cwd):
    folders = [cwd]
    checkout = main_checkout(cwd)
    if checkout:
        folders.append(checkout)
    candidates = [os.path.join(folder, ".claude", "skills", name, "SKILL.md") for folder in folders]
    candidates.append(os.path.join(home_directory(), ".claude", "skills", name, "SKILL.md"))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def throne_data_home():
    return os.environ.get("THRONE_DATA_HOME") or os.path.join(home_directory(), ".throne")


def is_inside(path, folder):
    folder = os.path.abspath(folder)
    return os.path.abspath(path).startswith(folder + os.sep)


def is_pointer_worthy_file(path):
    if not path.endswith(".md"):
        return False
    if SKILL_FOLDER_FILE.search(path) or AGENT_DOCS_FILE.search(path):
        return True
    if os.path.basename(path) in INSTRUCTION_FILE_NAMES:
        return True
    return is_inside(path, throne_data_home())


def read_file_text(payload):
    response = payload.get("tool_response") or {}
    file_details = response.get("file") if isinstance(response, dict) else None
    if isinstance(file_details, dict) and isinstance(file_details.get("content"), str):
        return file_details["content"]
    return ""


def text_to_scan(payload):
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        return payload.get("prompt") or "", None
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}
    if event == "PreToolUse" and tool_name == "Skill":
        return "/" + str(tool_input.get("skill") or ""), None
    if event == "PostToolUse" and tool_name == "Read":
        path = tool_input.get("file_path") or ""
        if not isinstance(path, str) or not is_pointer_worthy_file(path):
            return "", None
        own_skill = OWN_SKILL_FILE.search(path)
        return read_file_text(payload), own_skill.group(1) if own_skill else None
    return "", None


def pointer_line(name, path):
    return "/{name} is a skill hidden from your listing. Its file is {path}. Read it and follow it.".format(
        name=name, path=path
    )


def session_record_path(session_id):
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(home_directory(), ".cache")
    safe_session = re.sub(r"[^A-Za-z0-9_-]", "_", session_id)
    return os.path.join(cache, "throne", "hidden-skill-pointer", safe_session)


def already_pointed(record_path):
    try:
        with open(record_path, encoding="utf-8") as handle:
            return set(handle.read().split())
    except OSError:
        return set()


def remember_pointed(record_path, names):
    os.makedirs(os.path.dirname(record_path), exist_ok=True)
    with open(record_path, "a", encoding="utf-8") as handle:
        handle.write("".join(name + "\n" for name in names))


def pointer_lines(payload, hidden_names):
    cwd = payload.get("cwd") or os.getcwd()
    text, own_skill = text_to_scan(payload)
    record_path = session_record_path(str(payload.get("session_id") or "no-session"))
    pointed = already_pointed(record_path)
    lines = []
    newly_pointed = []
    for name in names_mentioned(text, hidden_names):
        if name == own_skill or name in pointed:
            continue
        path = skill_file(name, cwd)
        if path is None:
            continue
        lines.append(pointer_line(name, path))
        newly_pointed.append(name)
    if newly_pointed:
        remember_pointed(record_path, newly_pointed)
    return lines


def main():
    try:
        payload = json.load(sys.stdin)
        hidden_names = hidden_skill_names(payload.get("cwd") or os.getcwd())
        if not hidden_names:
            return 0
        lines = pointer_lines(payload, hidden_names)
        if not lines:
            return 0
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": payload.get("hook_event_name"),
                    "additionalContext": "\n".join(lines),
                }
            },
            sys.stdout,
        )
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
