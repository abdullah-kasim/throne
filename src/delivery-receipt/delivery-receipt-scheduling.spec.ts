import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { realDepsRootedAt } from '../../test/filebacked-payload-root.ts';
import type { PolicyResolution } from '../create-agent/create.types.ts';
import { deliverAgentOpeningPrompt } from '../create-agent/opening-prompt.ts';
import { baseDeps, baseRequest } from '../create-agent/policy-test-fixtures.ts';
import {
  READ_MESSAGE_COMMAND_LINE,
  buildDeliveryNotice,
  enqueueDeliveryNotice,
} from '../delivery-notice/delivery-notice.ts';
import { submitToAgent } from '../herdr/herdr-send.service.ts';
import type { SubmitToAgentDeps } from '../herdr/herdr-send.types.ts';
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from '../message-queue/message-queue.store.ts';
import { fakeSubmitToAgentDeps } from '../no-idling/no-idling-command-test-fixtures.ts';
import {
  enqueueMessageDelivery,
  type MessageDeliveryWorkItemPayload,
} from '../send-agent/message-delivery-enqueue.ts';
import { stagePayload } from '../send-agent/payload-transport.ts';
import type { MessageDeliveryHandlerDeps } from '../throne-work/message-delivery-handler.ts';
import {
  FIRST_RECEIPT_CHECK_DELAY_MS,
  type DeliveryReceiptCheckPayload,
} from './delivery-receipt-check.ts';
import {
  DELIVERED_AT_MS,
  RECIPIENT_NAME,
  RECIPIENT_PANE,
  SENDER_NAME,
  deliverMessageTypedAs,
  deliverQueuedMessage,
  messagePayload,
  messagesIn,
  noticePrompts,
  outcomeOf,
  receiptChecksIn,
  registerRecipient,
  runReceiptCheckAfter,
  typedTextCheckedFor,
  userTurn,
  withReceiptCheckScene,
  writeRecipientTranscript,
  type ReceiptCheckScene,
} from './delivery-receipt-check-test-fixtures.ts';

const INLINE_LIMIT_BYTES = 768;
const POINTER_LINE = /said: Large message — read then delete: .+ read-payload "[^"]+" \[message \d+\]$/u;
const OPENING_PROMPT =
  `You are \`${RECIPIENT_NAME}\` (Shadow). Your supervisor is \`${SENDER_NAME}\`. ` +
  'Read your assignment from the ledger, do the work in your own worktree, and report when it is done.';
const TAIL_THAT_SURVIVED_THE_CLIP = 'and report when it is done.';

interface TypingPane {
  readonly typedTexts: string[];
  readonly submitToAgent: MessageDeliveryHandlerDeps['submitToAgent'];
}

function typingPane(scene: ReceiptCheckScene): TypingPane {
  const typedTexts: string[] = [];
  const paneDeps: SubmitToAgentDeps = {
    ...fakeSubmitToAgentDeps(typedTexts),
    stagePayload: (recipient, body) =>
      stagePayload(recipient, body, realDepsRootedAt(path.join(scene.directory, 'payloads'))),
    fileBackedPayloadsEnabled: true,
  };
  return {
    typedTexts,
    submitToAgent: (agent, senderName, prompt, options) =>
      submitToAgent(agent, senderName, prompt, options, paneDeps),
  };
}

function enqueueNoticeFor(scene: ReceiptCheckScene, messageId: number): void {
  const notice = enqueueDeliveryNotice(
    scene.store,
    {
      messageId,
      senderName: SENDER_NAME,
      recipientName: RECIPIENT_NAME,
      recipientPaneId: RECIPIENT_PANE.paneId,
    },
    'truncated',
  );
  assert.ok(notice);
}

test('a delivered message gets one receipt check scheduled for after its delivery', async () => {
  await withReceiptCheckScene(async (scene) => {
    const delivered = await deliverMessageTypedAs(scene, () => 'the text that was typed');
    const checks = receiptChecksIn(scene);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.state, MessageQueueWorkItemState.Queued);
    assert.equal(checks[0]!.dueAt, DELIVERED_AT_MS + FIRST_RECEIPT_CHECK_DELAY_MS);
    assert.deepEqual(checks[0]!.payload, {
      messageId: delivered.id,
      typedText: 'the text that was typed',
      deliveredAtMs: DELIVERED_AT_MS,
    } satisfies DeliveryReceiptCheckPayload);
  });
});

test('a message that failed delivery gets no receipt check', async () => {
  await withReceiptCheckScene(async (scene) => {
    enqueueMessageDelivery(scene.store, messagePayload());
    const failed = await deliverQueuedMessage(scene, async () => {
      throw new Error('the pane refused the text');
    });
    assert.equal(failed.state, MessageQueueWorkItemState.Failed);
    assert.deepEqual(receiptChecksIn(scene), []);
  });
});

test('a delivery notice is never itself receipt-checked', async () => {
  await withReceiptCheckScene(async (scene) => {
    enqueueNoticeFor(scene, 41);
    const delivered = await deliverQueuedMessage(scene, async () => 'the notice that was typed');
    assert.equal(delivered.state, MessageQueueWorkItemState.Delivered);
    assert.deepEqual(receiptChecksIn(scene), []);
  });
});

test('a delivery notice is typed ending with the command that reads the message', async () => {
  await withReceiptCheckScene(async (scene) => {
    const pane = typingPane(scene);
    enqueueNoticeFor(scene, 41);
    const delivered = await deliverQueuedMessage(scene, pane.submitToAgent);
    assert.equal(delivered.state, MessageQueueWorkItemState.Delivered, delivered.failureReason ?? '');
    assert.deepEqual(pane.typedTexts, [buildDeliveryNotice('truncated', 41, SENDER_NAME)]);
    assert.ok(pane.typedTexts[0]!.endsWith(`${READ_MESSAGE_COMMAND_LINE} 41`));
  });
});

test('a file-backed message is checked against the pointer line that was typed', async () => {
  await withReceiptCheckScene(async (scene) => {
    const pane = typingPane(scene);
    await registerRecipient(scene);
    enqueueMessageDelivery(scene.store, messagePayload({ prompt: 'x'.repeat(INLINE_LIMIT_BYTES) }));
    const delivered = await deliverQueuedMessage(scene, pane.submitToAgent);
    assert.equal(delivered.state, MessageQueueWorkItemState.Delivered, delivered.failureReason ?? '');
    assert.equal(pane.typedTexts.length, 1);
    assert.match(pane.typedTexts[0]!, POINTER_LINE);
    assert.equal(typedTextCheckedFor(scene), pane.typedTexts[0]);
    await writeRecipientTranscript(scene, userTurn(pane.typedTexts[0]!));
    const check = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    assert.equal(outcomeOf(scene, check), 'intact');
  });
});

test('a clipped opening prompt earns one notice and is never pasted a second time', async () => {
  await withReceiptCheckScene(async (scene) => {
    const pane = typingPane(scene);
    await registerRecipient(scene);
    await deliverAgentOpeningPrompt(
      baseRequest({ name: RECIPIENT_NAME }) as PolicyResolution,
      baseDeps({
        resolveAgent: async () => RECIPIENT_PANE,
        openMessageQueueStore: () => openMessageQueueStore(scene.databasePath, () => scene.nowMs),
      }),
      OPENING_PROMPT,
      true,
    );
    const delivered = await deliverQueuedMessage(scene, pane.submitToAgent);
    assert.equal(delivered.state, MessageQueueWorkItemState.Delivered, delivered.failureReason ?? '');
    assert.deepEqual(pane.typedTexts, [`${OPENING_PROMPT} [message ${delivered.id}]`]);
    await writeRecipientTranscript(
      scene,
      userTurn(`${TAIL_THAT_SURVIVED_THE_CLIP} [message ${delivered.id}]`),
    );
    const check = await runReceiptCheckAfter(scene, FIRST_RECEIPT_CHECK_DELAY_MS);
    assert.equal(outcomeOf(scene, check), 'truncated');
    assert.deepEqual(noticePrompts(scene), [
      buildDeliveryNotice('truncated', delivered.id, RECIPIENT_NAME),
    ]);
    const promptsHoldingTheOpeningPrompt = messagesIn(scene).filter((row) =>
      (row.payload as MessageDeliveryWorkItemPayload).prompt.includes(OPENING_PROMPT),
    );
    assert.equal(promptsHoldingTheOpeningPrompt.length, 1);
    assert.equal(messagesIn(scene).length, 1);
  });
});
