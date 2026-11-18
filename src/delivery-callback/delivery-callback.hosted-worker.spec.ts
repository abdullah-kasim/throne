import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { DELIVERY_CALLBACK_PATH, MESSAGE_ID_PREFIX } from "../../extensions/shared/agent-delivery-contract.ts";
import { DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND } from "../delivery-receipt/delivery-receipt-check.ts";
import { deliveryCallbackSocketPath } from "../herdr/delivery-socket-path.ts";
import {
  acceptedMessageScratch,
  insertAcceptedMessage,
  RECIPIENT_PANE,
  type AcceptedMessageScratch,
} from "../message-queue/accepted-message.test-support.ts";
import { MessageQueueWorkItemState, openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import { startWebListener } from "../web-listener/web-listener-app.ts";
import { DeliveryCallbackHostedWorker } from "./delivery-callback.hosted-worker.ts";

let scratch: AcceptedMessageScratch;
let socketPath: string;
let stopped = false;
let running: Promise<void>;

before(async () => {
  scratch = await acceptedMessageScratch();
  socketPath = deliveryCallbackSocketPath(scratch.folder);
  const worker = new DeliveryCallbackHostedWorker({
    socketPath,
    openStore: () => openMessageQueueStore(scratch.databasePath),
    log: (message) => assert.fail(message),
  });
  running = worker.start(() => stopped);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await stat(socketPath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

after(async () => {
  stopped = true;
  await running;
  await scratch.remove();
});

function postCallback(messageId: number, fields: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: DELIVERY_CALLBACK_PATH, method: "POST", headers: { "content-type": "application/json" } }, (incoming) => {
      incoming.resume();
      incoming.on("end", () => resolve(incoming.statusCode ?? 0));
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ id: `${MESSAGE_ID_PREFIX}${messageId}`, pane: RECIPIENT_PANE, ...fields }));
  });
}

function stateOf(messageId: number): string | undefined {
  return scratch.store.readWorkItem(messageId)?.state;
}

test("the callback socket file is mode 0600 under the throne home", async () => {
  assert.equal(path.dirname(socketPath), scratch.folder);
  const socket = await stat(socketPath);
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
});

test("the callback route does not exist on the web listener's port", async () => {
  const listener = await startWebListener({ port: 0, webRoot: path.join(scratch.folder, "web") });
  try {
    const port = (listener.getHttpServer().address() as AddressInfo).port;
    const message = insertAcceptedMessage(scratch.store);
    const answer = await fetch(`http://127.0.0.1:${port}${DELIVERY_CALLBACK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `${MESSAGE_ID_PREFIX}${message.id}`, pane: RECIPIENT_PANE, status: "delivered" }),
    });
    assert.equal(answer.status, 404);
    assert.equal(stateOf(message.id), MessageQueueWorkItemState.Accepted);
  } finally {
    await listener.close();
  }
});

test("a delivered callback on the backend socket moves an accepted message to delivered and schedules its receipt check", async () => {
  const message = insertAcceptedMessage(scratch.store);
  assert.equal(await postCallback(message.id, { status: "delivered", as: "turn" }), 204);
  assert.equal(stateOf(message.id), MessageQueueWorkItemState.Delivered);
  const receiptChecks = scratch.store
    .listWorkItemsByStates([MessageQueueWorkItemState.Queued])
    .filter((row) => row.kind === DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND)
    .map((row) => (row.payload as { messageId: number }).messageId);
  assert.ok(receiptChecks.includes(message.id));
});

test("a refused callback on the backend socket moves an accepted message to failed", async () => {
  const message = insertAcceptedMessage(scratch.store);
  assert.equal(await postCallback(message.id, { status: "refused", detail: "the composer was gone" }), 204);
  assert.equal(stateOf(message.id), MessageQueueWorkItemState.Failed);
  assert.match(scratch.store.readWorkItem(message.id)?.failureReason ?? "", /the composer was gone/);
});

test("a callback for a message that is not accepted changes nothing", async () => {
  const queued = scratch.store.insertWorkItem({ kind: "message-delivery", payload: {} });
  assert.equal(await postCallback(queued.id, { status: "delivered" }), 409);
  assert.equal(stateOf(queued.id), MessageQueueWorkItemState.Queued);
  const accepted = insertAcceptedMessage(scratch.store);
  assert.equal(await postCallback(accepted.id, { status: "delivered", pane: "w1:p1" }), 403);
  assert.equal(stateOf(accepted.id), MessageQueueWorkItemState.Accepted);
});

test("a failed bind of the callback socket is logged and the backend keeps running", async () => {
  const notAFolder = path.join(scratch.folder, "not-a-folder");
  await writeFile(notAFolder, "");
  const logged: string[] = [];
  const worker = new DeliveryCallbackHostedWorker({
    socketPath: path.join(notAFolder, "delivery-callback.sock"),
    openStore: () => openMessageQueueStore(scratch.databasePath),
    log: (message) => logged.push(message),
  });
  await worker.start(() => false);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /not listening on/);
});
