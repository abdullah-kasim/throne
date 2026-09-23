import json
import os
import re
import subprocess
import sys

SKILL_FILE_PATH = re.compile(r"(?:^|/)\.(?:claude|agents)/skills/[^/]+/SKILL\.md$")
VERIFY_LINE = re.compile(r"^#\s*verify:\s*(.+)$")
IDENTIFIER_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{2,}")
HOME_DIRECTORY_PATH = re.compile(r"/(?:Users|home)/([^/\s\"']+)")

RUN_SKILL_WRITER_REMINDER = "skill-write-guard: this write touches a skill file. Run /skill-writer for it."
REMOVED_TERM_REMINDER = "add the term you removed to publish-scrub.sed / private-refs.txt"


def is_skill_file(path):
    return bool(SKILL_FILE_PATH.search(path))


def private_refs_path():
    return os.environ.get("THRONE_PRIVATE_REFS") or os.path.expanduser("~/.config/throne/private-refs.txt")


def load_line_patterns(path):
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return []
    patterns = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            patterns.append(re.compile(line))
        except re.error:
            continue
    return patterns


def find_publish_scrub_sed(file_path):
    directory = os.path.dirname(os.path.abspath(file_path))
    while True:
        candidate = os.path.join(directory, "publish-scrub.sed")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def load_verify_patterns(publish_scrub_sed_path):
    if publish_scrub_sed_path is None:
        return []
    try:
        with open(publish_scrub_sed_path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return []
    patterns = []
    for line in lines:
        match = VERIFY_LINE.match(line.strip())
        if not match:
            continue
        try:
            patterns.append(re.compile(match.group(1)))
        except re.error:
            continue
    return patterns


def banned_pattern_hits(content, patterns):
    lines = content.splitlines()
    hits = []
    for pattern in patterns:
        for number, line in enumerate(lines, start=1):
            if pattern.search(line):
                hits.append((number, line.strip()[:200], pattern.pattern))
                break
    return hits


def foreign_home_path_hits(content):
    own_home = os.path.expanduser("~")
    own_user = os.path.basename(own_home)
    hits = []
    for number, line in enumerate(content.splitlines(), start=1):
        if own_home and own_home in line:
            hits.append((number, line.strip()[:200], own_home))
            continue
        match = HOME_DIRECTORY_PATH.search(line)
        if match and match.group(1) != own_user:
            hits.append((number, line.strip()[:200], match.group(0)))
    return hits


def previous_file_content(file_path):
    directory = os.path.dirname(os.path.abspath(file_path)) or "."
    try:
        relative = subprocess.run(
            ["git", "-C", directory, "ls-files", "--full-name", os.path.basename(file_path)],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        if not relative:
            return None
        result = subprocess.run(
            ["git", "-C", directory, "show", "HEAD:" + relative],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def removed_identifier_words(old_content, new_content):
    old_words = set(IDENTIFIER_WORD.findall(old_content))
    new_words = set(IDENTIFIER_WORD.findall(new_content))
    return sorted(old_words - new_words)


def unlisted_removed_words(removed_words, private_patterns, verify_patterns):
    all_patterns = private_patterns + verify_patterns
    return [word for word in removed_words if not any(pattern.search(word) for pattern in all_patterns)]


def removed_term_reminder_applies(file_path, content, private_patterns, verify_patterns):
    old_content = previous_file_content(file_path)
    if old_content is None:
        return False
    removed = removed_identifier_words(old_content, content)
    return bool(unlisted_removed_words(removed, private_patterns, verify_patterns))


def build_advisory(file_path, content):
    private_patterns = load_line_patterns(private_refs_path())
    verify_patterns = load_verify_patterns(find_publish_scrub_sed(file_path))

    hits = banned_pattern_hits(content, private_patterns + verify_patterns)
    hits.extend(foreign_home_path_hits(content))
    if hits:
        number, line, pattern = hits[0]
        reason = (
            "skill-write-guard: line {number} matches a banned pattern ({pattern}): {line}\n"
            "Run /skill-writer before continuing."
        ).format(number=number, pattern=pattern, line=line)
        return {"decision": "block", "reason": reason}

    reminder_lines = [RUN_SKILL_WRITER_REMINDER]
    if removed_term_reminder_applies(file_path, content, private_patterns, verify_patterns):
        reminder_lines.append(REMOVED_TERM_REMINDER)

    return {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "\n".join(reminder_lines),
        }
    }


def main():
    try:
        payload = json.load(sys.stdin)
        tool_input = payload.get("tool_input") or {}
        file_path = tool_input.get("file_path") or ""
        if not isinstance(file_path, str) or not is_skill_file(file_path):
            return 0
        if not os.path.isfile(file_path):
            return 0
        with open(file_path, encoding="utf-8", errors="ignore") as handle:
            content = handle.read()
        advisory = build_advisory(file_path, content)
        json.dump(advisory, sys.stdout)
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
