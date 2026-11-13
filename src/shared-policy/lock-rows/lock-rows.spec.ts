import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  countHeldLocks,
  isHeldByAnother,
  locksDatabasePath,
  processStartTime,
  releaseLock,
  stillOwnsLock,
  tryTakeLock,
  waitForLock,
} from "./lock-rows.ts";
import { assertEnteredOneAtATime, lockTestProcesses } from "./lock-test-support.ts";

const lockRowsModule = path.join(import.meta.dirname, "lock-rows.ts");
const { scratchThroneHome, runChild } = lockTestProcesses("lock-rows-");

function writeRow(throneHome: string, name: string, processId: number, startedAt: number | null, takenAt: number): void {
  countHeldLocks(throneHome, name);
  const connection = new Database(locksDatabasePath(throneHome));
  connection.prepare("insert into locks (name, holder_process_id, holder_started_at, taken_at) values (?, ?, ?, ?)")
    .run(name, processId, startedAt, takenAt);
  connection.close();
}

const parentProcess = { processId: process.ppid, startedAt: processStartTime(process.ppid) };

test("a holder killed with SIGKILL frees its lock for the next taker", async () => {
  const throneHome = await scratchThroneHome();
  const holder = runChild(`
    const { tryTakeLock } = await import(${JSON.stringify(lockRowsModule)});
    console.log(tryTakeLock(${JSON.stringify(throneHome)}, "build") === null ? "refused" : "held");
    setInterval(() => {}, 1000);
  `);
  assert.equal(await holder.firstLine, "held");
  assert.equal(tryTakeLock(throneHome, "build"), null);

  holder.child.kill("SIGKILL");
  await holder.exited;

  assert.notEqual(tryTakeLock(throneHome, "build"), null);
});

test("a row whose process number now belongs to a different process is taken over", async () => {
  const throneHome = await scratchThroneHome();
  writeRow(throneHome, "pane", parentProcess.processId, (parentProcess.startedAt ?? 0) + 1, Date.now());

  assert.notEqual(tryTakeLock(throneHome, "pane"), null);
});

test("a row held by a live process with its own start time is not taken", async () => {
  const throneHome = await scratchThroneHome();
  writeRow(throneHome, "pane", parentProcess.processId, parentProcess.startedAt, Date.now());

  assert.equal(tryTakeLock(throneHome, "pane"), null);
  assert.equal(isHeldByAnother(throneHome, "pane"), true);
});

test("two processes contending get the lock one at a time", async () => {
  const throneHome = await scratchThroneHome();
  const journal = path.join(throneHome, "journal");
  const contender = () => runChild(`
    const { appendFileSync } = await import("node:fs");
    const { waitForLock, releaseLock } = await import(${JSON.stringify(lockRowsModule)});
    for (let round = 0; round < 5; round += 1) {
      const held = await waitForLock(${JSON.stringify(throneHome)}, "suite", 10000);
      appendFileSync(${JSON.stringify(journal)}, "enter\\n");
      await new Promise((resolve) => setTimeout(resolve, 30));
      appendFileSync(${JSON.stringify(journal)}, "leave\\n");
      releaseLock(held);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    console.log("done");
  `);
  await assertEnteredOneAtATime([contender(), contender()], journal, 10);
});

test("many processes opening a fresh lock database at once all get the lock in turn", async () => {
  const throneHome = await scratchThroneHome();
  const journal = path.join(throneHome, "journal");
  const contenderCount = 16;
  const openAt = Date.now() + 2000;
  const contender = () => runChild(`
    const { appendFileSync } = await import("node:fs");
    const { waitForLock, releaseLock } = await import(${JSON.stringify(lockRowsModule)});
    while (Date.now() < ${openAt});
    const held = await waitForLock(${JSON.stringify(throneHome)}, "first-open", 20000);
    appendFileSync(${JSON.stringify(journal)}, "enter\\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    appendFileSync(${JSON.stringify(journal)}, "leave\\n");
    releaseLock(held);
  `);
  await assertEnteredOneAtATime(Array.from({ length: contenderCount }, contender), journal, contenderCount);
});

test("a lock past its maximum hold is taken over", async () => {
  const throneHome = await scratchThroneHome();
  writeRow(throneHome, "pane", parentProcess.processId, parentProcess.startedAt, Date.now() - 61_000);

  assert.equal(tryTakeLock(throneHome, "pane"), null);
  assert.equal(tryTakeLock(throneHome, "pane", 120_000), null);
  assert.notEqual(tryTakeLock(throneHome, "pane", 60_000), null);
});

test("a lock released by someone who no longer owns it stays with its owner", async () => {
  const throneHome = await scratchThroneHome();
  writeRow(throneHome, "pane", parentProcess.processId, parentProcess.startedAt, Date.now());

  releaseLock({ throneHome, name: "pane", processId: process.pid, startedAt: processStartTime(process.pid), takenAt: Date.now() });

  assert.equal(isHeldByAnother(throneHome, "pane"), true);
});

test("an owner sees its own lock, others see it held, and release frees it", async () => {
  const throneHome = await scratchThroneHome();
  const held = tryTakeLock(throneHome, "panes/one");
  assert.ok(held !== null);
  writeRow(throneHome, "panes/two", parentProcess.processId, parentProcess.startedAt, Date.now());
  writeRow(throneHome, "panes/gone", 2 ** 22 + 7, null, Date.now());

  assert.equal(stillOwnsLock(held), true);
  assert.equal(isHeldByAnother(throneHome, "panes/one"), false);
  assert.equal(countHeldLocks(throneHome, "panes/"), 2);

  releaseLock(held);

  assert.equal(stillOwnsLock(held), false);
  assert.equal(countHeldLocks(throneHome, "panes/"), 1);
});

test("waiting for a held lock gives up at its time limit", async () => {
  const throneHome = await scratchThroneHome();
  writeRow(throneHome, "pane", parentProcess.processId, parentProcess.startedAt, Date.now());

  assert.equal(await waitForLock(throneHome, "pane", 100), null);
});
