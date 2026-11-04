import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as waitFor } from "node:timers/promises";
import { SemaphoreExitCode } from "./semaphore-runtime.ts";
import { takeFirstFreeSlot } from "./semaphore-store.ts";
import {
  everyHolderRecorded,
  heldSlotsIn,
  semaphore,
  semaphoreRoom,
  SHORT_RETRY_MILLISECONDS,
  stopHolderOf,
  stopHolderWhenTestEnds,
  untilHeldSlotsAre,
  type SemaphoreRoom,
} from "./semaphore.test-support.ts";

const SEVERAL_RETRIES_MILLISECONDS = SHORT_RETRY_MILLISECONDS * 10;
const TERMINATED_EXIT_CODE = 143;

function holdASlot(room: SemaphoreRoom, name: string, seconds: number): Promise<number> {
  return semaphore(room, "run", name, "--", "sleep", String(seconds));
}

async function fillTwoSlotOvens(t: TestContext) {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "2");
  const firstRuns = [holdASlot(room, "ovens", 30), holdASlot(room, "ovens", 30)];
  const held = await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(2));
  stopHolderWhenTestEnds(t, held);
  return { room, firstRuns, held };
}

function statusAsJson(room: SemaphoreRoom): unknown {
  return JSON.parse(room.printed.at(-1) ?? "");
}

function waitingLinesSince(room: SemaphoreRoom, mark: number): string[] {
  return room.complaints.slice(mark).filter((line) => line.includes("waiting for a free slot"));
}

test("a created semaphore reports the slot count it was created with", async (t) => {
  const room = await semaphoreRoom(t);

  assert.equal(await semaphore(room, "create", "ovens", "--slots", "4"), SemaphoreExitCode.Done);
  assert.equal(await semaphore(room, "status", "ovens", "--json"), SemaphoreExitCode.Done);

  assert.deepEqual(statusAsJson(room), { semaphores: [{ name: "ovens", slots: 4, heldSlots: [] }] });
  assert.deepEqual((await readdir(path.join(room.throneHome, "semaphores", "ovens"))).sort(), ["slots"]);
});

test("creating an existing semaphore again changes its slot count and a held slot stays held", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");
  const run = holdASlot(room, "ovens", 30);
  const held = await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(1));
  stopHolderWhenTestEnds(t, held);

  assert.equal(await semaphore(room, "create", "ovens", "--slots", "3"), SemaphoreExitCode.Done);

  assert.deepEqual(await heldSlotsIn(room, "ovens"), held);
  await semaphore(room, "status", "ovens", "--json");
  assert.equal((statusAsJson(room) as { semaphores: { slots: number }[] }).semaphores[0]?.slots, 3);
  stopHolderOf(held[0]!);
  assert.equal(await run, TERMINATED_EXIT_CODE);
});

test("a semaphore name with anything but letters, digits and dashes is refused", async (t) => {
  const room = await semaphoreRoom(t);

  for (const badName of ["ovens/upstairs", "oven_1", "ovens.", "fours four", ""]) {
    assert.equal(await semaphore(room, "create", badName, "--slots", "2"), SemaphoreExitCode.InvalidInvocation, badName);
  }

  assert.match(room.complaints.join(""), /is not a semaphore name: use only ASCII letters, digits and dashes/);
  await assert.rejects(access(path.join(room.throneHome, "semaphores")));
});

test("a slot count that is not a positive whole number is refused", async (t) => {
  const room = await semaphoreRoom(t);

  for (const badCount of ["0", "-2", "2.5", "1e3", "two", "+3", "03", ""]) {
    assert.equal(await semaphore(room, "create", "ovens", "--slots", badCount), SemaphoreExitCode.InvalidInvocation, badCount);
  }
  assert.equal(await semaphore(room, "create", "ovens"), SemaphoreExitCode.InvalidInvocation);

  assert.match(room.complaints.join(""), /--slots takes a positive whole number/);
  await assert.rejects(access(path.join(room.throneHome, "semaphores")));
});

test("n commands run at once on n slots and the next one waits until one exits", async (t) => {
  const { room, firstRuns, held } = await fillTwoSlotOvens(t);

  const waitingRun = holdASlot(room, "ovens", 31);
  await waitFor(SEVERAL_RETRIES_MILLISECONDS);
  assert.deepEqual(await heldSlotsIn(room, "ovens"), held);

  stopHolderOf(held[1]!);
  const nowHeld = await untilHeldSlotsAre(room, "ovens", (slots) => slots.some((slot) => slot.holder?.commandLine === "sleep 31"));
  stopHolderWhenTestEnds(t, nowHeld);
  assert.deepEqual(
    nowHeld.map((slot) => [slot.slot, slot.holder?.commandLine]),
    [[1, "sleep 30"], [2, "sleep 31"]],
  );
  for (const slot of nowHeld) stopHolderOf(slot);
  assert.deepEqual(await Promise.all([...firstRuns, waitingRun]), [TERMINATED_EXIT_CODE, TERMINATED_EXIT_CODE, TERMINATED_EXIT_CODE]);
});

test("a waiting run prints one line saying it waits and for which semaphore", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");
  const firstRun = holdASlot(room, "ovens", 30);
  const held = await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(1));
  stopHolderWhenTestEnds(t, held);

  const mark = room.complaints.length;
  const waitingRun = semaphore(room, "run", "ovens", "--", "true");
  await waitFor(SEVERAL_RETRIES_MILLISECONDS);
  stopHolderOf(held[0]!);

  assert.deepEqual(await Promise.all([firstRun, waitingRun]), [TERMINATED_EXIT_CODE, SemaphoreExitCode.Done]);
  assert.deepEqual(waitingLinesSince(room, mark), ['throne semaphore: waiting for a free slot of "ovens" (1 slots, all held)\n']);
});

test("a command's exit code is the exit code of the run", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");

  assert.equal(await semaphore(room, "run", "ovens", "--", "sh", "-c", "exit 3"), 3);
  assert.equal(await semaphore(room, "run", "ovens", "--", "true"), 0);
  assert.deepEqual(await heldSlotsIn(room, "ovens"), []);
});

test("a command killed by a signal makes the run exit with 128 plus the signal number", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");

  assert.equal(await semaphore(room, "run", "ovens", "--", "sh", "-c", "kill -TERM $$"), 128 + 15);
  assert.equal(await semaphore(room, "run", "ovens", "--", "sh", "-c", "kill -KILL $$"), 128 + 9);
});

test("a command that cannot be started exits 127 and frees the slot", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");

  assert.equal(await semaphore(room, "run", "ovens", "--", "no-such-command-in-any-oven"), 127);

  assert.match(room.complaints.join(""), /could not start "no-such-command-in-any-oven"/);
  assert.deepEqual(await heldSlotsIn(room, "ovens"), []);
});

test("running an unknown semaphore is refused with the create command to run", async (t) => {
  const room = await semaphoreRoom(t);

  assert.equal(await semaphore(room, "run", "ovens", "--", "true"), SemaphoreExitCode.InvalidInvocation);

  assert.match(room.complaints.join(""), /there is no semaphore "ovens"; create it first: throne semaphore create ovens --slots <n>/);
});

test("status lists each held slot with its holder's pid, command line and start time", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "2");
  await semaphore(room, "create", "tills", "--slots", "1");
  const run = holdASlot(room, "ovens", 30);
  const [held] = await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(1));
  stopHolderWhenTestEnds(t, [held!]);

  assert.equal(await semaphore(room, "status"), SemaphoreExitCode.Done);

  assert.equal(
    room.printed.at(-1),
    `ovens: 2 slots, 1 held\n  slot 1: pid ${held!.holder!.pid}, started ${held!.holder!.startedAt}, sleep 30\ntills: 1 slots, 0 held\n`,
  );
  assert.ok(!Number.isNaN(Date.parse(held!.holder!.startedAt)));
  stopHolderOf(held!);
  await run;
});

test("a slot taken again shows no holder until its new command starts, never the holder before it", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");
  assert.equal(await semaphore(room, "run", "ovens", "--", "true"), SemaphoreExitCode.Done);

  const taken = await takeFirstFreeSlot(room.throneHome, "ovens", 1);
  t.after(() => taken?.lock.release());

  assert.deepEqual(await heldSlotsIn(room, "ovens"), [{ slot: 1, holder: undefined }]);
});

test("status --json gives the same holders as JSON", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "2");
  const run = holdASlot(room, "ovens", 30);
  const held = await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(1));
  stopHolderWhenTestEnds(t, held);

  assert.equal(await semaphore(room, "status", "--json"), SemaphoreExitCode.Done);

  assert.deepEqual(statusAsJson(room), {
    semaphores: [{ name: "ovens", slots: 2, heldSlots: [{ slot: 1, holder: held[0]!.holder }] }],
  });
  assert.equal(held[0]!.holder!.commandLine, "sleep 30");
  stopHolderOf(held[0]!);
  await run;
});

test("status of a semaphore that does not exist exits 1", async (t) => {
  const room = await semaphoreRoom(t);

  assert.equal(await semaphore(room, "status", "ovens"), SemaphoreExitCode.Missing);
  assert.equal(await semaphore(room, "status"), SemaphoreExitCode.Done);

  assert.match(room.complaints.join(""), /there is no semaphore "ovens"/);
  assert.equal(room.printed.at(-1), "no semaphores\n");
});

test("lowering the slot count below the number held leaves the holders running and never offers the higher slots again", async (t) => {
  const { room, firstRuns, held } = await fillTwoSlotOvens(t);

  await semaphore(room, "create", "ovens", "--slots", "1");
  assert.deepEqual(await heldSlotsIn(room, "ovens"), held);

  stopHolderOf(held[1]!);
  await untilHeldSlotsAre(room, "ovens", (slots) => slots.length === 1);
  const mark = room.complaints.length;
  const waitingRun = holdASlot(room, "ovens", 31);
  await waitFor(SEVERAL_RETRIES_MILLISECONDS);
  assert.deepEqual(await heldSlotsIn(room, "ovens"), [held[0]]);
  assert.equal(waitingLinesSince(room, mark).length, 1);

  stopHolderOf(held[0]!);
  const [nowHeld] = await untilHeldSlotsAre(room, "ovens", (slots) => slots[0]?.holder?.commandLine === "sleep 31");
  stopHolderWhenTestEnds(t, [nowHeld!]);
  assert.equal(nowHeld!.slot, 1);
  stopHolderOf(nowHeld!);
  assert.deepEqual(await Promise.all([...firstRuns, waitingRun]), [TERMINATED_EXIT_CODE, TERMINATED_EXIT_CODE, TERMINATED_EXIT_CODE]);
});

test("a child the command leaves running keeps the slot held until that child exits", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");
  const childPidFile = path.join(room.throneHome, "left-running.pid");

  assert.equal(await semaphore(room, "run", "ovens", "--", "sh", "-c", `sleep 30 & echo $! > ${childPidFile}`), 0);
  const leftRunning = Number(await readFile(childPidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(leftRunning, "SIGTERM");
    } catch {
      return;
    }
  });

  assert.equal((await heldSlotsIn(room, "ovens")).length, 1);
  process.kill(leftRunning, "SIGTERM");
  await untilHeldSlotsAre(room, "ovens", (slots) => slots.length === 0);
});
