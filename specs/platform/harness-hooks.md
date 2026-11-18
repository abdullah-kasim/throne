# Harness hooks
Summary: Lists throne's global hooks once in claude-hooks/hooks.json, registers them in Claude Code's settings, and runs the same scripts on pi agents through a bridge extension.
Code: claude-hooks/hooks.json, src/install-services/claude-hooks.ts, src/install-services/claude-settings-hook.ts, extensions/pi/throne-pi-hooks.ts, bin/agent-launcher-lib.sh, claude-hooks/scratch-path-guard.py, claude-hooks/stager-tree-refresh.py, src/stager-tree-refresh
Search words: hooks.json, claude-hooks, throne-pi-hooks, pi hook bridge, THRONE_HOOK_HARNESS, notOn, pi-hook-bridge.log, scratch-path-guard, skill-write-guard, memory-read-log, web-fetch-failure-pointer, stager-tree-refresh, refresh-stager-tree, before_agent_start

## What it does

`claude-hooks/hooks.json` is the only list of throne's global hooks. Each entry names a `script` in `claude-hooks/`, a Claude `event`, a `matcher` when the event has one, and optionally `notOn` (harness names the entry skips), `timeout`, `statusMessage`, `replaces` (patterns of retired script commands the entry removes from the event) and `withGlobalMemoryDirectories` (append `recall.globalMemoryDirectories` as arguments).

Claude Code: `install-services` and `ensure-harness-setup` register every entry not marked `notOn: ["claude"]` in `~/.claude/settings.json` through the existing settings editor. On a machine already installed the file is left byte-identical; a hook already present is reported unchanged.

Pi: `installPiStateExtensions` links `extensions/pi/throne-pi-hooks.ts` into each pi agent's extensions folder at launch. The bridge reads hooks.json at session start and, for each entry not marked `notOn: ["pi"]`, maps PreToolUse to tool_call, PostToolUse to tool_result, SessionStart to session_start, SessionEnd to session_shutdown and UserPromptSubmit to before_agent_start (user prompts only). It builds the Claude hook input (pi tool names mapped to Claude's, `path` copied to `file_path`) and runs the matching scripts one after another with `THRONE_HOOK_HARNESS=pi`. Exit 2, a deny or a block answer blocks a tool call with the script's reason. After a call has run, the reason or `additionalContext` is appended to the result text instead, because pi cannot block at that point. On a prompt, any `additionalContext` is shown as one `throne-hooks` message. An entry whose event has no pi counterpart, and a missing or crashing script, write one line to `pi-hook-bridge.log` in the agent's data folder and never block. Each tool call takes longer: about 108 ms for Bash, 40 ms for Read and 34 ms for Write, measured.

On pi, the hooks that run are scratch-path-guard, skill-write-guard, memory-read-log, web-fetch-failure-pointer and stager-tree-refresh. agent-state and hidden-skill-pointer are `notOn: pi` because pi has its own state extension. agent-exit-marker is `notOn: pi` too: every pi exit, including SIGTERM and SIGHUP from the court, reports `session_shutdown` reason `quit`, so pi cannot tell the Lord's exit apart from a stop by the court. With `THRONE_HOOK_HARNESS=pi`, scratch-path-guard applies only its shared-/tmp and root-path write rule, and skips its two removal rules.

stager-tree-refresh runs on every prompt on both harnesses and calls `throne refresh-stager-tree` with the hook input. For a registered Stager whose tree is clean and behind `main`, that fast-forwards the tree and prints one line; a dirty or diverged tree gets one WARNING line naming the commit counts and is left alone; any other session prints nothing. It always exits 0. A machine gets the hook only after `throne install-services`.

The agent launcher checks the scripts hooks.json lists for Claude (`throne_hook_scripts`), so a new hook needs no launcher edit. To add a hook, write one script and add one entry.

## Sub-features

- HK-LIST: hooks.json is the one list; Claude settings and the pi bridge both read it.
- HK-CLAUDE: The installer writes today's Claude settings entries, retiring replaced script names.
- HK-PI-BRIDGE: Pi agents run every entry not marked notOn pi, in order, with THRONE_HOOK_HARNESS=pi.
- HK-PI-ANSWER: A deny, block or exit 2 blocks a pi tool call; after a call has run, the answer is appended to its result.
- HK-NEVER-BLOCKS: An unmapped event, a missing script or a crashing script is logged and lets the call through.
- HK-SCRATCH-PI: On pi, scratch-path-guard enforces only the shared-/tmp rule.
- HK-STAGER-REFRESH: Each prompt fast-forwards a clean, behind Stager tree to main, warns on a dirty or diverged one, and leaves other sessions untouched.
- HK-LAUNCHER: The launcher's hook check follows hooks.json.

## How to reach it and prove it works

```
bun test ./src/install-services/claude-hooks.spec.ts ./extensions/pi/throne-pi-hooks.spec.ts ./src/herdr/pi-state-install.spec.ts ./test/a-launch-repairs-missing-harness-hooks-and-never-blocks.test.ts ./test/stager-tree-refresh.test.ts
python3 -m unittest discover -s claude-hooks
bun scripts/pi-evidence/run.mjs --group hooks --out <folder>
```

The tests exit 0. In real pi panes, the evidence group shows `touch /tmp/x` blocked while `rm -rf ~/tmp/x` runs, a skill-write-guard warning appended, a memory read logged, the web-fetch pointer appended, a throwaway entry run on both harnesses, and the unmapped-event line in the bridge log.

## Gotchas

A live pi agent gets the bridge only after it is relaunched (`/restart-harnesses`). PostToolUseFailure has no pi event, so those web-fetch entries only log on pi. Pi cannot block after a call has run, so skill-write-guard's block becomes appended text.
