import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationTransport } from "../notify-lord/notification.service.ts";
import {
  createCourtLivenessAlert,
  type ReportCourtLivenessTick,
} from "./court-liveness-alert.ts";

const rosterUnreadable = "the agent roster could not be read";
const resurrectionRefused = "the Regent resurrection could not be queued";
const noFailure = undefined;

interface AlertUnderTest {
  readonly reportTick: ReportCourtLivenessTick;
  readonly postedMessages: string[];
  readonly loggedLines: string[];
}

function alertWithTransport(transport: NotificationTransport): AlertUnderTest {
  const postedMessages: string[] = [];
  const loggedLines: string[] = [];
  const reportTick = createCourtLivenessAlert({
    postMessage: async (message, config, options) => {
      postedMessages.push(message);
      await transport(message, config, options);
    },
    log: (line) => loggedLines.push(line),
  });
  return { reportTick, postedMessages, loggedLines };
}

const reachableNtfy: NotificationTransport = async () => {};

const unreachableNtfy: NotificationTransport = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
};

async function reportTicks(
  alert: AlertUnderTest,
  failures: readonly (string | undefined)[],
): Promise<void> {
  for (const failure of failures) {
    await alert.reportTick(failure);
  }
}

test("five failing ticks in a row tell the Lord exactly once", async () => {
  const alert = alertWithTransport(reachableNtfy);

  await reportTicks(alert, [rosterUnreadable, rosterUnreadable]);
  assert.equal(alert.postedMessages.length, 0);

  await reportTicks(alert, [rosterUnreadable]);
  assert.equal(alert.postedMessages.length, 1);

  await reportTicks(alert, [rosterUnreadable, rosterUnreadable]);
  assert.equal(alert.postedMessages.length, 1);
  assert.match(alert.postedMessages[0], /court liveness check has failed 3 times in a row/);
  assert.ok(alert.postedMessages[0].includes(rosterUnreadable));
  assert.deepEqual(alert.loggedLines, []);
});

test("a failure that recovers and then fails three more times tells the Lord once, when the second streak reaches three", async () => {
  const alert = alertWithTransport(reachableNtfy);

  await reportTicks(alert, [
    rosterUnreadable,
    noFailure,
    rosterUnreadable,
    rosterUnreadable,
  ]);
  assert.equal(alert.postedMessages.length, 0);

  await reportTicks(alert, [rosterUnreadable]);
  assert.equal(alert.postedMessages.length, 1);
});

test("two failing ticks tell the Lord nothing", async () => {
  const alert = alertWithTransport(reachableNtfy);

  await reportTicks(alert, [rosterUnreadable, rosterUnreadable]);

  assert.equal(alert.postedMessages.length, 0);
  assert.deepEqual(alert.loggedLines, []);
});

test("a different failure starts its own streak of three", async () => {
  const alert = alertWithTransport(reachableNtfy);

  await reportTicks(alert, [
    rosterUnreadable,
    rosterUnreadable,
    resurrectionRefused,
    resurrectionRefused,
  ]);
  assert.equal(alert.postedMessages.length, 0);

  await reportTicks(alert, [resurrectionRefused]);
  assert.equal(alert.postedMessages.length, 1);
  assert.ok(alert.postedMessages[0].includes(resurrectionRefused));
});

test("a failed ntfy post is written to the backend log and does not throw", async () => {
  const alert = alertWithTransport(unreachableNtfy);

  await reportTicks(alert, [
    rosterUnreadable,
    rosterUnreadable,
    rosterUnreadable,
    rosterUnreadable,
  ]);

  assert.equal(alert.postedMessages.length, 1);
  assert.equal(alert.loggedLines.length, 1);
  assert.ok(alert.loggedLines[0].includes(alert.postedMessages[0]));
  assert.ok(alert.loggedLines[0].includes("ECONNREFUSED"));
});
