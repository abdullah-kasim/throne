import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIdleRecoveryNotice,
  isAgentlessInFlight,
  recoverIdleWork,
} from "../src/alpha-autoscale/idle-recovery.ts";
import { projectNextRunQueue } from "../src/alpha-autoscale/next-run-queue-projection.ts";
import { readAutoscaleQueue } from "../src/alpha-autoscale/regent-queue-feed.ts";
import { RegentQueueItemStatus } from "../src/regent-queue/regent-queue-item-state.ts";
import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../src/regent-queue/regent-queue.store.ts";

function launchFacts(code: string) {
  return {
    alphaName: `alpha-${code}-01`,
    targetRepo: `/srv/repos/${code}`,
    targetBranch: "main",
    baseCommit: "0".repeat(40),
  };
}

function temporaryQueuePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "deferred-rows-wait-"));
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "regent-queue.sqlite3");
}

function withQueue<T>(queuePath: string, use: (store: RegentQueueStore) => T): T {
  const store = openRegentQueueStore(queuePath);
  try {
    return use(store);
  } finally {
    store.close();
  }
}

function fileRow(
  store: RegentQueueStore,
  objectiveCode: string,
  status: RegentQueueItemStatus,
): string {
  return store.insertItem({
    objectiveCode,
    body: `INTENT: ${objectiveCode}`,
    launch: launchFacts(objectiveCode),
    status,
  }).id;
}

function deferRow(store: RegentQueueStore, objectiveCode: string, dependsOn: string[]): void {
  const id = fileRow(store, objectiveCode, RegentQueueItemStatus.Open);
  store.mutateItem(id, {
    status: RegentQueueItemStatus.Deferred,
    deferral: { dependsOn, reason: `waits on ${dependsOn.join(", ")}` },
  });
}

function statusOf(queuePath: string, objectiveCode: string): RegentQueueItemStatus | undefined {
  return withQueue(queuePath, (store) => {
    const read = store.readAll();
    return read.state === "items"
      ? read.items.find((item) => item.objectiveCode === objectiveCode)?.status
      : undefined;
  });
}

function readQueue(queuePath: string) {
  return withQueue(queuePath, (store) => store.readAll());
}

test("the autoscaler leaves a deferred row deferred when every objective it waits on is complete", () => {
  const queuePath = temporaryQueuePath();
  withQueue(queuePath, (store) => {
    fileRow(store, "builder", RegentQueueItemStatus.Complete);
    deferRow(store, "checker", ["builder"]);
  });

  const outcome = recoverIdleWork({ openStore: () => openRegentQueueStore(queuePath) });

  assert.equal(outcome.recovered, null);
  assert.equal(statusOf(queuePath, "checker"), RegentQueueItemStatus.Deferred);
});

test("the autoscaler does not launch a deferred row when the queue has nothing else to run", () => {
  const queuePath = temporaryQueuePath();
  withQueue(queuePath, (store) => deferRow(store, "checker", ["never-filed"]));

  const outcome = recoverIdleWork({ openStore: () => openRegentQueueStore(queuePath) });

  assert.equal(outcome.recovered, null);
  assert.equal(statusOf(queuePath, "checker"), RegentQueueItemStatus.Deferred);
  assert.deepEqual(
    withQueue(queuePath, (store) => readAutoscaleQueue(store)),
    { state: "positively-empty" },
  );
});

test("an in-flight row with no agent is still recovered when the queue has nothing else to run", () => {
  const queuePath = temporaryQueuePath();
  withQueue(queuePath, (store) => {
    fileRow(store, "stranded", RegentQueueItemStatus.InFlight);
    deferRow(store, "checker", ["stranded"]);
  });
  const logged: string[] = [];

  const outcome = recoverIdleWork({
    openStore: () => openRegentQueueStore(queuePath),
    log: (message) => logged.push(message),
  });

  assert.equal(outcome.recovered, "stranded");
  assert.equal(statusOf(queuePath, "stranded"), RegentQueueItemStatus.Open);
  assert.equal(statusOf(queuePath, "checker"), RegentQueueItemStatus.Deferred);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /idle recovery: promoted in-flight objective "stranded" to open/);
});

test("an in-flight row with an agent is never recovered", () => {
  const queuePath = temporaryQueuePath();
  withQueue(queuePath, (store) => {
    const id = fileRow(store, "flying", RegentQueueItemStatus.Open);
    store.transitionStatus(id, RegentQueueItemStatus.InFlight, { agentName: "alpha-flying-01" });
  });

  const outcome = recoverIdleWork({ openStore: () => openRegentQueueStore(queuePath) });

  assert.equal(outcome.recovered, null);
  assert.equal(statusOf(queuePath, "flying"), RegentQueueItemStatus.InFlight);
  const flying = readQueue(queuePath);
  assert.ok(flying.state === "items" && !isAgentlessInFlight(flying.items[0]!));
});

test("the idle recovery notice does not say a deferred row releases itself", () => {
  const notice = buildIdleRecoveryNotice({ recovered: "stranded" });

  assert.ok(notice !== undefined);
  assert.doesNotMatch(notice, /releases itself|released automatically|when its real condition is met/);
  assert.match(
    notice,
    /update-queue --objective-code stranded --status deferred --depends-on <codes> --defer-reason "<text>"/,
  );
  assert.match(notice, /starts only when the Regent runs release-deferred/);
  assert.equal(buildIdleRecoveryNotice({ recovered: null }), undefined);
});

test("the next-run projection never promotes a deferred row", () => {
  const queuePath = temporaryQueuePath();
  withQueue(queuePath, (store) => {
    fileRow(store, "builder", RegentQueueItemStatus.Complete);
    deferRow(store, "checker", ["builder"]);
    deferRow(store, "orphan", ["never-filed"]);
  });

  const projection = projectNextRunQueue(
    readQueue(queuePath),
    { state: "positively-empty" },
    Date.now(),
  );

  assert.equal(projection.wouldRecover, null);
  assert.deepEqual(projection.wouldBrief, []);
  const projected = projection.source.readAll();
  assert.ok(projected.state === "items");
  assert.deepEqual(
    projected.items
      .filter((item) => item.status === RegentQueueItemStatus.Deferred)
      .map((item) => item.objectiveCode)
      .sort(),
    ["checker", "orphan"],
  );
});
