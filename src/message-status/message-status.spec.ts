import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedMessageScratch, insertAcceptedMessage } from "../message-queue/accepted-message.test-support.ts";
import { formatMessageStatusOutput, readMessageStatus } from "./message-status.ts";

test("message-status reports an accepted message as accepted", async () => {
  const scratch = await acceptedMessageScratch();
  try {
    const message = insertAcceptedMessage(scratch.store);
    scratch.store.writeHeartbeat();
    assert.equal(formatMessageStatusOutput(message.id, readMessageStatus(scratch.store, message.id)), "accepted\n");
  } finally {
    await scratch.remove();
  }
});
