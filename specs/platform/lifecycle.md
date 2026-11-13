# Throne lifecycle
Summary: Installs, starts, stops and restarts the throne and its Regent.
Code: src/throne-startup, src/dismiss-regent, src/summon-regent, src/throne-lifecycle, src/install-services, src/ensure-harness-setup, src/attach-throne-herdr, src/restart-harnesses, src/migrate-home
Search words: throne-startup, dismiss-regent, summon-regent, disable-throne, enable-throne, install-services, ensure-harness-setup, attach-throne-herdr, restart-harnesses, migrate-home, systemd

## What it does

`install-services` installs hooks and systemd units, whose throne services start through `bin/throne-runtime` on the pinned Bun; `ensure-harness-setup` re-registers harness hooks. `throne-startup` runs on session start and reconciles from the durable ledger after a reboot. `summon-regent` and `dismiss-regent` bring the Regent up and down; `enable-throne` and `disable-throne` start and stop the units without messaging anyone. `restart-harnesses` relaunches every live agent onto the vendored binary in its exact session. `migrate-home` moves old settings into the throne home once.

## Sub-features

- LC-STARTUP: Startup reconciles from ledger state, not process presence.
- LC-WORKTREE-SKIP: Startup in a worktree skips its own reconciliation.
- LC-REGENT: The Regent can be dismissed and summoned.
- LC-RESTART: Restarted harnesses keep their native session and herdr name.
- LC-MIGRATE: migrate-home refuses an item whose two copies differ.

## How to reach it and prove it works

```
bun test ./src/throne-startup/throne-startup.spec.ts
```

## Gotchas

disable-throne stops the units silently; agents are not told.
