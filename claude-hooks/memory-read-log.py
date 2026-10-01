import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone

MEMORY_READ_LOG_FILE_NAME = "memory-reads.jsonl"
MEMORY_READ_FAILURES_FILE_NAME = "memory-reads.failures.jsonl"
MEMORY_VERSIONS_DIRECTORY_NAME = "memory-versions"
MOST_MEMORY_FILES_PER_LINE = 20
HERDR_PANE_VARIABLE = "HERDR_PANE_ID"
HERDR_AGENT_LIST_COMMAND = ["herdr", "agent", "list"]
HERDR_LOOKUP_SECONDS = 1

READ_COMMANDS = {"cat": "read", "head": "read", "tail": "read", "sed": "read", "less": "read"}
SEARCH_COMMANDS = {"grep": "search", "rg": "search", "find": "search"}
FILE_FINDING_COMMANDS = {"find"}
LIST_COMMANDS = {"ls": "list"}
KIND_OF_COMMAND = {**READ_COMMANDS, **SEARCH_COMMANDS, **LIST_COMMANDS}
RECALL_SUBCOMMANDS = {"recall", "rank", "sift"}
RECALL_SUBCOMMAND = "recall"
ASK_LINT_FLAG = "--lint-asks"
THRONE_COMMAND_NAMES = {"throne", "throne-cli"}
COMMAND_SEPARATOR_CHARACTERS = set("|&;()")
SEARCH_OPTIONS_TAKING_A_VALUE = {"-A", "-B", "-C", "-m", "-f", "--max-count", "--glob", "-g", "-t", "--type"}
SEARCH_PATTERN_OPTIONS = {"-e", "--regexp"}
GLOB_CHARACTERS = re.compile(r"[*?\[{]")
PATH_IN_TEXT = re.compile(r"(?:~|/)[^\s:'\"`,;()]+")
AGENT_MEMORY_DIRECTORY = re.compile(r"/agent_docs/MEMORY(?:/|$)")
VARIABLE_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def home_directory():
    return os.path.expanduser("~")


def recall_data_directory():
    return os.path.join(home_directory(), ".throne", "data", "recall")


def now_as_iso_text():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def absolute_path(path, cwd):
    expanded = os.path.expanduser(os.path.expandvars(path))
    if not os.path.isabs(expanded):
        expanded = os.path.join(cwd or os.getcwd(), expanded)
    return os.path.normpath(expanded)


def fixed_memory_directories():
    home = home_directory()
    return [os.path.join(home, ".memories"), os.path.join(home, ".throne", "memories")]


def is_same_or_inside(path, directory):
    return path == directory or path.startswith(directory.rstrip("/") + "/")


def is_claude_project_memory(path):
    projects = os.path.join(home_directory(), ".claude", "projects") + "/"
    if not path.startswith(projects):
        return False
    parts = path[len(projects):].split("/")
    return len(parts) >= 2 and parts[1] == "memory"


def is_memory_path(path, configured_directories):
    if AGENT_MEMORY_DIRECTORY.search(path) or is_claude_project_memory(path):
        return True
    directories = fixed_memory_directories() + configured_directories
    return any(is_same_or_inside(path, directory) for directory in directories)


def memory_paths_among(paths, cwd, configured_directories):
    found = []
    for path in paths:
        candidate = absolute_path(path, cwd)
        if is_memory_path(candidate, configured_directories) and candidate not in found:
            found.append(candidate)
    return found


def paths_named_in_text(text):
    named = PATH_IN_TEXT.findall(text)
    for line in text.splitlines():
        before_colon = line.split(":", 1)[0].strip()
        if before_colon and not before_colon.startswith(("~", "/")) and " " not in before_colon:
            named.append(before_colon)
    return named


def existing_files(paths):
    return [path for path in paths if os.path.isfile(path)]


def memory_files_named_in_text(text, cwd, configured_directories):
    return existing_files(memory_paths_among(paths_named_in_text(text), cwd, configured_directories))


def response_text(tool_response):
    if isinstance(tool_response, str):
        return tool_response
    if not isinstance(tool_response, dict):
        return ""
    file_part = tool_response.get("file")
    if isinstance(file_part, dict) and isinstance(file_part.get("content"), str):
        return file_part["content"]
    pieces = []
    for key in ("stdout", "content"):
        if isinstance(tool_response.get(key), str):
            pieces.append(tool_response[key])
    filenames = tool_response.get("filenames")
    if isinstance(filenames, list):
        pieces.extend(name for name in filenames if isinstance(name, str))
    return "\n".join(pieces)


def memory_files_a_search_found(named_in_output, searched_files, returned_something):
    if named_in_output or not returned_something:
        return named_in_output
    return searched_files


def response_is_empty(tool_response):
    if isinstance(tool_response, dict) and tool_response.get("numMatches"):
        return False
    return response_text(tool_response).strip() == ""


def glob_directory(pattern, search_path, cwd):
    base = search_path or cwd
    fixed_part = GLOB_CHARACTERS.split(pattern, 1)[0]
    directory = fixed_part if fixed_part.endswith("/") else os.path.dirname(fixed_part)
    return absolute_path(os.path.join(base, directory) if base else directory, cwd)


def read_tool_record(tool_input, tool_response, cwd, configured_directories):
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str):
        return None
    memory_files = memory_paths_among([file_path], cwd, configured_directories)
    if not memory_files:
        return None
    return {
        "kind": "read",
        "target": memory_files[0],
        "memoryFiles": memory_files,
        "returnedSomething": not response_is_empty(tool_response),
        "readInFull": tool_input.get("offset") is None and tool_input.get("limit") is None,
    }


def grep_tool_record(tool_input, tool_response, cwd, configured_directories):
    search_path = absolute_path(tool_input.get("path") or cwd or os.getcwd(), cwd)
    if not is_memory_path(search_path, configured_directories):
        return None
    returned_something = not response_is_empty(tool_response)
    return {
        "kind": "search",
        "target": str(tool_input.get("pattern") or ""),
        "memoryFiles": memory_files_a_search_found(
            memory_files_named_in_text(response_text(tool_response), cwd, configured_directories),
            existing_files([search_path]),
            returned_something,
        ),
        "returnedSomething": returned_something,
        "readInFull": False,
    }


def glob_tool_record(tool_input, tool_response, cwd, configured_directories):
    pattern = str(tool_input.get("pattern") or "")
    if not is_memory_path(glob_directory(pattern, tool_input.get("path"), cwd), configured_directories):
        return None
    return {
        "kind": "list",
        "target": pattern,
        "memoryFiles": memory_files_named_in_text(response_text(tool_response), cwd, configured_directories),
        "returnedSomething": not response_is_empty(tool_response),
        "readInFull": False,
    }


def command_tokens(command):
    lexer = shlex.shlex(command.replace("\n", " ; "), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return command.split()


def command_segments(command):
    segments = [[]]
    for token in command_tokens(command):
        if token and set(token) <= COMMAND_SEPARATOR_CHARACTERS:
            segments.append([])
        else:
            segments[-1].append(token)
    return [segment for segment in segments if segment]


def words_after_assignments(segment):
    index = 0
    while index < len(segment) and VARIABLE_ASSIGNMENT.match(segment[index]):
        index += 1
    return segment[index:]


def is_recall_command(words):
    return (
        len(words) >= 2
        and os.path.basename(words[0]) in THRONE_COMMAND_NAMES
        and words[1] in RECALL_SUBCOMMANDS
    )


def is_ask_lint(words):
    return is_recall_command(words) and words[1] == RECALL_SUBCOMMAND and ASK_LINT_FLAG in words[2:]


def search_term(arguments):
    skip_next = False
    for index, argument in enumerate(arguments):
        if skip_next:
            skip_next = False
            continue
        if argument in SEARCH_PATTERN_OPTIONS and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument in SEARCH_OPTIONS_TAKING_A_VALUE:
            skip_next = True
            continue
        if not argument.startswith("-"):
            return argument
    return ""


def recall_arguments_of(words):
    return {"recallArguments": words[2:]} if words[1] == RECALL_SUBCOMMAND else {}


def bash_segment_record(words, command, tool_response, cwd, configured_directories):
    if is_ask_lint(words):
        return None
    if is_recall_command(words):
        return {
            "kind": "recall-command",
            "target": command,
            "memoryFiles": memory_files_named_in_text(response_text(tool_response), cwd, configured_directories),
            "returnedSomething": not response_is_empty(tool_response),
            "readInFull": False,
            **recall_arguments_of(words),
        }
    command_name = os.path.basename(words[0])
    kind = KIND_OF_COMMAND.get(command_name)
    if kind is None:
        return None
    arguments = words[1:]
    memory_paths = memory_paths_among(
        [argument for argument in arguments if not argument.startswith("-")], cwd, configured_directories
    )
    if not memory_paths:
        return None
    returned_something = not response_is_empty(tool_response)
    named_in_output = memory_files_named_in_text(response_text(tool_response), cwd, configured_directories)
    memory_files = existing_files(memory_paths)
    if kind == "search":
        memory_files = memory_files_a_search_found(named_in_output, memory_files, returned_something)
    elif kind == "list":
        memory_files += [path for path in named_in_output if path not in memory_files]
    search_target = command if command_name in FILE_FINDING_COMMANDS else search_term(arguments)
    targets = {"read": (memory_files or memory_paths)[0], "search": search_target, "list": command}
    return {
        "kind": kind,
        "target": targets[kind],
        "memoryFiles": memory_files,
        "returnedSomething": returned_something,
        "readInFull": command_name == "cat",
    }


def bash_tool_record(tool_input, tool_response, cwd, configured_directories):
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    for segment in command_segments(command):
        words = words_after_assignments(segment)
        if not words:
            continue
        record = bash_segment_record(words, command, tool_response, cwd, configured_directories)
        if record is not None:
            return record
    return None


RECORD_OF_TOOL = {
    "Read": read_tool_record,
    "Grep": grep_tool_record,
    "Glob": glob_tool_record,
    "Bash": bash_tool_record,
}


def agent_name_of(cwd):
    if not cwd:
        return None
    worktrees = os.path.join(home_directory(), ".throne", "worktrees") + "/"
    if not cwd.startswith(worktrees):
        return None
    parts = cwd[len(worktrees):].split("/")
    if len(parts) < 2 or not parts[1]:
        return None
    identity = os.path.join(home_directory(), ".throne", "data", parts[1], "identity.md")
    return parts[1] if os.path.isfile(identity) else None


def herdr_pane_id():
    return os.environ.get(HERDR_PANE_VARIABLE) or None


def agent_name_of_herdr_pane(pane_id):
    if pane_id is None:
        return None
    try:
        listing = subprocess.run(
            HERDR_AGENT_LIST_COMMAND, capture_output=True, text=True, timeout=HERDR_LOOKUP_SECONDS, check=False
        )
        agents = json.loads(listing.stdout)["result"]["agents"]
    except Exception:
        return None
    return next((agent.get("name") for agent in agents if agent.get("pane_id") == pane_id), None)


def memory_read_from_tool_call(payload, configured_directories):
    tool = payload.get("tool_name")
    record_of_tool = RECORD_OF_TOOL.get(tool)
    if record_of_tool is None:
        return None
    tool_input = payload.get("tool_input")
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else None
    record = record_of_tool(
        tool_input if isinstance(tool_input, dict) else {},
        payload.get("tool_response"),
        cwd,
        configured_directories,
    )
    if record is None:
        return None
    pane_id = herdr_pane_id()
    return {
        "at": now_as_iso_text(),
        "sessionId": payload.get("session_id"),
        "agentName": agent_name_of(cwd) or agent_name_of_herdr_pane(pane_id),
        "herdrPaneId": pane_id,
        "tool": tool,
        "kind": record["kind"],
        "target": record["target"],
        "memoryFiles": record["memoryFiles"][:MOST_MEMORY_FILES_PER_LINE],
        "returnedSomething": record["returnedSomething"],
        "readInFull": record["readInFull"],
        "transcriptPath": payload.get("transcript_path"),
        "cwd": cwd,
        **({"recallArguments": record["recallArguments"]} if "recallArguments" in record else {}),
    }


def memory_file_contents(memory_files):
    contents = {}
    for path in existing_files(memory_files):
        with open(path, "rb") as handle:
            contents[path] = handle.read()
    return contents


def content_hash(content):
    return hashlib.sha256(content).hexdigest()


def keep_memory_version(content):
    directory = os.path.join(recall_data_directory(), MEMORY_VERSIONS_DIRECTORY_NAME)
    version_path = os.path.join(directory, content_hash(content))
    if os.path.exists(version_path):
        return
    os.makedirs(directory, exist_ok=True)
    with open(version_path, "wb") as handle:
        handle.write(content)


def append_line(file_name, record):
    directory = recall_data_directory()
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, file_name), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def record_failure(error):
    try:
        append_line(MEMORY_READ_FAILURES_FILE_NAME, {"at": now_as_iso_text(), "error": str(error)[:200]})
    except Exception:
        pass


def main():
    try:
        configured_directories = [absolute_path(directory, None) for directory in sys.argv[1:]]
        payload = json.load(sys.stdin)
        record = memory_read_from_tool_call(payload, configured_directories)
        if record is not None:
            contents = memory_file_contents(record["memoryFiles"])
            for content in contents.values():
                keep_memory_version(content)
            record["memoryFileHashes"] = {path: content_hash(content) for path, content in contents.items()}
            append_line(MEMORY_READ_LOG_FILE_NAME, record)
    except Exception as error:
        record_failure(error)
    return 0


if __name__ == "__main__":
    sys.exit(main())
