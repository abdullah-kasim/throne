import { readFile } from 'node:fs/promises';
import {
  listLiveAgentStatusesAcrossSessions,
  type LiveAgentStatus,
} from '../agent-statuses/agent-statuses-herdr.ts';
import { readSpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import {
  enqueueDeliveryNotice,
  isDeliveryNotice,
  type UndeliveredMessageVerdict,
} from '../delivery-notice/delivery-notice.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import { isClaudeBranchHarness } from '../herdr/herdr-send.helpers.ts';
import {
  MessageQueueWorkItemState,
  type MessageQueueStore,
  type WorkItemRow,
} from '../message-queue/message-queue.store.ts';
import type { MessageDeliveryWorkItemPayload } from '../send-agent/message-delivery-enqueue.ts';
import { claudeTranscriptPathFor } from '../session/runtime-model-acceptance.ts';
import { deliveryReceiptVerdict } from './delivery-receipt-verdict.ts';

export const DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND = 'delivery-receipt-check';

export const FIRST_RECEIPT_CHECK_DELAY_MS = 10_000;
export const RECEIPT_RECHECK_INTERVAL_MS = 60_000;
export const ABSENT_NOTICE_WAIT_MS = 15 * 60_000;
export const RECEIPT_OBSERVATION_WINDOW_MS = 60 * 60_000;

export type DeliveryReceiptCheckOutcome =
  | 'intact'
  | 'truncated'
  | 'absent-notified'
  | 'unobserved';

export interface DeliveryReceiptCheckPayload {
  readonly messageId: number;
  readonly typedText: string;
  readonly deliveredAtMs: number;
}

export interface DeliveryReceiptCheckDeps {
  now: () => number;
  listLiveAgents: () => Promise<readonly LiveAgentStatus[]>;
  spawnRecordsDirectory?: string;
  claudeProjectsDirectory?: string;
}

export const REAL_DELIVERY_RECEIPT_CHECK_DEPS: DeliveryReceiptCheckDeps = {
  now: Date.now,
  listLiveAgents: () => listLiveAgentStatusesAcrossSessions(),
};

export function scheduleDeliveryReceiptCheck(
  store: MessageQueueStore,
  deliveredMessage: WorkItemRow,
  typedText: string,
): WorkItemRow | undefined {
  if (isDeliveryNotice(deliveredMessage)) return undefined;
  const deliveredAtMs = deliveredMessage.terminalAt ?? deliveredMessage.updatedAt;
  const payload: DeliveryReceiptCheckPayload = {
    messageId: deliveredMessage.id,
    typedText,
    deliveredAtMs,
  };
  return store.insertWorkItem({
    kind: DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND,
    payload,
    dueAt: deliveredAtMs + FIRST_RECEIPT_CHECK_DELAY_MS,
  });
}

async function readObservableTranscript(
  recipientName: string,
  deps: DeliveryReceiptCheckDeps,
): Promise<string | undefined> {
  const spawnRecord = await readSpawnSpec(recipientName, deps.spawnRecordsDirectory);
  if (spawnRecord === null || !isClaudeBranchHarness(spawnRecord.harness)) {
    return undefined;
  }
  const transcriptPath = await claudeTranscriptPathFor(
    spawnRecord.cwd,
    spawnRecord.session_id,
    deps.claudeProjectsDirectory,
  );
  return transcriptPath === undefined ? undefined : readFile(transcriptPath, 'utf8');
}

async function isRecipientIdle(
  recipientName: string,
  deps: DeliveryReceiptCheckDeps,
): Promise<boolean> {
  const recipient = (await deps.listLiveAgents()).find((agent) =>
    sameAgentName(agent.tabLabel ?? agent.name, recipientName),
  );
  return recipient !== undefined && agentStatusAcceptsInput(recipient.agentStatus);
}

function notifyRecipient(
  store: MessageQueueStore,
  message: WorkItemRow,
  verdict: UndeliveredMessageVerdict,
): void {
  const { senderName, recipientName, recipientPaneId } =
    message.payload as MessageDeliveryWorkItemPayload;
  enqueueDeliveryNotice(
    store,
    { messageId: message.id, senderName, recipientName, recipientPaneId },
    verdict,
  );
}

function concludeCheck(
  store: MessageQueueStore,
  check: WorkItemRow,
  outcome: DeliveryReceiptCheckOutcome,
): WorkItemRow {
  store.recordWorkItemOutcome(check.id, outcome);
  return store.finishWorkItemIdempotently(check.id, MessageQueueWorkItemState.Delivered);
}

export async function checkDeliveryReceipt(
  store: MessageQueueStore,
  check: WorkItemRow,
  deps: DeliveryReceiptCheckDeps = REAL_DELIVERY_RECEIPT_CHECK_DEPS,
): Promise<WorkItemRow> {
  const { messageId, typedText, deliveredAtMs } =
    check.payload as DeliveryReceiptCheckPayload;
  const message = store.readWorkItem(messageId);
  if (message === undefined) return concludeCheck(store, check, 'unobserved');
  const { recipientName } = message.payload as MessageDeliveryWorkItemPayload;
  const transcript = await readObservableTranscript(recipientName, deps);
  if (transcript === undefined) return concludeCheck(store, check, 'unobserved');

  const verdict = deliveryReceiptVerdict(typedText, messageId, transcript);
  if (verdict === 'intact') return concludeCheck(store, check, 'intact');
  if (verdict === 'truncated') {
    notifyRecipient(store, message, 'truncated');
    return concludeCheck(store, check, 'truncated');
  }
  const waitedMs = deps.now() - deliveredAtMs;
  if (waitedMs >= ABSENT_NOTICE_WAIT_MS && (await isRecipientIdle(recipientName, deps))) {
    notifyRecipient(store, message, 'absent');
    return concludeCheck(store, check, 'absent-notified');
  }
  if (waitedMs >= RECEIPT_OBSERVATION_WINDOW_MS) {
    return concludeCheck(store, check, 'unobserved');
  }
  return store.rescheduleClaimedWorkItem(check.id, RECEIPT_RECHECK_INTERVAL_MS, waitedMs);
}
