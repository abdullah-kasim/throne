import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SLOT_CAP, getSlotLockPath } from "./suite-concurrency-guard.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const guardScript = path.join(scriptsDirectory, "suite-concurrency-guard.mjs");
const typescriptLoader = path.join(scriptsDirectory, "..", "test", "register-typescript.mjs");
const admittedRunExitCode = 7;

async function createLockDirectory(t: test.TestContext) {
  const lockDirectory = await mkdtemp(path.join(tmpdir(), "suite-concurrency-guard-"));
  t.after(() => rm(lockDirectory, { recursive: true, force: true }));
  return lockDirectory;
}

async function holdSlot(t: test.TestContext, lockDirectory: string, index: number) {
  const holder = spawn(
    "flock",
    ["--exclusive", "--nonblock", getSlotLockPath(lockDirectory, index), "node", "-e", "console.log('held'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => {
    try {
      process.kill(-holder.pid!, "SIGKILL");
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (chunk) => {
      if (String(chunk).includes("held")) resolve();
    });
    holder.on("exit", (code) => reject(new Error(`slot ${index} holder exited with ${code}`)));
  });
}

function runThroughGuard(lockDirectory: string, timeoutMilliseconds: number) {
  return spawnSync(
    process.execPath,
    ["--import", typescriptLoader, guardScript, process.execPath, "-e", `process.exit(${admittedRunExitCode})`],
    {
      encoding: "utf8",
      timeout: timeoutMilliseconds,
      env: {
        ...process.env,
        THRONE_SUITE_CONCURRENCY_LOCK_DIR: lockDirectory,
        THRONE_SUITE_CONCURRENCY_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
      },
    },
  );
}

test("the suite admits as many concurrent runs as the measured tmpfs headroom allows", async (t) => {
  assert.equal(SLOT_CAP, 3);
  const lockDirectory = await createLockDirectory(t);
  await holdSlot(t, lockDirectory, 0);
  await holdSlot(t, lockDirectory, 1);

  const thirdRun = runThroughGuard(lockDirectory, 8000);
  assert.equal(thirdRun.status, admittedRunExitCode, thirdRun.stderr);

  await holdSlot(t, lockDirectory, 2);
  const fourthRun = runThroughGuard(lockDirectory, 3000);
  assert.equal(fourthRun.status, null);
  assert.match(fourthRun.stderr, /QUEUEING: all 3 tmpfs concurrency slots are already held/);
});
