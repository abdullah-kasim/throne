import json
import os
import sys

TOLD_TO_EXIT_MARKER_BASENAME = "told-to-exit"
REASON_THE_USER_QUIT = "prompt_input_exit"
THRONE_HOME_ENVIRONMENT_VARIABLE = "THRONE_DATA_HOME"
AGENT_NAME_ENVIRONMENT_VARIABLE = "THRONE_AGENT_NAME"


def throne_home(environment):
    configured = environment.get(THRONE_HOME_ENVIRONMENT_VARIABLE, "").strip()
    return configured or os.path.join(os.path.expanduser("~"), ".throne")


def marker_path(agent_name, environment):
    return os.path.join(throne_home(environment), "data", agent_name, TOLD_TO_EXIT_MARKER_BASENAME)


def the_user_quit(hook_input):
    return hook_input.get("hook_event_name") == "SessionEnd" and hook_input.get("reason") == REASON_THE_USER_QUIT


def a_session_started(hook_input):
    return hook_input.get("hook_event_name") == "SessionStart"


def write_marker(path, hook_input):
    if not os.path.isdir(os.path.dirname(path)):
        return
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"session_id": hook_input.get("session_id"), "reason": hook_input.get("reason")}, handle)
        handle.write("\n")


def remove_marker(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def record_how_the_session_changed(hook_input, environment):
    agent_name = environment.get(AGENT_NAME_ENVIRONMENT_VARIABLE, "").strip()
    if agent_name == "":
        return
    path = marker_path(agent_name, environment)
    if the_user_quit(hook_input):
        write_marker(path, hook_input)
    elif a_session_started(hook_input):
        remove_marker(path)


def main():
    try:
        hook_input = json.load(sys.stdin)
        if isinstance(hook_input, dict):
            record_how_the_session_changed(hook_input, os.environ)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
