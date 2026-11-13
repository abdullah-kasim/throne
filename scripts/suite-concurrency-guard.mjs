#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHeldByAnother, tryTakeLock } from "../src/shared-policy/lock-rows/lock-rows.ts";
import { resolveThroneHome } from "../src/shared-policy/throne-home.ts";
import { runWhileHolding } from "./hold-lock.mjs";
import { buildHolderReportLines } from "./suite-concurrency-guard-refusal.mjs";

// MANDATORY (Regent, non-negotiable — do not raise this number without also
// reading and updating the reason not to): the tmpfs backing /tmp on this
// box enforces a per-uid quota, and that quota is SHARED ACROSS EVERY
// PROCESS RUNNING AS THIS USER — it is not allocated per-suite, per-agent,
// or per-worktree. Every concurrent container-backed suite run consumes
// against the same shared ceiling as every other agent's Bash tool calls on
// this box. Exceeding it produces EDQUOT, which does not fail a test — it
// kills the Bash tool outright for whoever hit the quota (see
// TMPFS_EDQUOT_PER_USER_QUOTA_KILLS_BASH.md).
export const SLOT_CAP = 3;

// PLACEHOLDER — UNMEASURED. This is a conservative starting guess, not a
// calibrated number: a clean per-suite tmp-delta measurement requires a
// running container-backed suite to measure against, which did not exist
// while this guard was authored. Whoever raises or lowers this must replace
// it with a real measurement, not just adjust the guess.
export const EXPECTED_SUITE_SCRATCH_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB, unmeasured guess

export function getHolderDirectory(throneHome) {
  return path.join(throneHome, "locks", "suite-concurrency");
}

export function slotLockName(index) {
  return `suite-concurrency-slot-${index}`;
}

export function getSlotHolderPath(holderDirectory, index) {
  return path.join(holderDirectory, `slot-${index}.holder.json`);
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

function describeHeldSlots(throneHome) {
  const holderBlocks = [];
  for (let i = 0; i < SLOT_CAP; i++) {
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(getSlotHolderPath(getHolderDirectory(throneHome), i), "utf8"));
    } catch {
      meta = null;
    }
    const verified = meta !== null && isHeldByAnother(throneHome, slotLockName(i));
    holderBlocks.push(`  Slot ${i}:`, ...buildHolderReportLines(meta, verified, Date.now()).map((l) => `  ${l}`));
  }
  return holderBlocks;
}

function printQueueingNotice(throneHome) {
  process.stderr.write(
    [
      "",
      `QUEUEING: all ${SLOT_CAP} tmpfs concurrency slots are already held —`,
      "waiting for one to free rather than refusing outright (contention,",
      "not exhaustion — the free-space floor above is the exhaustion case).",
      ...describeHeldSlots(throneHome),
      "",
      `Only ${SLOT_CAP} container-backed suites may hold a tmpfs concurrency`,
      "slot at once — the per-uid tmpfs quota is shared, not per-suite, and",
      "exceeding it produces EDQUOT rather than a clean test failure. This",
      "process will block here and proceed automatically once a slot frees.",
      "",
      "Each slot is a lock row naming the running suite's process, so it",
      "frees the moment that process is gone.",
      "",
    ].join("\n"),
  );
}

const SLOT_RETRY_INTERVAL_MS = 250;

function tryTakeAnySlot(throneHome) {
  for (let i = 0; i < SLOT_CAP; i++) {
    const held = tryTakeLock(throneHome, slotLockName(i));
    if (held !== null) return { held, index: i };
  }
  return null;
}

export async function waitForAnySlot(throneHome) {
  let slot = tryTakeAnySlot(throneHome);
  if (slot !== null) return slot;
  printQueueingNotice(throneHome);
  while (slot === null) {
    await new Promise((resolve) => setTimeout(resolve, SLOT_RETRY_INTERVAL_MS));
    slot = tryTakeAnySlot(throneHome);
  }
  return slot;
}

function writeHolderFile(holderPath) {
  try {
    writeFileSync(
      holderPath,
      `${JSON.stringify({
        holder: process.env.THRONE_AGENT_NAME ?? path.basename(process.cwd()),
        pid: process.pid,
        cwd: process.cwd(),
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch {
    return;
  }
}

async function main() {
  const [command, ...commandArgs] = process.argv.slice(2);
  if (command === undefined) {
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

  const throneHome = resolveThroneHome();
  const holderDirectory = getHolderDirectory(throneHome);
  mkdirSync(holderDirectory, { recursive: true });
  const { held, index } = await waitForAnySlot(throneHome);
  const holderPath = getSlotHolderPath(holderDirectory, index);
  writeHolderFile(holderPath);
  const exitCode = await runWhileHolding(held, command, commandArgs);
  rmSync(holderPath, { force: true });
  process.exit(exitCode);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
