# Scratch space and slots
Summary: Sweeps stale scratch directories and runs commands in counted slots.
Code: src/sweep-tmp-scratch, src/reclaim-agent-scratchpads, src/semaphore, src/tmp-scratch-lifecycle
Search words: sweep-tmp-scratch, reclaim-agent-scratchpads, semaphore, scratch

## What it does

`sweep-tmp-scratch` and `reclaim-agent-scratchpads` remove aged or dead agents' scratch directories nothing holds, as dry runs by default. `semaphore` creates a named counting semaphore, runs a command in a free slot until it exits (even if throne is killed), and shows holders. Each slot is a row in `locks.sqlite3` (see the lock rows spec); the command runs in its own process group and its process id, start time and command line are written into the slot's row, so the slot stays held while the command lives even if the runner is killed, and frees once both have ended. `semaphore status` lists each held slot with its command.

Whether a sweep may remove an entry is decided in one place, `checkScratchDirRemovalEligibility`, so the dry run and `--apply` cannot disagree. The checks run in this order on every root the command is given: system name, mount point, owner, age, liveness. The reap-agent scratch cleanup goes through the same checks. If deleting an entry fails, that entry gets the outcome `failed (<code>)` and the sweep moves on to the next one. One entry never ends the run.

Every run prints one line per entry. It then ends with a measure: one line per family of names (the name with its random suffix removed, such as `fake-npm-pack`), counting removed entries, each kind of skip, and failures. A dry run counts eligible entries as would-remove. After the families come the root's inodes and bytes in use before and after the sweep. If the root cannot be read after the sweep, the after line reads `unreadable (<code>)`. The command exits 0 whenever the sweep ran to its end, even if some entries failed. It exits non-zero only when it could not run at all: bad arguments, or a root it cannot read before the sweep.

## Sub-features

- SC-DRY: Sweeps are dry runs unless told otherwise.
- SC-ATTRIBUTED: Only scratchpads positively attributed to dead agents are reclaimed.
- SC-SLOT: A semaphore slot is held until the command exits.
- SC-CONTINUE: A failure to delete one entry is reported as `failed (<code>)` and the sweep continues.
- SC-NOT-OURS: An entry owned by a user other than the one sweeping is skipped as `skipped-not-ours`.
- SC-MOUNT: A mount point (a device that differs from its parent's, or a status read that fails with anything but ENOENT, such as ENOTCONN) is skipped as `skipped-mount-point` before any removal is tried.
- SC-SYSTEM-NAME: `.X11-unix`, `.ICE-unix`, `.font-unix`, `.XIM-unix` and `systemd-private-*` are skipped as `skipped-system-name`.
- SC-MEASURE: The report ends with per-family outcome counts and the root's inode and byte use before and after.
- SC-EXIT: The exit code is 0 once a sweep finishes, and non-zero only for bad arguments or a root that cannot be read.

## How to reach it and prove it works

`throne sweep-tmp-scratch` with no `--apply` runs a dry run against /tmp. It prints a line per entry and then the measure, and exits 0. `throne semaphore status` lists semaphores and exits 0. Then:

```
TMPDIR=$HOME/tmp bun test ./src/sweep-tmp-scratch ./src/tmp-scratch-lifecycle ./src/reap-agent
bun test ./src/semaphore/semaphore-across-processes.spec.ts
```

`src/sweep-tmp-scratch/sweep-survives-and-measures.spec.ts` covers these cases: an undeletable entry between two deletable ones, another user's entry, a mount point, ENOTCONN, each system name, dry run equal to apply, the measure counts, and the exit codes.

## Gotchas

A sweep never removes a directory a live process holds. Family names only group lines in the report; they never decide what gets deleted. Dead mounts are skipped and counted, never unmounted. A status read that fails is treated as a mount point, so a broken FUSE mount stays where it is. A slot whose command is still running keeps counting against the semaphore after `semaphore run` itself is killed; that is the promise, not a leak.
