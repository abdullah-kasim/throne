import assert from "node:assert/strict";
import { once } from "node:events";
import { text as readStreamAsText } from "node:stream/consumers";
import { test } from "node:test";
import { setTimeout as waitFor } from "node:timers/promises";
import {
  everyHolderRecorded,
  heldSlotsIn,
  runInAnotherProcess,
  semaphore,
  semaphoreRoom,
  stopHolderOf,
  stopHolderWhenTestEnds,
  untilHeldSlotsAre,
} from "./semaphore.test-support.ts";

const SETTLE_MILLISECONDS = 200;
const FORWARDED_SIGNALS = [
  { signal: "SIGTERM", exitCode: 128 + 15 },
  { signal: "SIGINT", exitCode: 128 + 2 },
  { signal: "SIGHUP", exitCode: 128 + 1 },
] as const;

test("running a command through a semaphore passes its input and output straight through and frees the slot when it ends", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");

  const runner = runInAnotherProcess(t, room, ["ovens", "--", "sh", "-c", "cat; echo baked"]);
  runner.stdin!.end("dough\n");
  const printed = readStreamAsText(runner.stdout!);
  const [exitCode] = (await once(runner, "exit")) as [number | null];

  assert.equal(exitCode, 0);
  assert.equal(await printed, "dough\nbaked\n");
  assert.deepEqual(await heldSlotsIn(room, "ovens"), []);
});

for (const { signal, exitCode } of FORWARDED_SIGNALS) {
  test(`a ${signal} sent to the run reaches the command`, async (t) => {
    const room = await semaphoreRoom(t);
    await semaphore(room, "create", "ovens", "--slots", "1");
    const runner = runInAnotherProcess(t, room, ["ovens", "--", "sleep", "30"]);
    stopHolderWhenTestEnds(t, await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(1)));

    const exited = once(runner, "exit");
    runner.kill(signal);
    await exited;

    assert.deepEqual([runner.exitCode, runner.signalCode], [exitCode, null]);
    assert.deepEqual(await heldSlotsIn(room, "ovens"), []);
  });
}

test("killing the run process with SIGKILL keeps the slot held until the command exits", async (t) => {
  const room = await semaphoreRoom(t);
  await semaphore(room, "create", "ovens", "--slots", "1");
  const runner = runInAnotherProcess(t, room, ["ovens", "--", "sleep", "30"]);
  const held = await untilHeldSlotsAre(room, "ovens", everyHolderRecorded(1));
  stopHolderWhenTestEnds(t, held);

  const exited = once(runner, "exit");
  runner.kill("SIGKILL");
  await exited;
  await waitFor(SETTLE_MILLISECONDS);

  assert.equal(runner.signalCode, "SIGKILL");
  assert.deepEqual(await heldSlotsIn(room, "ovens"), held);
  stopHolderOf(held[0]!);
  await untilHeldSlotsAre(room, "ovens", (slots) => slots.length === 0);
});
