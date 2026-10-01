import json
import os
import re
import shlex
import sys

KEY_FILE_NAME = re.compile(r"^\.jev-key")
JEV_SDK_IMPORT = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)[\"'`][^\"'`\s]*@typesafe-ai/sdk[^\"'`\s]*[\"'`]"
)
JEV_BACKEND_SOURCE = os.path.join("src", "relevance-classifier", "jev-backend.ts")
JEV_LIMIT_FIELDS = ("jevTokensPerDay", "jevTokensPerHour")
CONFIGURED_KEY_FILE = re.compile(r"\bjevKeyFile\s*:\s*[\"']([^\"']+)[\"']")
USER_CONFIG_FILE_NAME = "config.user.ts"
SCRIPT_EXTENSIONS = (".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx")
CODE_FILE_EXTENSIONS = SCRIPT_EXTENSIONS + (".py", ".sh", ".rb", ".pl")
LIMITED_COMMANDS = {"recall", "rank", "sift", "jev-probe"}
COMPILED_ENTRYPOINT = os.path.join("dist", "src", "tools.js")
COMPILED_JEV_BACKEND = os.path.join("dist", "src", "relevance-classifier", "jev-backend.js")
LIMITER_IMPORT = re.compile(r"from\s*[\"']\./jev-budget\.js[\"']")
THRONE_CLI = os.path.join("bin", "throne-cli")

JAVASCRIPT_RUNNERS = {"node", "nodejs", "tsx", "ts-node", "bun", "deno", "npx"}
CODE_RUNNERS = JAVASCRIPT_RUNNERS | {"python", "python3", "ruby", "perl", "bash", "sh", "zsh", "osascript"}
INLINE_CODE_FLAGS = {"-e", "--eval", "-p", "--print", "-c"}
SEARCH_COMMANDS = {"grep", "egrep", "fgrep", "rg", "ag", "ack"}
IN_PLACE_EDITORS = {"sed", "gsed", "perl"}
COMMANDS_WRITING_THE_LAST_OPERAND = {"cp", "mv", "install", "ln", "rsync"}
COMMAND_PREFIXES = {"sudo", "env", "command", "nohup", "time", "exec", "xargs"}
ASSIGNMENT = re.compile(r"^\w+=")
IN_PLACE_FLAG = re.compile(r"^(?:-[A-Za-z]*i|--in-place)")
COMMAND_SEPARATOR = re.compile(r"&&|\|\||[;\n|]|(?<![<>&0-9])&(?![>&])")
REDIRECTION_TARGET = re.compile(r"(?:^|[^<>])>>?\|?\s*([^\s;&|<>()]+)")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)^\s*\2\s*$", re.DOTALL | re.MULTILINE)

KEY_FILE_RULE = "reading, copying or linking a Jev key file"
SDK_IMPORT_RULE = "importing @typesafe-ai/sdk outside throne's own src/relevance-classifier/jev-backend.ts"
LIMIT_EDIT_RULE = "editing jevTokensPerDay or jevTokensPerHour in a config.user.ts"
UNLIMITED_BUILD_RULE = "running a throne build whose Jev backend has no Jev limiter"

REFUSAL = (
    "jev-fence refused this call: {rule}. Jev is reached only through throne recall, throne rank or "
    "throne sift, which spend from the machine's Jev budget; the Jev limits change only on the Lord's "
    "order through /modify-config; to test a Jev question, use throne jev-probe. There is no bypass "
    "for this fence. A task that needs more Jev than the budget allows stops and says so: ask your "
    "supervisor."
)


def account_home():
    return os.path.expanduser("~")


def with_home_expanded(path):
    home = account_home()
    for spelling in ("${HOME}", "$HOME"):
        if path == spelling or path.startswith(spelling + "/"):
            return home + path[len(spelling):]
    return os.path.expanduser(path)


def configured_key_file(user_config_path):
    try:
        with open(user_config_path, encoding="utf-8") as handle:
            match = CONFIGURED_KEY_FILE.search(handle.read())
    except OSError:
        return None
    return os.path.normpath(with_home_expanded(match.group(1))) if match else None


def live_user_config_path():
    throne_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(throne_root, USER_CONFIG_FILE_NAME)


def is_key_file(path, configured_key):
    expanded = os.path.normpath(with_home_expanded(path.strip("\"'")))
    if KEY_FILE_NAME.match(os.path.basename(expanded)):
        return True
    return configured_key is not None and expanded == configured_key


def mentions_key_file(text, configured_key):
    if ".jev-key" in text:
        return True
    return configured_key is not None and os.path.basename(configured_key) in text


def imports_jev_sdk(text):
    return bool(JEV_SDK_IMPORT.search(text))


def is_jev_backend_source(path):
    return os.path.normpath(path).endswith(os.sep + JEV_BACKEND_SOURCE)


def is_script_file(path):
    return path.endswith(SCRIPT_EXTENSIONS)


def is_user_config(path):
    return os.path.basename(path.strip("\"'")) == USER_CONFIG_FILE_NAME


def limit_lines(text):
    return [line.strip() for line in text.splitlines() if any(field in line for field in JEV_LIMIT_FIELDS)]


def mentions_limit_field(text):
    return any(field in text for field in JEV_LIMIT_FIELDS)


def changes_limit_lines(old_text, new_text):
    return limit_lines(old_text) != limit_lines(new_text)


def file_text(path):
    try:
        with open(path, encoding="utf-8", errors="ignore") as handle:
            return handle.read()
    except OSError:
        return ""


def compiled_backend_has_limiter(throne_root):
    return bool(LIMITER_IMPORT.search(file_text(os.path.join(throne_root, COMPILED_JEV_BACKEND))))


def written_text_by_tool(tool_name, tool_input):
    if tool_name == "Write":
        return [("", tool_input.get("content") or "")]
    if tool_name == "Edit":
        return [(tool_input.get("old_string") or "", tool_input.get("new_string") or "")]
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits") or []
        return [(edit.get("old_string") or "", edit.get("new_string") or "") for edit in edits if isinstance(edit, dict)]
    return []


def file_tool_refusal(tool_name, tool_input, configured_key):
    path = tool_input.get("file_path") or tool_input.get("path") or ""
    if not isinstance(path, str):
        return None
    if path and is_key_file(path, configured_key):
        return KEY_FILE_RULE
    replacements = written_text_by_tool(tool_name, tool_input)
    if is_script_file(path) and not is_jev_backend_source(path):
        if any(imports_jev_sdk(new_text) for _, new_text in replacements):
            return SDK_IMPORT_RULE
    if is_user_config(path):
        if tool_name == "Write":
            replacements = [(file_text(path), new_text) for _, new_text in replacements]
        if any(changes_limit_lines(old_text, new_text) for old_text, new_text in replacements):
            return LIMIT_EDIT_RULE
    return None


def heredoc_bodies(command):
    return [match.group(3) for match in HEREDOC.finditer(command)]


def without_heredoc_bodies(command):
    return HEREDOC.sub(lambda match: match.group(0).split("\n", 1)[0], command)


def shell_words(segment):
    try:
        return shlex.split(segment)
    except ValueError:
        return [word.strip("\"'") for word in segment.split()]


def simple_commands(command):
    commands = []
    for segment in COMMAND_SEPARATOR.split(without_heredoc_bodies(command)):
        words = shell_words(segment.strip().strip("()"))
        while words and (words[0] in COMMAND_PREFIXES or ASSIGNMENT.match(words[0])):
            words = words[1:]
        if words:
            commands.append(words)
    return commands


def program_name(words):
    return os.path.basename(words[0])


def search_pattern_index(words):
    if program_name(words) not in SEARCH_COMMANDS and words[:2] != ["git", "grep"]:
        return None
    start = 2 if words[0] == "git" else 1
    for index in range(start, len(words)):
        if not words[index].startswith("-"):
            return index
    return None


def inline_code(words):
    if program_name(words) not in CODE_RUNNERS:
        return []
    return [words[index + 1] for index in range(1, len(words) - 1) if words[index] in INLINE_CODE_FLAGS]


def runs_code(words):
    return program_name(words) in CODE_RUNNERS


def runs_or_writes_code(command):
    if any(runs_code(words) for words in simple_commands(command)):
        return True
    return any(path.endswith(CODE_FILE_EXTENSIONS) for path in written_paths(command))


def code_in_command(command):
    code = heredoc_bodies(command) if runs_or_writes_code(command) else []
    for words in simple_commands(command):
        code.extend(inline_code(words))
    return code


def written_paths(command):
    paths = [target.strip("\"'") for target in REDIRECTION_TARGET.findall(without_heredoc_bodies(command))]
    for words in simple_commands(command):
        name = program_name(words)
        operands = [word for word in words[1:] if not word.startswith("-")]
        if name == "tee":
            paths.extend(operands)
        elif name in COMMANDS_WRITING_THE_LAST_OPERAND:
            paths.extend(operands[-1:])
        elif name in IN_PLACE_EDITORS and any(IN_PLACE_FLAG.match(word) for word in words[1:]):
            paths.extend(operands)
    return paths


def is_single_path(word):
    return not any(character.isspace() for character in word)


def opens_key_file(command, configured_key):
    for words in simple_commands(command):
        pattern_index = search_pattern_index(words)
        for index, word in enumerate(words):
            if index != pattern_index and is_single_path(word) and is_key_file(word, configured_key):
                return True
    return any(mentions_key_file(code, configured_key) for code in code_in_command(command))


def runs_jev_sdk_import(command):
    if any(imports_jev_sdk(code) for code in code_in_command(command)):
        return True
    return imports_jev_sdk(without_heredoc_bodies(command)) and runs_or_writes_code(command)


def writes_limit_field(command):
    if not mentions_limit_field(command):
        return False
    if any(is_user_config(path) for path in written_paths(command)):
        return True
    return any(USER_CONFIG_FILE_NAME in code for code in code_in_command(command))


def launched_throne_root(words, working_directory):
    name = program_name(words)
    if name in ("node", "nodejs"):
        scripts = [word for word in words[1:] if not word.startswith("-")]
        if scripts and scripts[0].endswith(COMPILED_ENTRYPOINT) and len(scripts) > 1:
            entrypoint = os.path.join(working_directory, with_home_expanded(scripts[0]))
            return os.path.dirname(os.path.dirname(os.path.dirname(entrypoint))), scripts[1]
    if words[0].endswith(THRONE_CLI) and len(words) > 1:
        launcher = os.path.join(working_directory, with_home_expanded(words[0]))
        return os.path.dirname(os.path.dirname(launcher)), words[1]
    return None


def runs_unlimited_build(command, working_directory):
    for words in simple_commands(command):
        launched = launched_throne_root(words, working_directory)
        if launched is None:
            continue
        throne_root, subcommand = launched
        if subcommand in LIMITED_COMMANDS and not compiled_backend_has_limiter(throne_root):
            return True
    return False


def bash_refusal(command, working_directory, configured_key):
    if opens_key_file(command, configured_key):
        return KEY_FILE_RULE
    if runs_jev_sdk_import(command):
        return SDK_IMPORT_RULE
    if writes_limit_field(command):
        return LIMIT_EDIT_RULE
    if runs_unlimited_build(command, working_directory):
        return UNLIMITED_BUILD_RULE
    return None


def refused_rule(payload, configured_key):
    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return None
    if tool_name == "Bash":
        command = tool_input.get("command") or ""
        if not isinstance(command, str):
            return None
        return bash_refusal(command, payload.get("cwd") or os.getcwd(), configured_key)
    return file_tool_refusal(tool_name, tool_input, configured_key)


def refusal_decision(rule):
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REFUSAL.format(rule=rule),
        }
    }


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    rule = refused_rule(payload, configured_key_file(live_user_config_path()))
    if rule is not None:
        json.dump(refusal_decision(rule), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
