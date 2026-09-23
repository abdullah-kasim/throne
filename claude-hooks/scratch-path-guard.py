import json
import os
import re
import sys

REMOVAL_COMMAND = re.compile(r"(?:^|[;&|(){}\s])(?:sudo\s+)?(?:rm|rmdir)(?=\s)")
TILDE_PATH = re.compile(r"(?:^|[\s=\"'(:])~(?=/|\s|$|[\"');])")
HOME_VARIABLE = re.compile(r"\$HOME\b|\$\{HOME\}")

GUIDANCE = (
    "This command removes files and spells the home directory as {spelling}. Claude Code stops every "
    "such removal for a human approval, even with permissions bypassed, because it cannot resolve "
    "the path and treats it as a possible removal of the home directory; an unattended session "
    "stalls there. Rewrite the command with the literal home path {home} wherever {spelling} "
    "appears, assign no variable from it, and run it again."
)

SHARED_TMP_GUIDANCE = (
    "This command writes, moves or removes {path}, under the shared /tmp. Scratch files belong in "
    "{scratch} (create it with mkdir -p {scratch}), spelled as that literal path, never with ~ or $HOME. "
    "Claude Code prompts for removals at the filesystem root or of a critical path even with "
    "permissions bypassed, and an unattended pane stalls on that prompt; {scratch} also survives a "
    "reboot and has no per-user tmpfs quota. This includes the harness scratchpad under "
    "/private/tmp/claude-<uid>/ that the system prompt advertises: it sits on the same tmpfs, and the "
    "standing rule is {scratch}. Rewrite the command to use {scratch} and run it again."
)

ROOT_PATH_GUIDANCE = (
    "This command writes, moves or removes {path}, a file directly at the filesystem root, which is "
    "almost always a mistyped scratch path. Claude Code prompts for any removal at the filesystem "
    "root even with permissions bypassed, and an unattended pane stalls on that prompt. Put scratch "
    "files in {scratch} (create it with mkdir -p {scratch}), spelled as that literal path, never with "
    "~ or $HOME; it also survives a reboot and has no per-user tmpfs quota. Rewrite the command to "
    "use {scratch} and run it again."
)


HEREDOC_BODY = re.compile(r"<<-?\s*(['\"]?)(\w+)\1.*?\n.*?^\s*\2\s*$", re.DOTALL | re.MULTILINE)
HEREDOC_BODY_AFTER_OPENING_LINE = re.compile(
    r"(<<-?\s*(['\"]?)(\w+)\2[^\n]*\n).*?^\s*\3\s*$", re.DOTALL | re.MULTILINE
)
SINGLE_QUOTED = re.compile(r"'[^']*'")


def without_inert_text(command: str) -> str:
    return SINGLE_QUOTED.sub("''", HEREDOC_BODY.sub("", command))


def home_spelling_in(command: str):
    command = without_inert_text(command)
    if not REMOVAL_COMMAND.search(command):
        return None
    if TILDE_PATH.search(command):
        return "~"
    if HOME_VARIABLE.search(command):
        return "$HOME"
    return None


SHARED_TMP_PATH = re.compile(r"^(?:/private)?/tmp(?:/.*)?$")
ROOT_LEVEL_PATH = re.compile(r"^/[^/\s]+$")
REDIRECTION_TARGET = re.compile(r"(?:^|[^<>])>>?\|?\s*([^\s;&|<>()]+)")
COMMAND_SEPARATOR = re.compile(r"&&|\|\||[;\n()|]|(?<![<>&0-9])&(?![>&])")
ASSIGNMENT = re.compile(r"^\w+=")
COMMAND_PREFIXES = {"sudo", "env", "command", "nohup", "time", "exec"}
COMMANDS_WRITING_EVERY_OPERAND = {"touch", "mkdir", "rm", "rmdir", "mv", "mktemp", "tee", "truncate"}
COMMANDS_WRITING_THE_LAST_OPERAND = {"cp", "install", "ln", "rsync"}


def written_paths_in(command: str):
    command = SINGLE_QUOTED.sub("''", HEREDOC_BODY_AFTER_OPENING_LINE.sub(r"\1", command))
    paths = [target.strip('"') for target in REDIRECTION_TARGET.findall(command)]
    for segment in COMMAND_SEPARATOR.split(command):
        words = [word.strip('"') for word in segment.split()]
        while words and (words[0] in COMMAND_PREFIXES or ASSIGNMENT.match(words[0])):
            words = words[1:]
        if not words:
            continue
        name = os.path.basename(words[0])
        operands = [word.split("=", 1)[1] if word.startswith("--") and "=" in word else word for word in words[1:]]
        if name in COMMANDS_WRITING_EVERY_OPERAND:
            paths.extend(operands)
        elif name in COMMANDS_WRITING_THE_LAST_OPERAND:
            non_options = [operand for operand in operands if not operand.startswith("-")]
            paths.extend(non_options[-1:])
    return paths


def scratch_path_refusal(command: str):
    for path in written_paths_in(command):
        if SHARED_TMP_PATH.match(path):
            return SHARED_TMP_GUIDANCE, path
        if ROOT_LEVEL_PATH.match(path):
            return ROOT_PATH_GUIDANCE, path
    return None


def refusal_reason(command: str):
    scratch = os.path.expanduser("~/tmp")
    spelling = home_spelling_in(command)
    if spelling is not None:
        return GUIDANCE.format(spelling=spelling, home=os.path.expanduser("~"))
    refusal = scratch_path_refusal(command)
    if refusal is not None:
        guidance, path = refusal
        return guidance.format(path=path, scratch=scratch)
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        command = (payload.get("tool_input") or {}).get("command") or ""
    except (ValueError, AttributeError):
        return 0
    if not isinstance(command, str):
        return 0
    reason = refusal_reason(command)
    if reason is None:
        return 0
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
