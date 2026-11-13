# Throne backend
Summary: Runs the long-lived server that hosts the message dispatch loop, the watchdogs and the web listener.
Code: src/throne-backend, src/agent-settings, bin/throne-runtime, src/process-inspection/launch-count.ts
Search words: throne-backend, agent-settings-tick, backend, worker, backend-vitals, child launches, memory, event-loop delay

## What it does

`throne-backend` runs on Bun, started by its service unit through `bin/throne-runtime`, the one launcher that names the runtime and runs the Bun pinned in `mise.toml`; procwatch still recognises its `ExecStart` behind the launcher and never touches it. It is the one long-lived process: it hosts keep-going, no-idling, the message queue's dispatch loop and the web listener as in-process workers. A message that cannot be delivered never kills it. `agent-settings-tick` checks every agent's colour and session name once and corrects what differs, in the backend or locally with `--local`. Once a minute the backend writes one `[backend-vitals]` line to its journal: the child processes it launched in that minute (every `node:child_process` and `Bun.spawn` launch passes one counter), its resident memory in MB, and event-loop delay as mean, p99 and max in ms. A failed sample never stops the backend.

## Sub-features

- BE-WORKERS: Dispatch, keep-going and no-idling run as workers of one process.
- BE-SURVIVE: An undeliverable message does not stop the server.
- BE-BUN: The backend, the `throne` command and the hooks start through `bin/throne-runtime`; a missing pin or an uninstalled pinned Bun exits 1 naming the fix.
- BE-VITALS: One `[backend-vitals]` journal line a minute gives launches that minute, resident memory and event-loop delay.
- BE-SETTINGS: Agent colour and session name drift is corrected; `--dry-run` changes nothing.

## How to reach it and prove it works

```
bun test ./src/throne-backend/an-undeliverable-message-does-not-kill-the-server.test.ts ./test/starting-throne-through-the-launcher-runs-the-pinned-bun.test.ts ./test/every-throne-command-starts-through-the-runtime-launcher.test.ts ./src/process-inspection/launch-count.spec.ts
```

Exits 0. `throne agent-settings-tick --local --dry-run` lists drift without changing it. `journalctl --user -u throne-backend | grep backend-vitals` shows one line a minute.

## Gotchas

Rebuilding `dist/` can restart the backend through its systemd unit. Bun cures the freeze Node had when launching a child from a big process; whether the backend still grows in memory is read from the `[backend-vitals]` lines, not assumed.
