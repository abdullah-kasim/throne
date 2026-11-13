import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SLOT_CAP, slotLockName } from "./suite-concurrency-guard.mjs";
import { isHeldByAnother, tryTakeLock } from "../src/shared-policy/lock-rows/lock-rows.ts";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const guardScript = path.join(scriptsDirectory, "suite-concurrency-guard.mjs");
const admittedRunExitCode = 7;
const children: ChildProcess[] = [];
const suiteProcessIds: number[] = [];

test.after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const processId of suiteProcessIds) {
    try {
      process.kill(processId, "SIGKILL");
    } catch {
      continue;
    }
  }
});

async function scratchThroneHome(t: test.TestContext) {
  const throneHome = await mkdtemp(path.join(tmpdir(), "suite-concurrency-guard-"));
  t.after(() => rm(throneHome, { recursive: true, force: true }));
  return throneHome;
}

function startThroughGuard(throneHome: string, script: string) {
  const child = spawn(process.execPath, [guardScript, process.execPath, "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      THRONE_DATA_HOME: throneHome,
      THRONE_SUITE_CONCURRENCY_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
    },
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
    if (/^\d+\n/.test(stdout)) suiteProcessIds.push(Number(stdout.trim()));
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const printed = (text: string) =>
    new Promise<void>((resolve) => {
      const check = () => (stdout.includes(text) ? resolve() : setTimeout(check, 20));
      check();
    });
  return { child, exited, printed, stdout: () => stdout, stderr: () => stderr };
}

const holdForever = "console.log(process.pid); setInterval(() => {}, 1000)";

test("two suite runs beyond the slot count wait or are refused as before", async (t) => {
  assert.equal(SLOT_CAP, 3);
  const throneHome = await scratchThroneHome(t);
  const holders = [0, 1, 2].map(() => startThroughGuard(throneHome, holdForever));
  await Promise.all(holders.map((holder) => holder.printed("\n")));

  const fourth = startThroughGuard(throneHome, `process.exit(${admittedRunExitCode})`);
  const fifth = startThroughGuard(throneHome, `process.exit(${admittedRunExitCode})`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fourth.child.exitCode, null);
  assert.equal(fifth.child.exitCode, null);
  assert.match(fourth.stderr(), /QUEUEING: all 3 tmpfs concurrency slots are already held/);

  process.kill(Number(holders[0]!.stdout().trim()), "SIGKILL");
  process.kill(Number(holders[1]!.stdout().trim()), "SIGKILL");
  assert.equal(await fourth.exited, admittedRunExitCode);
  assert.equal(await fifth.exited, admittedRunExitCode);
});

test("a suite holder killed with SIGKILL frees its slot", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const run = startThroughGuard(throneHome, holdForever);
  await run.printed("\n");
  const suiteProcessId = Number(run.stdout().trim());

  run.child.kill("SIGKILL");
  await run.exited;
  assert.equal(isHeldByAnother(throneHome, slotLockName(0)), true);

  process.kill(suiteProcessId, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.notEqual(tryTakeLock(throneHome, slotLockName(0)), null);
});
