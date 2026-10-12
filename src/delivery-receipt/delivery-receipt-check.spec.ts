import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDeliveryNotice } from '../delivery-notice/delivery-notice.ts';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import {
  MESSAGE_RETENTION_WINDOW_MS,
  MessageQueueWorkItemState,
  type WorkItemRow,
} from '../message-queue/message-queue.store.ts';
import {
  ABSENT_NOTICE_WAIT_MS,
  FIRST_RECEIPT_CHECK_DELAY_MS,
  RECEIPT_OBSERVATION_WINDOW_MS,
  RECEIPT_RECHECK_INTERVAL_MS,
  scheduleDeliveryReceiptCheck,
} from './delivery-receipt-check.ts';
import {
  DELIVERED_AT_MS,
  SENDER_NAME,
  deliverMessageTypedAs,
  noticePrompts,
  noticesIn,
  outcomeOf,
  receiptChecksIn,
  recordedDelivery,
  registerRecipient,
  runReceiptCheckAfter,
  typedTextCheckedFor,
  withReceiptCheckScene,
  writeRecipientTranscript,
  type ReceiptCheckScene,
} from './delivery-receipt-check-test-fixtures.ts';

type RecordedCase = readonly [fixtureName: string, recordedMessageId: number];

const ARRIVED_WHOLE: RecordedCase = ['scratch-pane-long-paste-submitted-whole', 990001];
const ARRIVED_CUT_SHORT: RecordedCase = ['message-cut-while-delivered-mid-turn', 10983];
const TRANSCRIPT_OF_OTHER_MESSAGES: RecordedCase = [
  'scratch-pane-two-messages-queued-during-a-reply',
  990008,
];

interface DeliveredRecordedMessage {
  readonly message: WorkItemRow;
  readonly transcript: string;
}

async function deliverRecordedMessage(
  scene: ReceiptCheckScene,
  [fixtureName, recordedMessageId]: RecordedCase,
): Promise<DeliveredRecordedMessage> {
  let transcript = '';
  const message = await deliverMessageTypedAs(scene, async (messageId) => {
    const recorded = await recordedDelivery(fixtureName, recordedMessageId, messageId);
    transcript = recorded.transcript;
    return recorded.typedText;
  });
  return { message, transcript };
}

async function deliverMessageIntoTheTranscript(
  scene: ReceiptCheckScene,
  recordedCase: RecordedCase,
): Promise<WorkItemRow> {
  const { message, transcript } = await deliverRecordedMessage(scene, recordedCase);
  await writeRecipientTranscript(scene, transcript);
  return message;
}

async function deliverMessageThatReaches(
  scene: ReceiptCheckScene,
  recordedCase: RecordedCase,
): Promise<WorkItemRow> {
  await registerRecipient(scene);
  return deliverMessageIntoTheTranscript(scene, recordedCase);
}

async function deliverMessageMissingFromTheTranscript(
  scene: ReceiptCheckScene,
): Promise<WorkItemRow> {
  await registerRecipient(scene);
  const { message } = await deliverRecordedMessage(scene, ARRIVED_WHOLE);
  const [fixtureName, recordedMessageId] = TRANSCRIPT_OF_OTHER_MESSAGES;
  const others = await recordedDelivery(fixtureName, recordedMessageId, recordedMessageId);
  await writeRecipientTranscript(scene, others.transcript);
  return message;
}

async function assertEndsUnobservedWithNobodyNotified(
  scene: ReceiptCheckScene,
  millisecondsSinceDelivery: number = FIRST_RECEIPT_CHECK_DELAY_MS,
): Promise<void> {
  const check = await runReceiptCheckAfter(scene, millisecondsSinceDelivery);
  assert.equal(outcomeOf(scene, check), 'unobserved');
  assert.deepEqual(noticesIn(scene), []);
}

function assertLooksAgainAMinuteLater(scene: ReceiptCheckScene, check: WorkItemRow): void {
  assert.equal(check.state, MessageQueueWorkItemState.Queued);
  assert.equal(check.dueAt, scene.nowMs + RECEIPT_RECHECK_INTERVAL_MS);
  assert.deepEqual(noticesIn(scene), []);
}

test('a message that arrived whole needs nothing further', async () => {
  await withReceiptCheckScene(async (scene) => {
    await deliverMessageThatReaches(scene, ARRIVED_WHOLE);
    const check = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    assert.equal(outcomeOf(scene, check), 'intact');
    assert.deepEqual(noticesIn(scene), []);
    assert.equal(receiptChecksIn(scene).length, 1);
  });
});

test('a message that arrived cut short earns its recipient one notice to read the full text', async () => {
  await withReceiptCheckScene(async (scene) => {
    const message = await deliverMessageThatReaches(scene, ARRIVED_CUT_SHORT);
    const check = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    assert.equal(outcomeOf(scene, check), 'truncated');
    assert.deepEqual(noticePrompts(scene), [
      buildDeliveryNotice('truncated', message.id, SENDER_NAME),
    ]);
    assert.equal(noticesIn(scene)[0]!.state, MessageQueueWorkItemState.Queued);
  });
});

test('a message not yet in the transcript is checked again a minute later', async () => {
  await withReceiptCheckScene(async (scene) => {
    await deliverMessageMissingFromTheTranscript(scene);
    const check = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    assertLooksAgainAMinuteLater(scene, check);
    assert.equal(
      check.dueAt,
      DELIVERED_AT_MS + FIRST_RECEIPT_CHECK_DELAY_MS + RECEIPT_RECHECK_INTERVAL_MS,
    );
    assert.equal(receiptChecksIn(scene).length, 1);
  });
});

test('a message still missing after fifteen minutes earns an idle recipient one notice', async () => {
  await withReceiptCheckScene(async (scene) => {
    const message = await deliverMessageMissingFromTheTranscript(scene);
    scene.recipientStatus = 'idle';
    const justBeforeTheWait = ABSENT_NOTICE_WAIT_MS - 1;
    assertLooksAgainAMinuteLater(scene, await runReceiptCheckAfter(scene, justBeforeTheWait));
    const check = await runReceiptCheckAfter(
      scene,
      justBeforeTheWait + RECEIPT_RECHECK_INTERVAL_MS,
    );
    assert.equal(outcomeOf(scene, check), 'absent-notified');
    assert.deepEqual(noticePrompts(scene), [
      buildDeliveryNotice('absent', message.id, SENDER_NAME),
    ]);
  });
});

test('a busy recipient is not sent a notice for a missing message', async () => {
  await withReceiptCheckScene(async (scene) => {
    await deliverMessageMissingFromTheTranscript(scene);
    scene.recipientStatus = 'working';
    assertLooksAgainAMinuteLater(scene, await runReceiptCheckAfter(scene, ABSENT_NOTICE_WAIT_MS));
    scene.recipientStatus = 'not-live';
    assertLooksAgainAMinuteLater(
      scene,
      await runReceiptCheckAfter(scene, ABSENT_NOTICE_WAIT_MS + RECEIPT_RECHECK_INTERVAL_MS),
    );
  });
});

test('a message still missing after an hour is recorded as unobserved and nobody is notified', async () => {
  await withReceiptCheckScene(async (scene) => {
    await deliverMessageMissingFromTheTranscript(scene);
    scene.recipientStatus = 'working';
    await assertEndsUnobservedWithNobodyNotified(scene, RECEIPT_OBSERVATION_WINDOW_MS);
  });
});

test('a recipient that is not a Claude harness is recorded as unobserved and nobody is notified', async () => {
  await withReceiptCheckScene(async (scene) => {
    await registerRecipient(scene, HARNESS_NAMES.CODEX);
    await deliverMessageIntoTheTranscript(scene, ARRIVED_CUT_SHORT);
    await assertEndsUnobservedWithNobodyNotified(scene);
  });
});

test('a recipient with no spawn record is recorded as unobserved and nobody is notified', async () => {
  await withReceiptCheckScene(async (scene) => {
    await deliverMessageIntoTheTranscript(scene, ARRIVED_CUT_SHORT);
    await assertEndsUnobservedWithNobodyNotified(scene);
  });
});

test('a recipient with no transcript is recorded as unobserved and nobody is notified', async () => {
  await withReceiptCheckScene(async (scene) => {
    await registerRecipient(scene);
    await deliverRecordedMessage(scene, ARRIVED_CUT_SHORT);
    await assertEndsUnobservedWithNobodyNotified(scene);
  });
});

test('a message whose stored row was already swept is recorded as unobserved and nobody is notified', async () => {
  await withReceiptCheckScene(async (scene) => {
    const message = await deliverMessageThatReaches(scene, ARRIVED_CUT_SHORT);
    scene.nowMs = DELIVERED_AT_MS + MESSAGE_RETENTION_WINDOW_MS + 1;
    scene.store.sweepExpiredTerminalWorkItems();
    assert.equal(scene.store.readWorkItem(message.id), undefined);
    await assertEndsUnobservedWithNobodyNotified(scene, MESSAGE_RETENTION_WINDOW_MS + 1);
  });
});

test('checking the same message twice sends one notice', async () => {
  await withReceiptCheckScene(async (scene) => {
    const message = await deliverMessageThatReaches(scene, ARRIVED_CUT_SHORT);
    const firstCheck = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    scheduleDeliveryReceiptCheck(scene.store, message, typedTextCheckedFor(scene));
    const secondCheck = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    assert.notEqual(secondCheck.id, firstCheck.id);
    assert.equal(outcomeOf(scene, firstCheck), 'truncated');
    assert.equal(outcomeOf(scene, secondCheck), 'truncated');
    assert.equal(noticesIn(scene).length, 1);
  });
});
