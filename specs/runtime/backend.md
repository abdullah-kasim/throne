# Throne backend
Summary: Runs the long-lived server that hosts the message dispatch loop, the watchdogs and the web listener.
Code: src/throne-backend, src/agent-settings, bin/throne-runtime, src/process-inspection/launch-count.ts
Search words: throne-backend, agent-settings-tick, backend, worker, backend-vitals, child launches, memory, event-loop delay

## What it does

`throne-backend` runs on Bun, started by its service unit through `bin/throne-runtime`, the one launcher that names the runtime and runs the Bun pinned in `mise.toml`; procwatch still recognises its `ExecStart` behind the launcher and never touches it. It is the one long-lived process: it hosts keep-going, no-idling, the message queue's dispatch loop and the web listener as in-process workers. A message that cannot be delivered never kills it. `agent-settings-tick` checks every agent's colour and session name once and corrects what differs, in the backend or locally with `--local`. For a Claude agent whose mod's sign says `commands: true`, the `/color` or `/rename` correction goes to the mod as a command request, with no pane read or key: an ack means applied, a timeout while the mod still answers means skipped as busy, and anything else logs one fallback line and types the command once. An older mod, or none, gets the command typed as before. The correction right after a spawn skips its wait for the pane to take a command when the mod takes commands. Once a minute the backend writes one `[backend-vitals]` line to its journal: the child processes it launched in that minute (every `node:child_process` and `Bun.spawn` launch passes one counter), its resident memory in MB, and event-loop delay as mean, p99 and max in ms. A failed sample never stops the backend. Once it has sent READY=1 the app process sends `WATCHDOG=1` to systemd every 30 s, the only sender of that ping; keep-going does not feed the watchdog. The unit's `WatchdogSec=120` means an app process that dies or stops turning under a live `nest start --watch` parent gets the whole unit restarted within about two minutes.

## Sub-features

- BE-WORKERS: Dispatch, keep-going and no-idling run as workers of one process.
- BE-SURVIVE: An undeliverable message does not stop the server.
- BE-BUN: The backend, the `throne` command and the hooks start through `bin/throne-runtime`; a missing pin or an uninstalled pinned Bun exits 1 naming the fix.
- BE-VITALS: One `[backend-vitals]` journal line a minute gives launches that minute, resident memory and event-loop delay.
- BE-WATCHDOG: Once it has sent READY=1 the backend app process sends `WATCHDOG=1` every 30 s and the unit's `WatchdogSec=120` restarts the unit after two minutes without one; keep-going never sends it.
- BE-SETTINGS: Agent colour and session name drift is corrected, through the mod with no pane read or key when the agent's mod takes commands and typed otherwise; `--dry-run` changes nothing.

## How to reach it and prove it works

```
bun test ./src/throne-backend/an-undeliverable-message-does-not-kill-the-server.test.ts ./test/starting-throne-through-the-launcher-runs-the-pinned-bun.test.ts ./test/every-throne-command-starts-through-the-runtime-launcher.test.ts ./src/process-inspection/launch-count.spec.ts ./src/agent-settings/harness-command-typing.spec.ts ./src/agent-settings/agent-settings-at-spawn.spec.ts ./src/throne-backend/the-backend-app-keeps-the-systemd-watchdog-fed.spec.ts
```

Exits 0. `throne agent-settings-tick --local --dry-run` lists drift without changing it. `journalctl --user -u throne-backend | grep backend-vitals` shows one line a minute.

## Gotchas

Rebuilding `dist/` can restart the backend through its systemd unit. Bun cures the freeze Node had when launching a child from a big process; whether the backend still grows in memory is read from the `[backend-vitals]` lines, not assumed.
