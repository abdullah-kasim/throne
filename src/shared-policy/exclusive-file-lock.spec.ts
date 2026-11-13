import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { tryExclusiveFileLock, withExclusiveFileLock } from "./exclusive-file-lock.ts";
import { assertEnteredOneAtATime, lockTestProcesses } from "./lock-rows/lock-test-support.ts";
import { THRONE_HOME_ENV } from "./throne-home.ts";

const exclusiveLockModule = path.join(import.meta.dirname, "exclusive-file-lock.ts");
const processes = lockTestProcesses("exclusive-file-lock-");
let throneHome = "";
const throneHomeBefore = process.env[THRONE_HOME_ENV];

before(async () => {
  throneHome = await processes.scratchThroneHome();
  process.env[THRONE_HOME_ENV] = throneHome;
});

after(() => {
  if (throneHomeBefore === undefined) delete process.env[THRONE_HOME_ENV];
  else process.env[THRONE_HOME_ENV] = throneHomeBefore;
});

function freshLockFile(name: string): string {
  return path.join(throneHome, `${name}.lock`);
}

function runChild(script: string) {
  return processes.runChild(script, { ...process.env, [THRONE_HOME_ENV]: throneHome });
}

function holdUntilKilled(file: string) {
  return runChild(`
    const { tryExclusiveFileLock } = await import(${JSON.stringify(exclusiveLockModule)});
    console.log((await tryExclusiveFileLock(${JSON.stringify(file)}, "test")) === undefined ? "refused" : "held");
    setInterval(() => {}, 1000);
  `);
}

test("an exclusive section held by a process killed with SIGKILL is free for the next caller", async () => {
  const file = freshLockFile("killed");
  const holder = holdUntilKilled(file);
  assert.equal(await holder.firstLine, "held");

  holder.child.kill("SIGKILL");
  await holder.exited;

  assert.equal(await withExclusiveFileLock(file, "test", async () => "ran"), "ran");
});

test("a try while another process holds the lock gets no lock", async () => {
  const file = freshLockFile("contended-try");
  const holder = holdUntilKilled(file);
  assert.equal(await holder.firstLine, "held");

  assert.equal(await tryExclusiveFileLock(file, "test"), undefined);

  holder.child.kill("SIGKILL");
  await holder.exited;
  const taken = await tryExclusiveFileLock(path.join(path.dirname(file), ".", path.basename(file)), "test");
  assert.notEqual(taken, undefined);
  await taken?.release();
});

test("two processes entering one exclusive section run it one at a time", async () => {
  const file = freshLockFile("section");
  const journal = path.join(throneHome, "journal");
  const contender = () => runChild(`
    const { appendFileSync } = await import("node:fs");
    const { withExclusiveFileLock } = await import(${JSON.stringify(exclusiveLockModule)});
    for (let round = 0; round < 5; round += 1) {
      await withExclusiveFileLock(${JSON.stringify(file)}, "test", async () => {
        appendFileSync(${JSON.stringify(journal)}, "enter\\n");
        await new Promise((resolve) => setTimeout(resolve, 30));
        appendFileSync(${JSON.stringify(journal)}, "leave\\n");
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  `);
  await assertEnteredOneAtATime([contender(), contender()], journal, 10);
});
