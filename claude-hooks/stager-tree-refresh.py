import json
import os
import subprocess
import sys

THRONE_CLI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "throne-cli")
THRONE_CLI_ENVIRONMENT_VARIABLE = "THRONE_STAGER_TREE_REFRESH_CLI"
REFRESH_TIMEOUT_SECONDS = 20


def refreshed_line(hook_input_text, environment):
    result = subprocess.run([environment.get(THRONE_CLI_ENVIRONMENT_VARIABLE, THRONE_CLI), "refresh-stager-tree"],
                            input=hook_input_text, text=True, capture_output=True, env=environment,
                            timeout=REFRESH_TIMEOUT_SECONDS)
    if result.stderr != "":
        sys.stderr.write(result.stderr)
    return result.stdout.strip()


def main():
    try:
        line = refreshed_line(sys.stdin.read(), os.environ)
    except Exception as error:
        sys.stderr.write(f"stager-tree-refresh: {error}\n")
        return 0
    if line != "":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": line}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
