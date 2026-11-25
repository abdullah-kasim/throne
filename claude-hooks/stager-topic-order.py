import json
import os
import re
import sys
from datetime import datetime, timezone

AGENT_NAME_VARIABLE = "THRONE_AGENT_NAME"
THRONE_HOME_VARIABLE = "THRONE_DATA_HOME"
ROLE_LINE_PREFIX = "- **Role:** "
STAGER_ROLE = "Stager"
DELIVERED_MESSAGE_OPENING = re.compile(r"<message(\d+)>")


def data_directory(environment):
    home = environment.get(THRONE_HOME_VARIABLE, "").strip() or os.path.join(os.path.expanduser("~"), ".throne")
    return os.path.join(home, "data")


def is_stager_session(agent_name, ledger_directory):
    identity = os.path.join(ledger_directory, agent_name, "identity.md")
    if not os.path.isfile(identity):
        return False
    with open(identity, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith(ROLE_LINE_PREFIX):
                return line[len(ROLE_LINE_PREFIX):].strip() == STAGER_ROLE
    return False


def is_delivered_message(prompt):
    return any(f"</message{number}>" in prompt for number in DELIVERED_MESSAGE_OPENING.findall(prompt))


def saved_topic(topic_file):
    if not os.path.isfile(topic_file):
        return ""
    with open(topic_file, encoding="utf-8") as handle:
        return handle.readline().strip()


def order_text(topic):
    if topic == "":
        return ("ORDER: no topic is saved for this Stager yet. Before any other tool or text, name it: "
                "run 'throne topic none' for a greeting, a startup brief or a slash command, otherwise "
                "'throne topic same --description \"<topic>\"' with the topic as wide as one project (a board, a repo), "
                "not one subject. Then answer the prompt.")
    return (f"ORDER: before any other tool or text, decide whether this prompt changes the topic from: {topic}. "
            "Topics are as wide as one project (a board, a repo), not one subject. "
            "Record the verdict first with 'throne topic same' or 'throne topic changed <slug>'. "
            "If it changed: fork now, do not ask the Lord, and do not answer the prompt. Hand it over: relay it verbatim to a live stager-<slug>, "
            "or fork stager-<slug>, trimmed to 32 characters, with the throne-fork procedure "
            "and a brief of what this conversation settled on that topic. "
            "Tell the Lord in one line which Stager has it and where its pane is. Do nothing else. "
            "If the Lord says it is the same topic, stay and answer.")


def read_time(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def previous_prompt_time(prompt_file):
    if not os.path.isfile(prompt_file):
        return None
    with open(prompt_file, encoding="utf-8") as handle:
        return read_time(json.load(handle)["at"])


def has_verdict_since(verdicts_file, since):
    if not os.path.isfile(verdicts_file):
        return False
    with open(verdicts_file, encoding="utf-8") as handle:
        return any(read_time(json.loads(line)["at"]) >= since for line in handle if line.strip() != "")


def previous_prompt_missed_its_verdict(agent_folder, now):
    prompt_file = os.path.join(agent_folder, "topic-prompt.json")
    since = previous_prompt_time(prompt_file)
    missed = since is not None and not has_verdict_since(os.path.join(agent_folder, "topic-verdicts.jsonl"), since)
    with open(prompt_file, "w", encoding="utf-8") as handle:
        json.dump({"at": now.isoformat()}, handle)
    return missed


def topic_order_for_prompt(hook_input, environment):
    agent_name = environment.get(AGENT_NAME_VARIABLE, "").strip()
    if agent_name == "":
        return None
    ledger_directory = data_directory(environment)
    if not is_stager_session(agent_name, ledger_directory):
        return None
    if is_delivered_message(hook_input.get("prompt", "")):
        return None
    agent_folder = os.path.join(ledger_directory, agent_name)
    order = order_text(saved_topic(os.path.join(agent_folder, "topic.md")))
    if previous_prompt_missed_its_verdict(agent_folder, datetime.now(timezone.utc)):
        sys.stderr.write(f"stager-topic-order: the previous prompt to {agent_name} got no topic verdict\n")
        return "Your last prompt got no topic verdict from throne topic. " + order
    return order


def main():
    try:
        order = topic_order_for_prompt(json.loads(sys.stdin.read()), os.environ)
    except Exception as error:
        sys.stderr.write(f"stager-topic-order: {error}\n")
        return 0
    if order is not None:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": order}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
