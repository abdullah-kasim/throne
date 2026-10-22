import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import {
  enqueueMessageDelivery,
  type MessageDeliveryWorkItemPayload,
} from "../send-agent/message-delivery-enqueue.ts";
import {
  buildDeliveryNotice,
  deliveryNoticeDedupeKey,
  enqueueDeliveryNotice,
  isDeliveryNotice,
  type UndeliveredMessage,
} from "./delivery-notice.ts";
import { NO_IDLING_SENDER } from "../no-idling/no-idling-sender.ts";

const EVERY_WORK_ITEM_STATE = Object.values(MessageQueueWorkItemState);

const UNDELIVERED_MESSAGE: UndeliveredMessage = {
  messageId: 10981,
  senderName: "alpha-example-01",
  recipientName: "shadow-example-02",
  recipientPaneId: "pane-7",
};

async function withStore(
  run: (store: MessageQueueStore) => void,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "throne-delivery-notice-"));
  const store = openMessageQueueStore(path.join(directory, "queue.sqlite3"));
  try {
    run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function payloadOf(item: WorkItemRow): MessageDeliveryWorkItemPayload {
  return item.payload as MessageDeliveryWorkItemPayload;
}

function enqueueNoticeOrFail(store: MessageQueueStore): WorkItemRow {
  const notice = enqueueDeliveryNotice(store, UNDELIVERED_MESSAGE, "truncated");
  assert.ok(notice);
  return notice;
}

test("a recipient whose message arrived cut short is told to disregard the fragment and read the full text", () => {
  assert.equal(
    buildDeliveryNotice("truncated", 10981, "alpha-example-01"),
    "Message 10981 from alpha-example-01 reached you cut short. Disregard what you did from the fragment and read the full text: throne read-message 10981",
  );
});

test("a recipient whose message may not have arrived is told to read it", () => {
  assert.equal(
    buildDeliveryNotice("absent", 10981, "alpha-example-01"),
    "Message 10981 from alpha-example-01 may not have reached you. Read it: throne read-message 10981",
  );
});

test("a delivery notice for a message with no recorded sender names the throne as its sender", async () => {
  await withStore((store) => {
    for (const senderName of ["", "   "]) {
      const notice = enqueueDeliveryNotice(store, { ...UNDELIVERED_MESSAGE, messageId: senderName.length, senderName }, "absent");
      assert.ok(notice);
      assert.equal(
        payloadOf(notice).prompt,
        `Message ${senderName.length} from the throne may not have reached you. Read it: throne read-message ${senderName.length}`,
      );
    }
  });
});

test("a delivery notice names the sweep that sent the message", async () => {
  await withStore((store) => {
    const notice = enqueueDeliveryNotice(store, { ...UNDELIVERED_MESSAGE, senderName: NO_IDLING_SENDER }, "absent");
    assert.ok(notice);
    assert.equal(
      payloadOf(notice).prompt,
      "Message 10981 from no-idling may not have reached you. Read it: throne read-message 10981",
    );
  });
});

test("a delivery notice ends with the command that reads the message", async () => {
  await withStore((store) => {
    const truncatedNotice = enqueueDeliveryNotice(store, { ...UNDELIVERED_MESSAGE, messageId: 41 }, "truncated");
    const absentNotice = enqueueDeliveryNotice(store, { ...UNDELIVERED_MESSAGE, messageId: 42 }, "absent");
    assert.ok(truncatedNotice);
    assert.ok(absentNotice);
    assert.ok(payloadOf(truncatedNotice).prompt.endsWith("throne read-message 41"));
    assert.ok(payloadOf(absentNotice).prompt.endsWith("throne read-message 42"));
  });
});

test("a delivery notice is typed directly and never file-backed", async () => {
  await withStore((store) => {
    const payload = payloadOf(enqueueNoticeOrFail(store));
    assert.equal(payload.disableFileBackedDelivery, true);
    assert.equal(payload.omitSenderAttribution, true);
    assert.equal(payload.prompt, buildDeliveryNotice("truncated", 10981, "alpha-example-01"));
    assert.equal(payload.prompt.includes("\n"), false);
    assert.equal(payload.recipientName, "shadow-example-02");
    assert.equal(payload.recipientPaneId, "pane-7");
  });
});

test("a delivery notice is marked as a notice so it is never itself checked", async () => {
  await withStore((store) => {
    const notice = enqueueNoticeOrFail(store);
    const ordinaryMessage = enqueueMessageDelivery(store, {
      recipientName: "shadow-example-02",
      recipientPaneId: "pane-7",
      senderName: "alpha-example-01",
      prompt: "an ordinary message",
      clearRecipientBlockedOnDelivery: false,
    });
    assert.equal(isDeliveryNotice(notice), true);
    assert.equal(isDeliveryNotice(ordinaryMessage), false);
    assert.equal(payloadOf(notice).key, deliveryNoticeDedupeKey(10981));
    assert.equal(deliveryNoticeDedupeKey(10981), "delivery-notice:10981");
  });
});

test("a second notice for the same message is not created while the first is still queued", async () => {
  await withStore((store) => {
    const first = enqueueNoticeOrFail(store);
    const second = enqueueDeliveryNotice(store, UNDELIVERED_MESSAGE, "absent");
    assert.equal(second, undefined);
    const stored = store.listWorkItemsByStates(EVERY_WORK_ITEM_STATE);
    assert.deepEqual(stored.map((item) => item.id), [first.id]);
    assert.equal(stored[0]?.state, MessageQueueWorkItemState.Queued);
  });
});

test("a second notice for the same message is not created even after the first was delivered", async () => {
  await withStore((store) => {
    const first = enqueueNoticeOrFail(store);
    store.claimDueWorkItem(first.id);
    store.transitionWorkItemState(first.id, MessageQueueWorkItemState.Delivered);
    const second = enqueueDeliveryNotice(store, UNDELIVERED_MESSAGE, "truncated");
    assert.equal(second, undefined);
    const stored = store.listWorkItemsByStates(EVERY_WORK_ITEM_STATE);
    assert.deepEqual(stored.map((item) => item.id), [first.id]);
    assert.equal(stored[0]?.state, MessageQueueWorkItemState.Delivered);
    const noticeForAnotherMessage = enqueueDeliveryNotice(
      store,
      { ...UNDELIVERED_MESSAGE, messageId: 10982 },
      "truncated",
    );
    assert.ok(noticeForAnotherMessage);
  });
});
