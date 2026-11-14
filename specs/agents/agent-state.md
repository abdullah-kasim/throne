# Agent state file
Summary: Records each agent's declared state (working, blocked, waiting on its own run, waiting on its supervisor, reapable) in one file that every state check reads instead of the agent's pane.
Code: src/my-state, src/agentdata/agent-state.service.ts, claude-hooks/agent-state.py, src/install-services/agent-state-hook.ts
Search words: my-state, state.json, agent state, declared state, working, blocked, waiting-on-own-run, waiting-on-supervisor, reapable, turn-start, turn-end, marker

## What it does

`throne my-state <state> [--by <child>]... [--agent <name>] [<words>]` writes `~/.throne/data/<agent>/state.json` with the state, who declared it (`agent`, `regent`, `turn-start`), when, the children a `blocked` agent waits on (`--by`, one per child), and the words: what a waiting agent waits on, or the reason a `reapable` agent gives (`completed`, `abandoned`, `task_restart_required`, `fail`). The file is written to a temporary file and renamed. An unknown state is refused and nothing is written. Only the Regent may pass `--agent` to write another agent's file; that write is recorded as `declaredBy: regent`.

Reading: a missing file reads as `working`; a malformed one reads as `working` and says so on stderr. An old `blocked.json` left from before the file existed is converted to `state.json` the first time it is read, and removed. Sending an agent a message, delivering one, and startup reconciliation of a dead agent clear a `blocked` state back to `working`.

Two Claude hooks keep the file current. At each prompt (`UserPromptSubmit`) the turn-start hook writes `working` as `turn-start`, so a state from an earlier turn never outlives the next prompt. When a turn ends (`Stop`) the turn-end hook takes the final assistant message (from the event, else the last assistant text in the transcript) and passes it to `throne my-state --turn-end`. When that message carries a marker line (`{"blocked":true}` with `__BLOCKED_BY_<child>__` tokens, `BLOCKED_BY_own-background-run (<what>)`, or `{"reapable":"<reason>"}`), the matching state is written as `declaredBy: agent`, but only while the file still holds the turn-start `working`; a `my-state` call in the same turn, or a Regent write, wins over a disagreeing marker. A turn with no marker leaves the file alone. The hooks swallow every failure and never block the turn. `install-services` and `ensure-harness-setup` register both hooks in Claude's settings. Codex has no turn-end hook, so a Codex agent must use the command.

The marker line in a message stays for people reading the pane; no check reads a pane to learn an agent's state.

## Sub-features

- ST-DECLARE: `my-state` writes the declared state, its children or words, who declared it and when, atomically.
- ST-UNKNOWN: An unknown state is refused and no file is written.
- ST-REGENT-ONLY: Only the Regent writes another agent's state, recorded as `regent`.
- ST-MISSING: A missing or malformed file reads as `working`.
- ST-CONVERT: An old `blocked.json` is converted once on first read.
- ST-TURN-START: Each prompt resets the file to `working`.
- ST-REMIND-IN: `waiting-on-own-run --remind-in <minutes>` stores a whole number from 5 to 60 as `remindInMinutes`; outside that it is refused and nothing is written; a file without it, or a marker-only wait, reads 15.
- ST-TURN-END: A Claude turn ending with a marker writes the matching state unless the command or the Regent already declared one that turn.

## How to reach it and prove it works

From an agent session: `throne my-state waiting-on-own-run "suite run"` then `cat ~/.throne/data/<agent>/state.json` shows `"state": "waiting-on-own-run"` with those words; the next prompt turns it back to `working`.

```
bun test ./src/agentdata/agent-state.service.spec.ts
python3 claude-hooks/test_agent_state.py
```

Both exit 0.

## Gotchas

An agent that only prints a marker is seen only through the Claude turn-end hook; a Codex agent, or a Claude session started before the hooks were installed, must use the command. The turn-end parser matches a marker anywhere in the final message, including one quoted in prose. The turn-end hook runs in every Claude session with a non-empty final message, even one that is not a throne agent; there the write is refused and nothing changes. A claim lasts only until the next prompt, because the turn-start hook resets it.
