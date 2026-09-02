import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from "../src/message-queue/message-queue.store.ts";

async function withDatabase(
  run: (databasePath: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "throne-message-retry-"));
  try {
    await run(path.join(directory, "queue.sqlite3"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}


test("a failed delivery below its retry ceiling is available again only after backoff", async () => {
  await withDatabase((databasePath) => {
    let now = 1_000;
    const store = openMessageQueueStore(databasePath, () => now);
    const queued = store.insertWorkItem({ kind: "delivery", payload: {}, maximumAttempts: 2 });
    const claimed = store.claimDueWorkItem(queued.id);
    assert.equal(claimed?.attemptCount, 1);

    const retry = store.failDeliveryAttempt(queued.id, "temporary", 500);
    assert.equal(retry.state, MessageQueueWorkItemState.Queued);
    assert.equal(retry.failureReason, "temporary");
    assert.equal(retry.dueAt, 1_500);
    assert.equal(store.claimDueWorkItem(queued.id), undefined);

    now = 1_500;
    const reclaimed = store.claimDueWorkItem(queued.id);
    assert.equal(reclaimed?.state, MessageQueueWorkItemState.InFlight);
    assert.equal(reclaimed?.attemptCount, 2);
    store.close();
  });
});

test("an exhausted delivery failure is terminal and retains its reason", async () => {
  await withDatabase((databasePath) => {
    const store = openMessageQueueStore(databasePath, () => 2_000);
    const queued = store.insertWorkItem({ kind: "delivery", payload: {}, maximumAttempts: 1 });
    store.claimDueWorkItem(queued.id);
    const failed = store.failDeliveryAttempt(queued.id, "permanent", 500);

    assert.equal(failed.state, MessageQueueWorkItemState.Failed);
    assert.equal(failed.failureReason, "permanent");
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.maximumAttempts, 1);
    assert.equal(failed.terminalAt, 2_000);
    store.close();
  });
});

test("retry counts survive reopening the SQLite store", async () => {
  await withDatabase((databasePath) => {
    let now = 3_000;
    let store = openMessageQueueStore(databasePath, () => now);
    const queued = store.insertWorkItem({ kind: "delivery", payload: {}, maximumAttempts: 3 });
    store.claimDueWorkItem(queued.id);
    store.failDeliveryAttempt(queued.id, "retry", 1);
    store.close();

    now = 3_001;
    store = openMessageQueueStore(databasePath, () => now);
    const persisted = store.readWorkItem(queued.id);
    assert.equal(persisted?.attemptCount, 1);
    assert.equal(persisted?.maximumAttempts, 3);
    assert.equal(store.claimDueWorkItem(queued.id)?.attemptCount, 2);
    store.close();
  });
});

test("an existing queue database upgrades in place with durable retry defaults", async () => {
  await withDatabase((databasePath) => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO work_items (kind, payload, state, failure_reason, created_at, updated_at)
      VALUES ('delivery', '{}', 'queued', NULL, 1, 1);
    `);
    legacy.close();

    const upgraded = openMessageQueueStore(databasePath, () => 4_000);
    const row = upgraded.readWorkItem(1);
    assert.equal(row?.attemptCount, 0);
    assert.equal(row?.maximumAttempts, 1);
    assert.deepEqual(row?.payload, {});
    upgraded.close();
  });
});

test("a never-scheduled item is claimed ahead of an older item that keeps being rescheduled", async () => {
  await withDatabase((databasePath) => {
    let now = 1_000;
    const store = openMessageQueueStore(databasePath, () => now);
    const older = store.insertWorkItem({ kind: "delivery", payload: {} });
    assert.equal(store.claimNextDueWorkItem(["delivery"])?.id, older.id);
    // Yielded on an occupied composer: back to queued, due again in a second.
    store.rescheduleClaimedWorkItem(older.id, 1_000, 1_000);
    now = 1_500;
    const newer = store.insertWorkItem({ kind: "delivery", payload: {} });
    now = 2_000;
    assert.equal(store.claimNextDueWorkItem(["delivery"])?.id, newer.id, "the fresh item goes first");
    assert.equal(store.claimNextDueWorkItem(["delivery"])?.id, older.id, "then the rescheduled one");
    assert.equal(store.claimNextDueWorkItem(["delivery"]), undefined);
    store.close();
  });
});
