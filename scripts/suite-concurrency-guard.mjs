#!/usr/bin/env node
// Bounded (non-exclusive up to N=2) tmpfs concurrency semaphore for
// container-backed suite runs. Containers run `--userns=keep-id` — same uid,
// same per-uid tmpfs quota as the host — so nothing else stands between a
// pile of concurrent suites and EDQUOT now that the exclusive full-suite
// lock that used to serialize them has been retired. This is the
// caller-facing wrapper for container-backed suite runs (see
// scripts/run-suite-container.mjs); it does not decide what "a suite" is.
//
// Reuses the SAME flock primitive the (now-retired) exclusive full-suite
// lock used (kernel-backed atomic acquire/release, self-releasing on holder
// death — see suite-concurrency-guard-inner.mjs, reused here verbatim as
// the inner lock-holding process), generalized from one exclusive slot to N
// independent slot files: tried non-blockingly in turn first, then blocked
// on in rotation if every slot was held. No counting semaphore was invented
// from scratch: N flock files IS the semaphore.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHolderReportLines,
  isHolderVerified,
} from "./suite-concurrency-guard-refusal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Reused as-is: it only ever runs a command and writes/cleans a best-effort
// diagnostic meta file at a path it's handed — nothing about it is specific
// to the exclusive lock, so no new inner script is needed for N slots.
const innerScript = path.join(here, "suite-concurrency-guard-inner.mjs");

// MANDATORY (Regent, non-negotiable — do not raise this number without also
// reading and updating the reason not to): the tmpfs backing /tmp on this
// box enforces a per-uid quota, and that quota is SHARED ACROSS EVERY
// PROCESS RUNNING AS THIS USER — it is not allocated per-suite, per-agent,
// or per-worktree. Every concurrent container-backed suite run consumes
// against the same shared ceiling as every other agent's Bash tool calls on
// this box. Exceeding it produces EDQUOT, which does not fail a test — it
// kills the Bash tool outright for whoever hit the quota (see
// TMPFS_EDQUOT_PER_USER_QUOTA_KILLS_BASH.md). cap=2 is the bound on how many
// suites may hold a tmpfs concurrency slot at once, chosen to leave the
// shared quota enough headroom for ordinary Bash-tool tmpfs use elsewhere on
// the box while still letting suites run concurrently at all.
export const SLOT_CAP = 2;

// PLACEHOLDER — UNMEASURED. This is a conservative starting guess, not a
// calibrated number: a clean per-suite tmp-delta measurement requires a
// running container-backed suite to measure against, which did not exist
// while this guard was authored. Whoever raises or lowers this must replace
// it with a real measurement, not just adjust the guess.
export const EXPECTED_SUITE_SCRATCH_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB, unmeasured guess

// Distinct from the (now-retired) exclusive full-suite lock's
// CONFLICT_EXIT_CODE (91) so the two guards' conflict signals can never be
// confused if ever composed.
export const SLOT_CONFLICT_EXIT_CODE = 92;

export function getConcurrencyLockDir() {
  return (
    process.env.THRONE_SUITE_CONCURRENCY_LOCK_DIR ??
    path.join(os.homedir(), ".throne", "locks", "suite-concurrency")
  );
}

export function getSlotLockPath(lockDir, index) {
  return path.join(lockDir, `slot-${index}.lock`);
}

export function getSlotHolderPath(lockDir, index) {
  return path.join(lockDir, `slot-${index}.holder.json`);
}

// The scratch dir whose free space is checked against the floor. Overridable
// so tests can point this at a tmpdir with a controlled/fakeable statfs
// result instead of the box's real /tmp.
export function getScratchCheckDir() {
  return process.env.THRONE_SUITE_CONCURRENCY_SCRATCH_DIR ?? os.tmpdir();
}

export function getFreeBytes(dir) {
  const stats = statfsSync(dir);
  return stats.bsize * stats.bavail;
}

/**
 * Pure floor check: free_tmp >= cap * expected_suite_scratch. Kept separate
 * from any real statfs call so tests can exercise the below-floor refusal
 * with fake byte counts instead of genuinely exhausting /tmp.
 */
export function checkFreeSpaceFloor(
  freeBytes,
  cap = SLOT_CAP,
  expectedSuiteScratchBytes = EXPECTED_SUITE_SCRATCH_BYTES,
) {
  const floorBytes = cap * expectedSuiteScratchBytes;
  return { ok: freeBytes >= floorBytes, floorBytes, freeBytes };
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
}

function printFloorRefusal(floor) {
  process.stderr.write(
    [
      "",
      "REFUSED: free /tmp space is below the tmpfs concurrency floor.",
      `  Free now:  ${formatBytes(floor.freeBytes)}`,
      `  Floor:     ${formatBytes(floor.floorBytes)} (cap=${SLOT_CAP} * expected_suite_scratch=${formatBytes(EXPECTED_SUITE_SCRATCH_BYTES)})`,
      "",
      "This floor exists because the per-uid tmpfs quota is shared across",
      "every process running as this user, not allocated per-suite —",
      "starting a suite below the floor risks EDQUOT, which kills the Bash",
      "tool outright rather than failing a test. Do not retry this command",
      "until free space recovers. If this fires spuriously, escalate to the",
      "Regent rather than lowering the floor or retrying blindly.",
      "",
    ].join("\n"),
  );
}

// Shared by the queueing notice below — describes who currently holds each
// of the SLOT_CAP slots, verified against the kernel rather than trusted
// blindly (see isHolderVerified).
function describeHeldSlots(lockDir) {
  const holderBlocks = [];
  for (let i = 0; i < SLOT_CAP; i++) {
    const lockPath = getSlotLockPath(lockDir, i);
    const metaPath = getSlotHolderPath(lockDir, i);
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      meta = null;
    }
    const verified = meta ? isHolderVerified(meta, lockPath, spawnSync) : false;
    holderBlocks.push(`  Slot ${i}:`, ...buildHolderReportLines(meta, verified, Date.now()).map((l) => `  ${l}`));
  }
  return holderBlocks;
}

function printQueueingNotice(lockDir) {
  process.stderr.write(
    [
      "",
      `QUEUEING: all ${SLOT_CAP} tmpfs concurrency slots are already held —`,
      "waiting for one to free rather than refusing outright (contention,",
      "not exhaustion — the free-space floor above is the exhaustion case).",
      ...describeHeldSlots(lockDir),
      "",
      `Only ${SLOT_CAP} container-backed suites may hold a tmpfs concurrency`,
      "slot at once — the per-uid tmpfs quota is shared, not per-suite, and",
      "exceeding it produces EDQUOT rather than a clean test failure. This",
      "process will block here and proceed automatically once a slot frees.",
      "",
      "Each slot is a kernel-held flock scoped to its holder process's",
      "lifetime — it self-releases the moment that process is truly gone.",
      "",
    ].join("\n"),
  );
}

// Every slot attempt — nonblocking or the blocking rotation below — runs
// the same flock-wrapped inner script against the same slot files, so the
// spawn call itself lives in one place.
function attemptSlot(lockDir, index, commandArgs, flockArgs) {
  const lockPath = getSlotLockPath(lockDir, index);
  const metaPath = getSlotHolderPath(lockDir, index);
  return spawnSync(
    "flock",
    [...flockArgs, lockPath, "node", innerScript, metaPath, ...commandArgs],
    { stdio: "inherit", env: process.env },
  );
}

function reportFlockMissing(error) {
  console.error(
    `suite-concurrency-guard: could not invoke flock (${error.message}). ` +
      "Is util-linux's flock installed?",
  );
}

// Bounds each blocking attempt on one slot before rotating to try the
// sibling slot instead — otherwise a caller could park on one slot file
// indefinitely while the OTHER slot frees up and sits idle. `flock`'s own
// `--conflict-exit-code` applies to a timeout exactly like it applies to a
// `--nonblock` conflict (util-linux flock(1): "exit code after conflict OR
// TIMEOUT"), so a rotation is distinguishable from the wrapped command's
// own exit status without inventing any JS-side sleep/retry logic — every
// wait here is a real kernel flock wait, just bounded so it can move on to
// the next slot. Rotating through all SLOT_CAP slots in a loop, forever,
// cannot deadlock: each slot is an independent kernel-held flock that
// self-releases the instant its holder process exits, so some slot always
// becomes acquirable in finite time.
const BLOCKING_SLOT_ROTATE_TIMEOUT_SECONDS = 5;

/**
 * Blocks until one of the SLOT_CAP slots frees, then runs commandArgs
 * through it, and returns that run's exit code — the queue-and-wait
 * counterpart to the nonblocking attempts main() tries first.
 */
export function acquireConcurrencySlotBlocking(lockDir, commandArgs) {
  printQueueingNotice(lockDir);
  for (;;) {
    for (let i = 0; i < SLOT_CAP; i++) {
      const result = attemptSlot(lockDir, i, commandArgs, [
        "--exclusive",
        "--timeout",
        String(BLOCKING_SLOT_ROTATE_TIMEOUT_SECONDS),
        "--conflict-exit-code",
        String(SLOT_CONFLICT_EXIT_CODE),
      ]);

      if (result.error) {
        reportFlockMissing(result.error);
        return 1;
      }

      if (result.status === SLOT_CONFLICT_EXIT_CODE) {
        continue; // still held, or this rotation's wait timed out — try the next slot
      }

      return result.status ?? 1;
    }
  }
}

function main() {
  const commandArgs = process.argv.slice(2);
  if (commandArgs.length === 0) {
    console.error("usage: suite-concurrency-guard.mjs <command> [args...]");
    process.exit(2);
  }

  const scratchDir = getScratchCheckDir();
  const fakeFreeBytes = process.env.THRONE_SUITE_CONCURRENCY_FREE_BYTES;
  const freeBytes =
    fakeFreeBytes !== undefined ? Number(fakeFreeBytes) : getFreeBytes(scratchDir);
  const floor = checkFreeSpaceFloor(freeBytes);
  if (!floor.ok) {
    printFloorRefusal(floor);
    process.exit(1);
  }

  const lockDir = getConcurrencyLockDir();
  mkdirSync(lockDir, { recursive: true });

  for (let i = 0; i < SLOT_CAP; i++) {
    const result = attemptSlot(lockDir, i, commandArgs, [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      String(SLOT_CONFLICT_EXIT_CODE),
    ]);

    if (result.error) {
      reportFlockMissing(result.error);
      process.exit(1);
    }

    if (result.status === SLOT_CONFLICT_EXIT_CODE) {
      continue; // this slot is held — try the next one
    }

    process.exit(result.status ?? 1);
  }

  // Every slot was held at that instant — this is contention (other
  // campaigns' suite runs), not exhaustion, so queue and wait for one to
  // free instead of refusing outright.
  process.exit(acquireConcurrencySlotBlocking(lockDir, commandArgs));
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
