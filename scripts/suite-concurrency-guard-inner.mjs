#!/usr/bin/env node
// Executed BY `flock` as the process that HOLDS the exclusive lock — see
// suite-concurrency-guard.mjs, which execs this file as flock's target command.
//
// Because flock forks/execs this process with the lock's file descriptor
// inherited, the lock's lifetime IS this process's lifetime: the kernel
// releases it the instant this process exits, for ANY reason, including a
// SIGKILL against a dead pane. That is the entire self-heal story for this
// lock. There is no marker file with a staleness timestamp to age out and no
// rename-based reclaim step to get subtly wrong (see `acquireResurrectLock`
// in src/regent-state/regent-state.service.ts for what that costs when the
// holder is NOT a single live process for the whole critical section — this
// lock's holder is exactly that, a single `node --test` invocation running
// start to finish, so the kernel can enforce the guarantee directly and no
// hand-written identity check is needed).
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [metaPath, command, ...commandArgs] = process.argv.slice(2);
if (!metaPath || !command) {
  console.error(
    "usage: suite-concurrency-guard-inner.mjs <meta-path> <command> [args...]",
  );
  process.exit(2);
}

// Best-effort diagnostic only — read solely by the guard's refusal message.
// Never load-bearing for correctness: the lock itself is enforced by the
// kernel regardless of whether this write lands.
const holder = process.env.THRONE_AGENT_NAME ?? path.basename(process.cwd());
try {
  writeFileSync(
    metaPath,
    `${JSON.stringify({
      holder,
      pid: process.pid,
      cwd: process.cwd(),
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    })}\n`,
  );
} catch {
  // Diagnostics only; never block the actual run over a metadata write.
}

// Best-effort diagnostic cleanup only — mirrors the write above. Never
// load-bearing for correctness: the kernel flock releases regardless of
// whether this unlink runs or lands. Swallow ENOENT: the write above may
// never have succeeded in the first place.
function cleanupHolderFile() {
  try {
    unlinkSync(metaPath);
  } catch {
    // Diagnostics only; never block the actual run over a metadata unlink.
  }
}

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  env: process.env,
});
if (result.error) {
  console.error(
    `suite-concurrency-guard-inner: failed to run ${command}: ${result.error.message}`,
  );
  cleanupHolderFile();
  process.exit(1);
}
if (result.signal) {
  // Killed (e.g. SIGKILL of a dead pane) — exit non-zero; the lock releases
  // the instant this process itself dies, which is the release path this
  // script exists to prove out, not a special case to handle. This process
  // is still alive to receive the signal (a true SIGKILL of a dead pane
  // kills a process that never runs this line at all — that case is out of
  // scope, the kernel flock alone handles it), so cleanup still runs here.
  cleanupHolderFile();
  process.exit(1);
}
cleanupHolderFile();
process.exit(result.status ?? 1);
