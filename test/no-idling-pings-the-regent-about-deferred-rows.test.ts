import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runNoIdling } from "../src/no-idling/no-idling-run.ts";
import { deps, type SubmitCall } from "../src/no-idling/no-idling-command-test-fixtures.ts";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
} from "../src/regent-queue/regent-queue.store.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const FILED_AT_MS = Date.UTC(2026, 9, 5, 12);

interface Court {
  readonly databasePath: string;
  readonly clock: { nowMs: number };
  queue(): ReturnType<typeof openRegentQueueStore>;
  sweep(options?: { notify: boolean }): Promise<readonly string[]>;
}

function withCourt(run: (court: Court) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "deferred-row-belt-"));
    const databasePath = path.join(directory, "regent-queue.sqlite3");
    const clock = { nowMs: FILED_AT_MS };
    const court: Court = {
      databasePath,
      clock,
      queue: () => openRegentQueueStore(databasePath, () => clock.nowMs),
      async sweep(options = { notify: true }) {
        const { dependencies, submitCalls } = deps({
          openRegentQueue: () => openRegentQueueStore(databasePath, () => clock.nowMs),
          now: () => clock.nowMs,
          stdout: () => {},
          stderr: () => {},
        });
        await runNoIdling(dependencies, options);
        return regentPrompts(submitCalls);
      },
    };
    try {
      await run(court);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function regentPrompts(submitCalls: readonly SubmitCall[]): readonly string[] {
  return submitCalls.filter((call) => call.target.name === "Regent").map((call) => call.prompt);
}

function fileRow(court: Court, objectiveCode: string, status: RegentQueueItemStatus): void {
  const queue = court.queue();
  try {
    queue.insertItem({ objectiveCode, body: `objective ${objectiveCode}` });
    if (status === RegentQueueItemStatus.Open) return;
    queue.transitionStatus(objectiveCode, RegentQueueItemStatus.InFlight);
    if (status !== RegentQueueItemStatus.InFlight) queue.transitionStatus(objectiveCode, status);
  } finally {
    queue.close();
  }
}

function fileDeliveredRow(court: Court, objectiveCode: string): void {
  fileRow(court, objectiveCode, RegentQueueItemStatus.InFlight);
  const queue = court.queue();
  try {
    queue.mutateItem(objectiveCode, {
      deliveryMirror: {
        verdict: "delivered",
        deliveryCommit: "abc1234",
        targetRepo: "/repo",
        targetBranch: "main",
        treeIdentity: "tree",
        checkedAt: court.clock.nowMs,
        reason: null,
      },
    });
  } finally {
    queue.close();
  }
}

function fileDeferredRow(court: Court, objectiveCode: string, dependsOn: readonly string[]): void {
  const queue = court.queue();
  try {
    queue.insertItem({ objectiveCode, body: `objective ${objectiveCode}` });
    queue.mutateItem(objectiveCode, {
      status: RegentQueueItemStatus.Deferred,
      deferral: { dependsOn: [...dependsOn], reason: "waits for the layer below" },
    });
  } finally {
    queue.close();
  }
}

test(
  "the Regent is told a deferred row can start when every objective it waits on is done",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Complete);
    fileDeliveredRow(court, "middle");
    fileDeferredRow(court, "upper", ["lower", "middle"]);

    assert.deepEqual(await court.sweep(), [
      "Deferred upper can start: lower, middle are done. Run release-deferred.",
    ]);
  }),
);

test(
  "the Regent is not told a deferred row can start while an objective it waits on is still in flight",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Complete);
    fileRow(court, "middle", RegentQueueItemStatus.InFlight);
    fileDeferredRow(court, "upper", ["lower", "middle"]);

    assert.deepEqual(await court.sweep(), []);
  }),
);

test(
  "the Regent is told a deferred row waits on an abandoned objective",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Abandoned);
    fileDeferredRow(court, "upper", ["lower"]);

    assert.deepEqual(await court.sweep(), [
      "Deferred upper waits on lower, which is abandoned. Release or abandon it.",
    ]);
  }),
);

test(
  "the Regent is told a deferred row waits on an objective that does not exist",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.InFlight);
    fileDeferredRow(court, "upper", ["lower", "ghost"]);

    assert.deepEqual(await court.sweep(), [
      "Deferred upper waits on ghost, which is missing. Release or abandon it.",
    ]);
  }),
);

test(
  "the Regent is told a deferred row has been held for more than a day",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.InFlight);
    fileDeferredRow(court, "upper", ["lower"]);

    court.clock.nowMs = FILED_AT_MS + 24 * HOUR_MS;
    assert.deepEqual(await court.sweep(), []);

    court.clock.nowMs = FILED_AT_MS + 25 * HOUR_MS;
    assert.deepEqual(await court.sweep(), [
      "Deferred upper has been held for 25 h waiting on lower.",
    ]);
  }),
);

test(
  "a deferred row is not pinged again for the same reason within an hour",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Complete);
    fileDeferredRow(court, "upper", ["lower"]);
    const readyPing = "Deferred upper can start: lower are done. Run release-deferred.";

    assert.deepEqual(await court.sweep(), [readyPing]);
    court.clock.nowMs += HOUR_MS - MINUTE_MS;
    assert.deepEqual(await court.sweep(), []);
    court.clock.nowMs += MINUTE_MS;
    assert.deepEqual(await court.sweep(), [readyPing]);
  }),
);

test(
  "the last ping time survives a restart of the sweep",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Abandoned);
    fileDeferredRow(court, "upper", ["lower"]);

    assert.equal((await court.sweep()).length, 1);
    court.clock.nowMs += 30 * MINUTE_MS;

    const restarted = deps({
      openRegentQueue: () => openRegentQueueStore(court.databasePath, () => court.clock.nowMs),
      now: () => court.clock.nowMs,
      stdout: () => {},
      stderr: () => {},
    });
    await runNoIdling(restarted.dependencies, { notify: true });
    assert.deepEqual(regentPrompts(restarted.submitCalls), []);
  }),
);

test(
  "a row that is no longer deferred is not pinged",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Complete);
    fileDeferredRow(court, "upper", ["lower"]);
    assert.equal((await court.sweep()).length, 1);

    const queue = court.queue();
    try {
      queue.mutateItem("upper", { status: RegentQueueItemStatus.Open });
    } finally {
      queue.close();
    }
    court.clock.nowMs += 30 * HOUR_MS;

    assert.deepEqual(await court.sweep(), []);
  }),
);

test(
  "a report-only sweep sends no deferred-row ping",
  withCourt(async (court) => {
    fileRow(court, "lower", RegentQueueItemStatus.Complete);
    fileDeferredRow(court, "upper", ["lower"]);

    assert.deepEqual(await court.sweep({ notify: false }), []);
    assert.deepEqual(await court.sweep(), [
      "Deferred upper can start: lower are done. Run release-deferred.",
    ]);
  }),
);

test(
  "an unreadable queue skips the deferred-row check without a ping",
  withCourt(async (court) => {
    const errors: string[] = [];
    const { dependencies, submitCalls } = deps({
      openRegentQueue: () => {
        throw new Error("database is locked");
      },
      now: () => court.clock.nowMs,
      stdout: () => {},
      stderr: (text) => errors.push(text),
    });

    await runNoIdling(dependencies, { notify: true });

    assert.deepEqual(regentPrompts(submitCalls), []);
    assert.deepEqual(errors, ["no-idling: deferred-row check skipped: database is locked\n"]);
  }),
);
