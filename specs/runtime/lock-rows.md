# Lock rows
Summary: Holds every cross-process lock throne takes as a row in one SQLite file, freed when its holder dies, with no dependency on flock.
Code: src/shared-policy/lock-rows, src/shared-policy/exclusive-file-lock.ts, scripts/hold-lock.mjs, scripts/suite-concurrency-guard.mjs, bin/throne-cli, systemd/container-runtime-ensure
Search words: lock rows, locks.sqlite3, hold-lock, exclusive lock, suite-concurrency-guard, build lock, flock

## What it does

Every lock throne takes between processes is a row in the `locks` table of `locks.sqlite3` in the throne data home, keyed by the lock's name. A row records the holder's process id, its start time (from `/proc` on Linux, empty elsewhere), the time it was taken, and optionally a command the holder handed the lock to. Taking a lock is one immediate SQLite transaction: an existing row is removed when its holder is dead (the process is gone, or its process id now belongs to a process with another start time) and no command it recorded is still alive, or when it is older than the caller's maximum hold; then the caller's row is inserted, or the take fails. A waiter retries every 25 ms until its time limit. Release deletes only the row the caller still owns, so a holder that was taken over cannot free its successor's lock. A process killed with SIGKILL leaves its row behind, and the next taker finds the holder dead and takes it.

The pane lock (see the messaging spec), the plain exclusive lock behind `withExclusiveFileLock` and `tryExclusiveFileLock` (usage logs, previews, tailnet publishing), the `spec-lock` folder lock, and semaphore slots (see the scratch spec) are all rows. Shell callers take a row through `scripts/hold-lock.mjs <name> -- <command>`, which waits for the lock, hands the row to the command's process, runs it and exits with its code. `bin/throne-cli` builds a checkout on first use under the lock `throne-cli-build:<checkout>` and checks for `dist/` again once it holds it; a missing `node_modules` is installed before the lock, since the lock needs it. `systemd/container-runtime-ensure` starts the container runtime under `container-runtime-start`. The suite concurrency guard holds one of three rows, `suite-concurrency-slot-0` to `-2`, for a whole `bun run test`, and refuses with the holders listed when all three are taken.

install.sh no longer checks for or installs `flock`, and no throne code runs it.

## Sub-features

- LK-DEAD-HOLDER: A lock whose holder died, or whose process id was reused, is taken by the next caller.
- LK-ONE-AT-A-TIME: Processes contending for one name get it one at a time.
- LK-MAX-HOLD: A lock older than the caller's maximum hold is taken over.
- LK-OWNED-RELEASE: Releasing a lock someone else now owns leaves it held.
- LK-HOLD-LOCK: `hold-lock.mjs` runs a command under a lock, exits with its code, and frees the lock when the command or the holder is killed.
- LK-BUILD: Two first-use builds of one checkout never run at once.
- LK-SUITE-SLOTS: At most three suites run at once; a fourth is refused naming the holders.

## How to reach it and prove it works

```
bun test ./src/shared-policy/lock-rows/lock-rows.spec.ts ./src/shared-policy/exclusive-file-lock.spec.ts ./scripts/hold-lock.test.ts ./scripts/suite-concurrency-guard.test.ts ./test/container-runtime-ensure-sh.test.ts
```

Exits 0. `sqlite3 ~/.throne/locks.sqlite3 'select * from locks'` shows the locks held right now.

## Gotchas

A row is not freed by the holder's exit alone; it lingers until the next taker checks the holder, so reading the table shows rows of dead holders. On a system without `/proc` the start time is empty, so a reused process id looks alive. `hold-lock.mjs` needs `node_modules`, which is why the first-use install runs unlocked. Locks are local to one data home; two data homes never contend.
