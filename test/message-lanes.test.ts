import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
} from "../src/message-queue/message-queue.store.ts";
import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../src/send-agent/message-delivery-enqueue.ts";
import { SqliteQueueDrainHostedWorker } from "../src/throne-backend/sqlite-queue-drain.hosted-worker.ts";
import { stubMessageDelivery } from "./stub-message-delivery-test-support.ts";

interface Court {
  readonly store: MessageQueueStore;
  readonly worker: SqliteQueueDrainHostedWorker;
  readonly started: string[];
  readonly finishDelivery: (prompt: string) => void;
  readonly busyRecipients: Set<string>;
  readonly throwingPrompts: Set<string>;
  readonly queue: (recipient: string, prompt: string) => number;
  readonly setNow: (milliseconds: number) => void;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function withCourt(
  options: { readonly deliveryMs?: number },
  body: (court: Court) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(os.homedir(), "tmp", "throne-message-lanes-"));
  let now = 1_000;
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"), () => now);
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  const busyRecipients = new Set<string>();
  const throwingPrompts = new Set<string>();
  const worker = new SqliteQueueDrainHostedWorker(
    store,
    {
      messageDelivery: stubMessageDelivery({
        resolveAgent: async (name) => ({ name, paneId: name, agent: "claude" }) as never,
        submitToAgent: async (_agent, _sender, prompt) => {
          started.push(prompt);
          if (options.deliveryMs !== undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, options.deliveryMs));
            return;
          }
          await new Promise<void>((resolve) => pending.set(prompt, resolve));
        },
      }),
    },
    async (agent) => {
      const name = (agent as unknown as { name: string }).name;
      if ([...throwingPrompts].some((prompt) => prompt.startsWith(name))) {
        throwingPrompts.clear();
        throw new Error("pane vanished");
      }
      return !busyRecipients.has(name);
    },
  );
  const court: Court = {
    store,
    worker,
    started,
    finishDelivery: (prompt) => {
      const resolve = pending.get(prompt);
      assert.ok(resolve, `${prompt} is not being delivered`);
      pending.delete(prompt);
      resolve();
    },
    busyRecipients,
    throwingPrompts,
    queue: (recipient, prompt) => store.insertWorkItem({
      kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
      payload: {
        recipientName: recipient,
        recipientPaneId: recipient,
        senderName: "sender",
        prompt,
        clearRecipientBlockedOnDelivery: false,
      },
    }).id,
    setNow: (milliseconds) => { now = milliseconds; },
  };
  try {
    await body(court);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function deliveredState(court: Court, id: number): string | undefined {
  return court.store.readWorkItem(id)?.state;
}

test("two messages for one agent are never in flight together and arrive in the order queued", async () => {
  await withCourt({}, async (court) => {
    const first = court.queue("alpha", "alpha first");
    const second = court.queue("alpha", "alpha second");
    await court.worker.runOnce();
    await settle();
    await court.worker.runOnce();
    await settle();
    assert.deepEqual(court.started, ["alpha first"]);
    assert.equal(deliveredState(court, second), MessageQueueWorkItemState.Queued);

    court.finishDelivery("alpha first");
    await settle();
    assert.equal(deliveredState(court, first), MessageQueueWorkItemState.Delivered);
    assert.deepEqual(court.started, ["alpha first", "alpha second"]);
  });
});

test("with eight agents each owed one message, four start at once and a fifth starts the moment one ends, with no tick in between", async () => {
  await withCourt({}, async (court) => {
    for (let agent = 1; agent <= 8; agent += 1) court.queue(`agent${agent}`, `agent${agent} hello`);
    await court.worker.runOnce();
    await settle();
    assert.deepEqual(court.started, ["agent1 hello", "agent2 hello", "agent3 hello", "agent4 hello"]);

    court.finishDelivery("agent2 hello");
    await settle();
    assert.deepEqual(court.started.slice(4), ["agent5 hello"]);
  });
});

test("ten messages waiting on busy composers do not delay a message for an idle agent", async () => {
  await withCourt({}, async (court) => {
    for (let agent = 1; agent <= 10; agent += 1) {
      court.busyRecipients.add(`busy${agent}`);
      court.queue(`busy${agent}`, `busy${agent} waiting`);
    }
    await court.worker.runOnce();
    await settle();
    court.setNow(2_000);
    const idle = court.queue("idle", "idle hello");
    await court.worker.runOnce();
    await settle();
    assert.deepEqual(court.started, ["idle hello"]);
    assert.equal(deliveredState(court, idle), MessageQueueWorkItemState.InFlight);
  });
});

test("a message for an agent whose earlier message is backing off waits behind it", async () => {
  await withCourt({}, async (court) => {
    court.busyRecipients.add("alpha");
    const earlier = court.queue("alpha", "alpha earlier");
    await court.worker.runOnce();
    await settle();
    assert.equal(deliveredState(court, earlier), MessageQueueWorkItemState.Queued);
    const later = court.queue("alpha", "alpha later");
    await court.worker.runOnce();
    await settle();
    assert.equal(deliveredState(court, later), MessageQueueWorkItemState.Queued);
    assert.equal(court.store.readWorkItem(later)?.attemptCount, 0);
    assert.deepEqual(court.started, []);

    court.busyRecipients.delete("alpha");
    court.setNow(2_000);
    await court.worker.runOnce();
    await settle();
    assert.deepEqual(court.started, ["alpha earlier"]);
    court.finishDelivery("alpha earlier");
    await settle();
    assert.deepEqual(court.started, ["alpha earlier", "alpha later"]);
  });
});

test("a delivery that throws frees its lane, and the next message for that agent is delivered", async () => {
  await withCourt({}, async (court) => {
    court.throwingPrompts.add("alpha doomed");
    const doomed = court.queue("alpha", "alpha doomed");
    const next = court.queue("alpha", "alpha next");
    await court.worker.runOnce();
    await settle();
    assert.notEqual(deliveredState(court, doomed), MessageQueueWorkItemState.InFlight);
    assert.deepEqual(court.started, ["alpha next"]);
    court.finishDelivery("alpha next");
    await settle();
    assert.equal(deliveredState(court, next), MessageQueueWorkItemState.Delivered);
  });
});

test("a backlog of forty messages for ten idle agents, as left by a restart, is all started within the time ten deliveries take in sequence, not forty seconds", async () => {
  const deliveryMs = 50;
  await withCourt({ deliveryMs }, async (court) => {
    const ids: number[] = [];
    for (let round = 1; round <= 4; round += 1) {
      for (let agent = 1; agent <= 10; agent += 1) ids.push(court.queue(`agent${agent}`, `agent${agent} message ${round}`));
    }
    const startedAt = Date.now();
    await court.worker.runOnce();
    while (court.started.length < 40 && Date.now() - startedAt < 5_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const elapsedMs = Date.now() - startedAt;
    assert.equal(court.started.length, 40);
    assert.ok(elapsedMs < 10 * deliveryMs + 400, `took ${elapsedMs} ms`);
    for (let agent = 1; agent <= 10; agent += 1) {
      assert.deepEqual(
        court.started.filter((prompt) => prompt.startsWith(`agent${agent} `)),
        [1, 2, 3, 4].map((round) => `agent${agent} message ${round}`),
      );
    }
    while (ids.some((id) => deliveredState(court, id) !== MessageQueueWorkItemState.Delivered)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  });
});

test("a held delivery keeps its lane and slot until it ends, and the other lanes keep delivering", async () => {
  await withCourt({}, async (court) => {
    court.queue("held", "held first");
    const heldSecond = court.queue("held", "held second");
    for (let round = 1; round <= 3; round += 1) {
      for (const agent of ["beta", "gamma", "delta"]) court.queue(agent, `${agent} message ${round}`);
    }
    await court.worker.runOnce();
    await settle();
    assert.deepEqual(court.started, ["held first", "beta message 1", "gamma message 1", "delta message 1"]);

    for (let round = 1; round <= 3; round += 1) {
      for (const agent of ["beta", "gamma", "delta"]) court.finishDelivery(`${agent} message ${round}`);
      await settle();
      await court.worker.runOnce();
      await settle();
    }
    assert.equal(court.started.filter((prompt) => prompt.startsWith("held")).length, 1);
    assert.equal(deliveredState(court, heldSecond), MessageQueueWorkItemState.Queued);

    for (const agent of ["one", "two", "three", "four"]) court.queue(agent, `${agent} hello`);
    await court.worker.runOnce();
    await settle();
    assert.deepEqual(court.started.slice(-3), ["one hello", "two hello", "three hello"]);

    court.finishDelivery("held first");
    await settle();
    assert.equal(court.started.at(-1), "held second");
    assert.ok(!court.started.includes("four hello"));
  });
});
