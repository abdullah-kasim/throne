# Scratch space and slots
Summary: Sweeps stale scratch directories and runs commands in counted slots.
Code: src/sweep-tmp-scratch, src/reclaim-agent-scratchpads, src/semaphore, src/tmp-scratch-lifecycle
Search words: sweep-tmp-scratch, reclaim-agent-scratchpads, semaphore, scratch

## What it does

`sweep-tmp-scratch` and `reclaim-agent-scratchpads` remove aged or dead agents' scratch directories nothing holds, as dry runs by default. `semaphore` creates a named counting semaphore, runs a command in a free slot until it exits (even if throne is killed), and shows holders. Each slot is a row in `locks.sqlite3` (see the lock rows spec); the command runs in its own process group and its process id, start time and command line are written into the slot's row, so the slot stays held while the command lives even if the runner is killed, and frees once both have ended. `semaphore status` lists each held slot with its command.

## Sub-features

- SC-DRY: Sweeps are dry runs unless told otherwise.
- SC-ATTRIBUTED: Only scratchpads positively attributed to dead agents are reclaimed.
- SC-SLOT: A semaphore slot is held until the command exits.

## How to reach it and prove it works

`throne semaphore status` lists semaphores and exits 0. Then:

```
bun test ./src/semaphore/semaphore-across-processes.spec.ts
```

## Gotchas

A sweep never removes a directory a live process holds. A slot whose command is still running keeps counting against the semaphore after `semaphore run` itself is killed; that is the promise, not a leak.
