import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { ALIVE_PATH } from "../../extensions/shared/agent-delivery-contract.ts";
import {
  acceptedMessageScratch,
  insertAcceptedMessage,
  recordRecipient,
  RECIPIENT_PANE,
  SENDER_NAME,
} from "../message-queue/accepted-message.test-support.ts";
import { MessageQueueWorkItemState } from "../message-queue/message-queue.store.ts";
import { LostAcceptedMessageHostedWorker } from "./lost-accepted-message.hosted-worker.ts";

test("an agent killed while holding an accepted message gives the sender a failure notice and the message is queued again", async () => {
  const scratch = await acceptedMessageScratch();
  try {
    await recordRecipient(scratch, path.join(scratch.folder, "gone.sock"));
    const message = insertAcceptedMessage(scratch.store);
    await new LostAcceptedMessageHostedWorker(scratch.store, scratch.spawnRecordsDirectory).runOnce();
    assert.equal(scratch.store.readWorkItem(message.id)?.state, MessageQueueWorkItemState.Queued);
    const notices = scratch.store.listUnacknowledgedDeliveryFailureNotices(SENDER_NAME);
    assert.deepEqual(notices.map((notice) => notice.workItemId), [message.id]);
  } finally {
    await scratch.remove();
  }
});

test("an accepted message waits with no time limit while its agent still answers", async () => {
  const scratch = await acceptedMessageScratch();
  const socketPath = path.join(scratch.folder, "agent.sock");
  const agent = createServer((request, response) => {
    if (request.url === ALIVE_PATH) response.end(JSON.stringify({ pane: RECIPIENT_PANE, harness: "claude", commands: true, callbacks: true }));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => agent.listen(socketPath, resolve));
  try {
    await recordRecipient(scratch, socketPath);
    const message = insertAcceptedMessage(scratch.store);
    const worker = new LostAcceptedMessageHostedWorker(scratch.store, scratch.spawnRecordsDirectory);
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(scratch.store.readWorkItem(message.id)?.state, MessageQueueWorkItemState.Accepted);
    assert.deepEqual(scratch.store.listUnacknowledgedDeliveryFailureNotices(SENDER_NAME), []);
  } finally {
    await new Promise((resolve) => agent.close(resolve));
    await scratch.remove();
  }
});
