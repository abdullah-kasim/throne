import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  InvalidWorkItemStateTransitionError,
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from "./message-queue.store.ts";

async function withStore(run: (store: ReturnType<typeof openMessageQueueStore>) => void): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "throne-accepted-"));
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"), () => 1_000);
  try {
    run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("an in-flight message can be marked accepted and later delivered", async () => {
  await withStore((store) => {
    const queued = store.insertWorkItem({ kind: "delivery", payload: {} });
    store.claimDueWorkItem(queued.id);
    const accepted = store.acceptInFlightWorkItem(queued.id);
    assert.equal(accepted.state, MessageQueueWorkItemState.Accepted);
    assert.equal(accepted.terminalAt, null);
    const delivered = store.transitionWorkItemState(queued.id, MessageQueueWorkItemState.Delivered);
    assert.equal(delivered.state, MessageQueueWorkItemState.Delivered);
  });
});

test("an accepted message can fail with a reason", async () => {
  await withStore((store) => {
    const queued = store.insertWorkItem({ kind: "delivery", payload: {} });
    store.claimDueWorkItem(queued.id);
    store.acceptInFlightWorkItem(queued.id);
    const failed = store.transitionWorkItemState(queued.id, MessageQueueWorkItemState.Failed, { failureReason: "refused" });
    assert.equal(failed.state, MessageQueueWorkItemState.Failed);
  });
});

test("a queued message cannot be marked accepted before it is claimed", async () => {
  await withStore((store) => {
    const queued = store.insertWorkItem({ kind: "delivery", payload: {} });
    assert.throws(() => store.acceptInFlightWorkItem(queued.id), InvalidWorkItemStateTransitionError);
  });
});
