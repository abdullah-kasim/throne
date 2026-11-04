import assert from "node:assert/strict";
import { test } from "node:test";
import { runNestCommanderApplication } from "../application.ts";
import { THRONE_HOME_ENV } from "../shared-policy/throne-home.ts";
import { heldSlotsIn, semaphore, semaphoreRoom } from "./semaphore.test-support.ts";

test("the throne command line hands run everything after -- untouched, the command's own flags included", async (t) => {
  const room = await semaphoreRoom(t);
  const throneHomeBefore = process.env[THRONE_HOME_ENV];
  process.env[THRONE_HOME_ENV] = room.throneHome;
  t.after(() => {
    process.exitCode = 0;
    if (throneHomeBefore === undefined) delete process.env[THRONE_HOME_ENV];
    else process.env[THRONE_HOME_ENV] = throneHomeBefore;
  });
  await semaphore(room, "create", "ovens", "--slots", "1");

  const exitCode = await runNestCommanderApplication(["node", "tools.js", "semaphore", "run", "ovens", "--", "sh", "-c", "exit 3"]);

  assert.equal(exitCode, 3);
  assert.deepEqual(await heldSlotsIn(room, "ovens"), []);
});
