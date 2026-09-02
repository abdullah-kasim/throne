import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAlphaFloorDeliveryProbeDeps } from "../src/alpha-autoscale/verify-alpha-floor-delivery.command.ts";
import { MessageQueueWorkItemState, openMessageQueueStore, type MessageQueueStore } from "../src/message-queue/message-queue.store.ts";
import {
  resultLine,
  verifyDeliveryPath,
  type VerifyDeliveryPathDeps,
} from "../src/message-queue/verify-delivery-path.command.ts";
import { runDispatchTick } from "../src/throne-work/dispatch-loop.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import type { MessageDeliveryHandlerDeps } from "../src/throne-work/message-delivery-handler.ts";

type Delivery = { readonly senderName: string; readonly recipientName: string };

async function withQueue(run: (store: MessageQueueStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(homedir(), "tmp", "throne-verify-delivery-"));
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"));
  try {
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function deliveryHandlerDeps(deliveries: Delivery[]): MessageDeliveryHandlerDeps {
  return {
    resolveAgent: async (name) => ({ name }) as HerdrAgent,
    submitToAgent: async (agent, senderName) => {
      deliveries.push({ senderName, recipientName: agent.name ?? "" });
    },
    clearBlockedMarker: async () => undefined,
    readAgentRole: async () => ({ status: "field-absent" }),
    readAgentSupervisor: async () => ({ status: "field-absent" }),
    recordDeliveredEvent: async () => undefined,
    sleep: async () => undefined,
    maxNotSentAttempts: 1,
  };
}

function nextEventLoopTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function probeDeps(
  store: MessageQueueStore,
  deliveries: Delivery[],
  senderName?: string,
): VerifyDeliveryPathDeps {
  let now = 0;
  return {
    resolveCurrentAgentName: async () => "recipient-agent",
    ...(senderName === undefined ? {} : { resolveSenderName: async () => senderName }),
    openStore: () => store,
    now: () => now,
    sleep: async () => {
      await runDispatchTick(store, new Set(), {
        messageDelivery: deliveryHandlerDeps(deliveries),
      });
      await nextEventLoopTurn();
      now += 1;
    },
    pollWindowMs: 10,
    pollIntervalMs: 1,
  };
}

test("we should be able to prove a message actually reaches an agent", async () => {
  await withQueue(async (store) => {
    const deliveries: Delivery[] = [];

    const result = await verifyDeliveryPath(probeDeps(store, deliveries));

    assert.deepEqual(result, { passed: true, verdict: "delivered" });
    assert.deepEqual(deliveries, [
      { senderName: "recipient-agent", recipientName: "recipient-agent" },
    ]);
  });
});

test("we should fail a delivery proof when the message never reaches an agent", async () => {
  await withQueue(async (store) => {
    let now = 0;
    const result = await verifyDeliveryPath({
      resolveCurrentAgentName: async () => "recipient-agent",
      openStore: () => store,
      now: () => now,
      sleep: async () => {
        const queued = store.listWorkItemsByStates([MessageQueueWorkItemState.Queued])[0];
        assert.ok(queued);
        assert.equal(store.claimDueWorkItem(queued.id)?.state, MessageQueueWorkItemState.InFlight);
        store.transitionWorkItemState(
          queued.id,
          MessageQueueWorkItemState.Failed,
          { failureReason: "probe recipient never accepted the message" },
        );
        now += 1;
      },
      pollWindowMs: 10,
      pollIntervalMs: 1,
    });

    assert.deepEqual(result, { passed: false, verdict: "failed-with-reason" });
    assert.match(resultLine(result), /^FAIL — /);
    assert.doesNotMatch(resultLine(result), /SKIPPED|disabled/i);
  });
});

test("we should prove alpha-floor delivery with its cron sender identity", async () => {
  await withQueue(async (store) => {
    const deliveries: Delivery[] = [];

    const result = await verifyDeliveryPath(
      buildAlphaFloorDeliveryProbeDeps(probeDeps(store, deliveries)),
    );

    assert.deepEqual(result, { passed: true, verdict: "delivered" });
    assert.deepEqual(deliveries, [
      { senderName: "alpha-autoscale", recipientName: "recipient-agent" },
    ]);
  });
});
