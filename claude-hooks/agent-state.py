import datetime
import json
import os
import subprocess
import sys
import uuid

STATE_FILE_NAME = "state.json"
THRONE_HOME_ENVIRONMENT_VARIABLE = "THRONE_DATA_HOME"
AGENT_NAME_ENVIRONMENT_VARIABLE = "THRONE_AGENT_NAME"
THRONE_CLI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "throne-cli")
TURN_END_TIMEOUT_SECONDS = 30
THRONE_CLI_ENVIRONMENT_VARIABLE = "THRONE_AGENT_STATE_CLI"


def throne_home(environment):
    configured = environment.get(THRONE_HOME_ENVIRONMENT_VARIABLE, "").strip()
    return configured or os.path.join(os.path.expanduser("~"), ".throne")


def working_state():
    return {
        "state": "working",
        "blockedBy": [],
        "waitingOn": None,
        "reapableReason": None,
        "declaredAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "declaredBy": "turn-start",
    }


def record_working(environment):
    agent_name = environment.get(AGENT_NAME_ENVIRONMENT_VARIABLE, "").strip()
    if agent_name == "":
        return
    folder = os.path.join(throne_home(environment), "data", agent_name)
    if not os.path.isdir(folder):
        return
    final_path = os.path.join(folder, STATE_FILE_NAME)
    temporary_path = f"{final_path}.{uuid.uuid4()}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as handle:
        json.dump(working_state(), handle)
        handle.write("\n")
    os.replace(temporary_path, final_path)
    try:
        os.remove(os.path.join(folder, "blocked.json"))
    except FileNotFoundError:
        pass


def message_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    return ""


def last_message_in_transcript(transcript_path):
    last_text = ""
    with open(transcript_path, encoding="utf-8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "assistant":
                continue
            message = entry.get("message")
            text = message_text(message.get("content")) if isinstance(message, dict) else ""
            if text.strip() != "":
                last_text = text
    return last_text


def final_message(hook_input):
    message = hook_input.get("last_assistant_message")
    if isinstance(message, str):
        return message
    transcript_path = hook_input.get("transcript_path")
    if isinstance(transcript_path, str) and transcript_path != "":
        return last_message_in_transcript(transcript_path)
    return ""


def record_turn_end_marker(hook_input, environment):
    message = final_message(hook_input)
    if message.strip() == "":
        return
    subprocess.run([environment.get(THRONE_CLI_ENVIRONMENT_VARIABLE, THRONE_CLI), "my-state", "--turn-end"], input=message, text=True,
                   capture_output=True, env=environment, timeout=TURN_END_TIMEOUT_SECONDS)


def read_hook_input(text):
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def main():
    try:
        hook_input = read_hook_input(sys.stdin.read())
        if hook_input.get("hook_event_name") == "Stop":
            record_turn_end_marker(hook_input, os.environ)
        else:
            record_working(os.environ)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
