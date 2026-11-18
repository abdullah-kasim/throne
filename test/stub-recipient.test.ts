import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverThroughExtension } from "../src/herdr/delivery-request-client.ts";
import { createStubRecipient, UNRECOGNIZED_COMPOSER_DETAIL } from "./stub-recipient.ts";

const PANE = "stub-pane";

test("a configurable recipient receives the request byte-for-byte on its socket and answers delivered", async () => {
  const recipient = await createStubRecipient({ pane: PANE });
  const payload = "payload with \\n preserved \" and 🙂";
  try {
    const outcome = await deliverThroughExtension(payload, 1_000, PANE, { socketPath: recipient.socketPath, requestId: "message-1" });
    assert.deepEqual(outcome, { kind: "delivered" });
    assert.deepEqual(recipient.requests, [{ id: "message-1", pane: PANE, text: payload, waitMs: 1_000 }]);
    assert.equal(recipient.submitted.length, 1);
  } finally {
    await recipient.dispose();
  }
});

test("a resident-draft recipient holds the request on the open connection and delivers it once the draft is gone", async () => {
  const recipient = await createStubRecipient({ pane: PANE, state: { kind: "resident-draft", text: "do not overwrite this" } });
  try {
    const sending = deliverThroughExtension("next message", 5_000, PANE, { socketPath: recipient.socketPath });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(recipient.requests.length, 1);
    assert.deepEqual(recipient.submitted, []);
    recipient.setState({ kind: "acknowledge" });
    assert.deepEqual(await sending, { kind: "delivered" });
    assert.equal(recipient.submitted.length, 1);
  } finally {
    await recipient.dispose();
  }
});

test("an unrecognised composer returns its exact refusal detail", async () => {
  const recipient = await createStubRecipient({ pane: PANE, state: { kind: "refuse", detail: UNRECOGNIZED_COMPOSER_DETAIL } });
  try {
    const outcome = await deliverThroughExtension("hello", 1_000, PANE, { socketPath: recipient.socketPath });
    assert.deepEqual(outcome, { kind: "refused", detail: UNRECOGNIZED_COMPOSER_DETAIL });
    assert.deepEqual(recipient.submitted, []);
  } finally {
    await recipient.dispose();
  }
});

test("a recipient whose composer stays unreadable answers busy after the wait, which is timed out and never submitted", async () => {
  const recipient = await createStubRecipient({ pane: PANE, state: { kind: "unreadable" } });
  try {
    const outcome = await deliverThroughExtension("hello", 300, PANE, { socketPath: recipient.socketPath });
    assert.equal(outcome.kind, "timed-out");
    assert.equal(recipient.requests.length, 1);
    assert.deepEqual(recipient.submitted, []);
  } finally {
    await recipient.dispose();
  }
});

test("a message sent while the recipient's turn is running is held, never submitted over the turn, and dropped when the wait ends", async () => {
  const recipient = await createStubRecipient({ pane: PANE, harness: "pi", state: { kind: "turn-running" } });
  try {
    const outcome = await deliverThroughExtension("your child finished; inspect once", 400, PANE, { socketPath: recipient.socketPath });
    assert.equal(outcome.kind, "timed-out");
    assert.deepEqual(recipient.submitted, []);
    assert.equal(recipient.withdrawals.length, 1);
  } finally {
    await recipient.dispose();
  }
});
