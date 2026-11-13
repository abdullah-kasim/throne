import ipaddress
import json
import os
import re
import subprocess
import sys
from urllib.parse import urlparse

DESKTOP_CHROME_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
)
FETCH_COMMAND = re.compile(r"(?:^|[\s;&|(`])(?:curl|wget)(?=\s)")
WEB_ADDRESS = re.compile(r"https?://[^\s'\"<>`|;&)]+")
FAILED_STATUS = re.compile(r"(?<![0-9])(401|403|429|5[0-9][0-9])(?![0-9])")
FAILED_STATUS_LINE = re.compile(r"(?:HTTP/[0-9.]+ |error: |^)(401|403|429|5[0-9][0-9])\b", re.MULTILINE)
VERSION_CHECK_SECONDS = 2
GIT_SECONDS = 2
FAILED_FETCH_CODE = 400
TAILNET_RANGE = ipaddress.ip_network("100.64.0.0/10")


def home_directory():
    return os.path.expanduser("~")


def is_local_host(host):
    host = (host or "").lower().rstrip(".")
    if not host or host == "localhost" or host.endswith(".localhost") or host.endswith(".ts.net"):
        return True
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    in_tailnet = address.version == 4 and address in TAILNET_RANGE
    return address.is_private or address.is_loopback or address.is_link_local or in_tailnet


def public_address(text):
    for match in WEB_ADDRESS.finditer(text or ""):
        address = match.group(0)
        if not is_local_host(urlparse(address).hostname):
            return address
    return None


def failed_web_fetch_address(payload):
    tool_input = payload.get("tool_input") or {}
    address = tool_input.get("url") if isinstance(tool_input, dict) else None
    if not isinstance(address, str):
        return None
    if payload.get("hook_event_name") == "PostToolUse":
        response = payload.get("tool_response")
        code = response.get("code") if isinstance(response, dict) else None
        if not isinstance(code, int) or code < FAILED_FETCH_CODE:
            return None
    return public_address(address)


def failed_bash_fetch_address(payload):
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not FETCH_COMMAND.search(command):
        return None
    if payload.get("hook_event_name") == "PostToolUse":
        response = payload.get("tool_response")
        if not isinstance(response, dict):
            return None
        stdout = str(response.get("stdout") or "")
        stderr = str(response.get("stderr") or "")
        if not (FAILED_STATUS.fullmatch(stdout.strip()) or FAILED_STATUS_LINE.search(stdout + "\n" + stderr)):
            return None
    return public_address(command)


def failed_address(payload):
    if payload.get("hook_event_name") not in ("PostToolUse", "PostToolUseFailure"):
        return None
    tool_name = payload.get("tool_name")
    if tool_name == "WebFetch":
        return failed_web_fetch_address(payload)
    if tool_name == "Bash":
        return failed_bash_fetch_address(payload)
    return None


def session_folder(session_id):
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(home_directory(), ".cache")
    safe_session = re.sub(r"[^A-Za-z0-9_-]", "_", session_id)
    return os.path.join(cache, "throne", "web-fetch-failure-pointer", safe_session)


def read_lines(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().splitlines()
    except OSError:
        return None


def write_line(path, line, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode, encoding="utf-8") as handle:
        handle.write(line + "\n")


def agent_browser_runs(cwd, folder):
    answer_path = os.path.join(folder, "agent-browser-runs")
    remembered = read_lines(answer_path)
    if remembered:
        return remembered[0] == "yes"
    try:
        runs = subprocess.run(
            ["agent-browser", "--version"],
            cwd=cwd,
            capture_output=True,
            timeout=VERSION_CHECK_SECONDS,
        ).returncode == 0
    except Exception:
        runs = False
    write_line(answer_path, "yes" if runs else "no", "w")
    return runs


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


def skill_file(cwd):
    folders = [cwd]
    checkout = main_checkout(cwd)
    if checkout:
        folders.append(checkout)
    candidates = [os.path.join(folder, ".claude", "skills", "agent-browser", "SKILL.md") for folder in folders]
    candidates.append(os.path.join(home_directory(), ".claude", "skills", "agent-browser", "SKILL.md"))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def advice(address, skill_path):
    lines = [
        "The fetch of {address} failed. agent-browser drives a real browser and often gets past the block.".format(
            address=address
        ),
        "Try: agent-browser open {address}".format(address=address),
        'If it still refuses: agent-browser open {address} --user-agent "{agent}"'.format(
            address=address, agent=DESKTOP_CHROME_USER_AGENT
        ),
    ]
    if skill_path:
        lines.append("The agent-browser skill is at {path}.".format(path=skill_path))
    return "\n".join(lines)


def main():
    try:
        payload = json.load(sys.stdin)
        address = failed_address(payload)
        if address is None:
            return 0
        cwd = payload.get("cwd") or os.getcwd()
        folder = session_folder(str(payload.get("session_id") or "no-session"))
        advised_path = os.path.join(folder, "advised")
        if address in (read_lines(advised_path) or []):
            return 0
        if not agent_browser_runs(cwd, folder):
            return 0
        write_line(advised_path, address, "a")
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": payload.get("hook_event_name"),
                    "additionalContext": advice(address, skill_file(cwd)),
                }
            },
            sys.stdout,
        )
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
