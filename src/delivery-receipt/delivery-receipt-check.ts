import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import { claudeProjectsFolderOf } from '../account/agent-account.ts';
import {
  deliveryReceiptVerdict,
  type DeliveryReceiptVerdict,
} from './delivery-receipt-verdict.ts';

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

async function transcriptPathsIn(projectDirectory: string): Promise<string[]> {
  try {
    return (await readdir(projectDirectory))
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => path.join(projectDirectory, entry));
  } catch {
    return [];
  }
}

async function modifiedTimeOf(transcriptPath: string): Promise<number | undefined> {
  try {
    return (await stat(transcriptPath)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function transcriptTextOf(transcriptPath: string): Promise<string> {
  try {
    return await readFile(transcriptPath, 'utf8');
  } catch {
    return '';
  }
}

async function transcriptPathsWrittenSince(
  recipientName: string,
  deliveredAtMs: number,
  deps: DeliveryReceiptCheckDeps,
): Promise<string[] | undefined> {
  const spawnRecord = await readSpawnSpec(recipientName, deps.spawnRecordsDirectory);
  if (spawnRecord === null || !isClaudeBranchHarness(spawnRecord.harness)) {
    return undefined;
  }
  const projectDirectory = claudeProjectDirectory(
    spawnRecord.cwd,
    deps.claudeProjectsDirectory ?? claudeProjectsFolderOf(spawnRecord.account),
  );
  const transcriptPaths = await transcriptPathsIn(projectDirectory);
  const modifiedTimes = await Promise.all(transcriptPaths.map(modifiedTimeOf));
  return transcriptPaths.filter((_, index) => (modifiedTimes[index] ?? -Infinity) >= deliveredAtMs);
}

async function receiptVerdictAcross(
  typedText: string,
  messageId: number,
  transcriptPaths: readonly string[],
): Promise<DeliveryReceiptVerdict | 'cannot tell'> {
  if (transcriptPaths.length === 0) return 'cannot tell';
  let anyTruncated = false;
  for (const transcriptPath of transcriptPaths) {
    const transcript = await transcriptTextOf(transcriptPath);
    const verdict = deliveryReceiptVerdict(typedText, messageId, transcript);
    if (verdict === 'intact') return 'intact';
    if (verdict === 'truncated') anyTruncated = true;
  }
  return anyTruncated ? 'truncated' : 'absent';
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
  const transcriptPaths = await transcriptPathsWrittenSince(recipientName, deliveredAtMs, deps);
  if (transcriptPaths === undefined) return concludeCheck(store, check, 'unobserved');

  const verdict = await receiptVerdictAcross(typedText, messageId, transcriptPaths);
  if (verdict === 'intact') return concludeCheck(store, check, 'intact');
  if (verdict === 'truncated') {
    notifyRecipient(store, message, 'truncated');
    return concludeCheck(store, check, 'truncated');
  }
  const waitedMs = deps.now() - deliveredAtMs;
  if (
    verdict === 'absent' &&
    waitedMs >= ABSENT_NOTICE_WAIT_MS &&
    (await isRecipientIdle(recipientName, deps))
  ) {
    notifyRecipient(store, message, 'absent');
    return concludeCheck(store, check, 'absent-notified');
  }
  if (waitedMs >= RECEIPT_OBSERVATION_WINDOW_MS) {
    return concludeCheck(store, check, 'unobserved');
  }
  return store.rescheduleClaimedWorkItem(check.id, RECEIPT_RECHECK_INTERVAL_MS, waitedMs);
}
