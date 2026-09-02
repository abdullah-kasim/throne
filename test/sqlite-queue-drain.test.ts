import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MessageQueueWorkItemState, openMessageQueueStore } from "../src/message-queue/message-queue.store.ts";
import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../src/send-agent/message-delivery-enqueue.ts";
import { runDispatchTick } from "../src/throne-work/dispatch-loop.ts";
import { SqliteQueueDrainHostedWorker } from "../src/throne-backend/sqlite-queue-drain.hosted-worker.ts";

const fixturePath = path.join(
  process.cwd(),
  "src/message-queue/message-queue-concurrent-writer.worker.ts",
);

function claimInSeparateProcess(databasePath: string): Promise<string> {
  const completion = Promise.withResolvers<string>();
  const child = spawn(process.execPath, [
    "--import",
    "./test/register-typescript.mjs",
    fixturePath,
    databasePath,
    "claim",
  ], { cwd: process.cwd() });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", completion.reject);
  child.on("close", (code) => {
    if (code === 0) {
      completion.resolve(stdout);
    } else {
      completion.reject(new Error(`claim fixture exited ${code}: ${stderr}`));
    }
  });
  return completion.promise;
}

function createDatabasePath(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(path.join(os.homedir(), "tmp", "throne-sqlite-drain-"));
  return { directory, databasePath: path.join(directory, "queue.sqlite3") };
}

test("concurrent SQLite drain workers claim a queued delivery exactly once", async () => {
  const { directory, databasePath } = createDatabasePath();
  const store = openMessageQueueStore(databasePath);
  try {
    const queued = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: { message: "one" },
    });
    const claims = await Promise.all([
      claimInSeparateProcess(databasePath),
      claimInSeparateProcess(databasePath),
    ]);

    assert.deepEqual(claims.filter(Boolean), [String(queued.id)]);
    assert.equal(store.readWorkItem(queued.id)?.state, MessageQueueWorkItemState.InFlight);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("six processes opening one store at the same instant all succeed, and exactly one claims", async () => {
  const { directory, databasePath } = createDatabasePath();
  const store = openMessageQueueStore(databasePath);
  try {
    const queued = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: { message: "one" },
    });
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => claimInSeparateProcess(databasePath)),
    );
    assert.deepEqual(claims.filter(Boolean), [String(queued.id)]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a blocked SQLite delivery does not retain the drain tick or write transaction", async () => {
  const { directory, databasePath } = createDatabasePath();
  const store = openMessageQueueStore(databasePath);
  const blockedDelivery = Promise.withResolvers<void>();
  try {
    const queued = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: {
        recipientName: "recipient",
        recipientPaneId: "pane",
        senderName: "sender",
        prompt: "message",
        clearRecipientBlockedOnDelivery: false,
      },
    });

    assert.deepEqual(
      runDispatchTick(store, new Set(), {
        messageDelivery: {
          resolveAgent: async () => ({}) as never,
          submitToAgent: async () => blockedDelivery.promise,
          clearBlockedMarker: async () => {},
          readAgentRole: async () => ({ status: "absent" }) as never,
          readAgentSupervisor: async () => ({ status: "absent" }) as never,
          recordDeliveredEvent: async () => {},
          sleep: async () => {},
          maxNotSentAttempts: 1,
        },
      }).map((item) => item.id),
      [queued.id],
    );

    const later = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: { message: "later" },
    });
    assert.equal(later.state, MessageQueueWorkItemState.Queued);

    blockedDelivery.resolve();
    const nextTurn = Promise.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
    assert.notEqual(store.readWorkItem(queued.id)?.state, MessageQueueWorkItemState.InFlight);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hosted SQLite drain keeps claiming while a pane delivery is blocked", async () => {
  const { directory, databasePath } = createDatabasePath();
  const store = openMessageQueueStore(databasePath);
  const blockedDelivery = Promise.withResolvers<void>();
  try {
    const worker = new SqliteQueueDrainHostedWorker(store, {
      messageDelivery: {
        resolveAgent: async () => ({}) as never,
        submitToAgent: async () => blockedDelivery.promise,
        clearBlockedMarker: async () => {},
        readAgentRole: async () => ({ status: "absent" }) as never,
        readAgentSupervisor: async () => ({ status: "absent" }) as never,
        recordDeliveredEvent: async () => {},
        sleep: async () => {},
        maxNotSentAttempts: 1,
      },
    });
    const first = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: {
        recipientName: "recipient",
        recipientPaneId: "pane",
        senderName: "sender",
        prompt: "first",
        clearRecipientBlockedOnDelivery: false,
      },
    });

    await worker.runOnce();
    const second = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: {
        recipientName: "recipient",
        recipientPaneId: "pane",
        senderName: "sender",
        prompt: "second",
        clearRecipientBlockedOnDelivery: false,
      },
    });
    await worker.runOnce();

    assert.equal(store.readWorkItem(first.id)?.state, MessageQueueWorkItemState.InFlight);
    assert.equal(store.readWorkItem(second.id)?.state, MessageQueueWorkItemState.InFlight);

    blockedDelivery.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.notEqual(store.readWorkItem(first.id)?.state, MessageQueueWorkItemState.InFlight);
    assert.notEqual(store.readWorkItem(second.id)?.state, MessageQueueWorkItemState.InFlight);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a delivery that keeps yielding on an occupied composer neither starves other work kinds nor stales the heartbeat", async () => {
  const { directory, databasePath } = createDatabasePath();
  let now = 1_000;
  const store = openMessageQueueStore(databasePath, () => now);
  const resurrections: number[] = [];
  try {
    const worker = new SqliteQueueDrainHostedWorker(
      store,
      {
        messageDelivery: {
          resolveAgent: async () => ({ name: "recipient", paneId: "pane", agent: "claude" }) as never,
          submitToAgent: async () => {},
          clearBlockedMarker: async () => {},
          readAgentRole: async () => ({ status: "absent" }) as never,
          readAgentSupervisor: async () => ({ status: "absent" }) as never,
          recordDeliveredEvent: async () => {},
          sleep: async () => {},
          maxNotSentAttempts: 1,
        },
        regentResurrection: {
          resurrectRegent: async () => {
            resurrections.push(now);
          },
        },
      },
      // The composer is never provably empty: a resident draft sits in it.
      async () => false,
    );
    const yielding = store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: {
        recipientName: "recipient",
        recipientPaneId: "pane",
        senderName: "sender",
        prompt: "blocked behind a draft",
        clearRecipientBlockedOnDelivery: false,
      },
    });
    const resurrection = store.insertWorkItem({
      kind: "regent-resurrection",
      payload: {},
      dedupeKey: "regent-resurrection",
    });
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 4; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    await worker.runOnce();
    await settle();
    assert.equal(store.readHeartbeat(), 1_000, "the tick that claimed a delivery still wrote the heartbeat");
    assert.equal(store.readWorkItem(yielding.id)?.state, MessageQueueWorkItemState.Queued, "the yielding delivery is rescheduled, not delivered");
    assert.deepEqual(resurrections, [1_000], "the resurrection was dispatched on the same tick");
    assert.equal(store.readWorkItem(resurrection.id)?.state, MessageQueueWorkItemState.Delivered);

    now = 2_000;
    await worker.runOnce();
    await settle();
    assert.equal(store.readHeartbeat(), 2_000);
    assert.equal(store.readWorkItem(yielding.id)?.attemptCount, 2, "the delivery is still being retried each tick");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
