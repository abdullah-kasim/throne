# Throne lifecycle
Summary: Installs, starts, stops and restarts the throne and its Regent.
Code: src/throne-startup, src/dismiss-regent, src/summon-regent, src/throne-lifecycle, src/install-services, src/ensure-harness-setup, src/attach-throne-herdr, src/restart-harnesses, src/migrate-home, .claude/skills/update-harnesses
Search words: throne-startup, dismiss-regent, summon-regent, disable-throne, enable-throne, install-services, ensure-harness-setup, attach-throne-herdr, restart-harnesses, update-harnesses, migrate-home, systemd

## What it does

`install-services` registers every Claude hook listed in `claude-hooks/hooks.json` (see the harness hooks spec) and installs systemd units, whose throne services start through `bin/throne-runtime` on the pinned Bun; `ensure-harness-setup` re-registers the same listed hooks and drops any registration of a retired `claude-hooks/*-fence.py` script. `throne-startup` runs on session start and reconciles from the durable ledger after a reboot; a pi agent is resumed as pi with its recorded model id and session, and a resume whose DeepSeek key is not ready is refused with a warning and launches nothing. `install.sh` and update vendor the pinned pi to run under Bun. `summon-regent` and `dismiss-regent` bring the Regent up and down; `enable-throne` and `disable-throne` start and stop the units without messaging anyone. `restart-harnesses` relaunches every live agent onto the vendored binary in its exact session; a Claude agent comes back with throne's mod when the mod validates, and without it otherwise, so a restart is needed only for an agent launched before every Claude launch loaded the mod. A Claude agent whose session runs in the background (the pane shows only a `claude attach` viewer and `claude agents --json` lists its session id outside the pane) is stopped at its real session process and host, confirmed gone, and resumed in the foreground in its pane; a session that survives SIGKILL, or a viewer whose session list cannot be read, is a failed line and nothing is relaunched over it. The dry run says "background session" on that line, the vendored-binary check refuses a viewer, and a restart that fails after relaunch puts the agent's name back on its pane. `update-harnesses` runs the staged Claude Code's `plugin validate` on `extensions/claude` on every Claude `update` and `pinned`, records `modValidation` in its evidence, and on a failure prints one line and carries on. `migrate-home` moves old settings into the throne home once.

## Sub-features

- LC-STARTUP: Startup reconciles from ledger state, not process presence.
- LC-WORKTREE-SKIP: Startup in a worktree skips its own reconciliation.
- LC-REGENT: The Regent can be dismissed and summoned.
- LC-RESTART: Restarted harnesses keep their native session and herdr name.
- LC-BG-RESTART: A background Claude session is stopped at its real process and comes back in the foreground in its pane.
- LC-MOD-VALIDATE: update-harnesses reports whether the new Claude Code still validates throne's mod.
- LC-PI-RESUME: A restarted pi agent comes back in its recorded pi session on its recorded model.
- LC-MIGRATE: migrate-home refuses an item whose two copies differ.

## How to reach it and prove it works

```
bun test ./src/throne-startup/throne-startup.spec.ts ./.claude/skills/update-harnesses/scripts/update-harness.test.mjs ./test/pi-lifecycle.test.ts ./test/restart-harnesses-background-sessions.test.ts
```

## Gotchas

disable-throne stops the units silently; agents are not told.
