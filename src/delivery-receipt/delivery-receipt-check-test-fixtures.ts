import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentStatus, LiveAgentStatus } from '../agent-statuses/agent-statuses-herdr.ts';
import { writeSpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { isDeliveryNotice } from '../delivery-notice/delivery-notice.ts';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
  type WorkItemRow,
} from '../message-queue/message-queue.store.ts';
import { workItemOutcome } from '../message-queue/work-item-outcome.store.ts';
import {
  MESSAGE_DELIVERY_WORK_ITEM_KIND,
  enqueueMessageDelivery,
  type MessageDeliveryWorkItemPayload,
} from '../send-agent/message-delivery-enqueue.ts';
import { claudeProjectDirectory } from '../session/runtime-model-acceptance.ts';
import {
  deliverMessageWorkItem,
  type MessageDeliveryHandlerDeps,
} from '../throne-work/message-delivery-handler.ts';
import {
  DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND,
  checkDeliveryReceipt,
  type DeliveryReceiptCheckDeps,
  type DeliveryReceiptCheckPayload,
} from './delivery-receipt-check.ts';

export const SENDER_NAME = 'alpha-example-01';
export const RECIPIENT_NAME = 'shadow-example-02';
export const DELIVERED_AT_MS = 1_000_000;
const RECIPIENT_SESSION_ID = 'recipient-session';
const FIXTURES_DIRECTORY = path.join(import.meta.dirname, 'fixtures');
const EVERY_WORK_ITEM_STATE = Object.values(MessageQueueWorkItemState);

export const RECIPIENT_PANE = {
  agent: 'unknown',
  name: RECIPIENT_NAME,
  agentStatus: 'idle',
  cwd: `/tmp/${RECIPIENT_NAME}`,
  focused: false,
  paneId: 'pane-7',
  tabId: 'tab-7',
  terminalId: 'terminal-7',
} as HerdrAgent;

export interface ReceiptCheckScene {
  readonly directory: string;
  readonly databasePath: string;
  readonly store: MessageQueueStore;
  readonly checkDeps: DeliveryReceiptCheckDeps;
  nowMs: number;
  recipientStatus: AgentStatus | 'not-live';
}

export async function withReceiptCheckScene(
  run: (scene: ReceiptCheckScene) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'throne-delivery-receipt-'));
  const databasePath = path.join(directory, 'queue.sqlite3');
  const scene: ReceiptCheckScene = {
    directory,
    databasePath,
    store: openMessageQueueStore(databasePath, () => scene.nowMs),
    nowMs: DELIVERED_AT_MS,
    recipientStatus: 'working',
    checkDeps: {
      now: () => scene.nowMs,
      listLiveAgents: async () => liveAgentsOf(scene),
      spawnRecordsDirectory: path.join(directory, 'data'),
      claudeProjectsDirectory: path.join(directory, 'projects'),
    },
  };
  try {
    await run(scene);
  } finally {
    scene.store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function liveAgentsOf(scene: ReceiptCheckScene): LiveAgentStatus[] {
  if (scene.recipientStatus === 'not-live') return [];
  return [{ ...RECIPIENT_PANE, agentStatus: scene.recipientStatus } as LiveAgentStatus];
}

function recipientWorkingDirectory(scene: ReceiptCheckScene): string {
  return path.join(scene.directory, 'worktree');
}

export async function registerRecipient(
  scene: ReceiptCheckScene,
  harness: string = HARNESS_NAMES.CLAUDE,
): Promise<void> {
  await writeSpawnSpec(
    RECIPIENT_NAME,
    {
      harness,
      model: 'sonnet',
      effort: 1,
      cwd: recipientWorkingDirectory(scene),
      session_id: RECIPIENT_SESSION_ID,
    },
    scene.checkDeps.spawnRecordsDirectory,
  );
}

export async function writeRecipientTranscript(
  scene: ReceiptCheckScene,
  transcript: string,
): Promise<void> {
  const projectDirectory = claudeProjectDirectory(
    recipientWorkingDirectory(scene),
    scene.checkDeps.claudeProjectsDirectory!,
  );
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(path.join(projectDirectory, `${RECIPIENT_SESSION_ID}.jsonl`), transcript);
}

export function userTurn(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export interface RecordedDelivery {
  readonly typedText: string;
  readonly transcript: string;
}

function renumbered(text: string, recordedId: number, messageId: number): string {
  return text.replaceAll(`[message ${recordedId}]`, `[message ${messageId}]`);
}

export async function recordedDelivery(
  fixtureName: string,
  recordedId: number,
  messageId: number,
): Promise<RecordedDelivery> {
  const typedTexts = JSON.parse(
    await readFile(path.join(FIXTURES_DIRECTORY, 'typed-texts.json'), 'utf8'),
  ) as Record<string, string>;
  const transcript = await readFile(path.join(FIXTURES_DIRECTORY, `${fixtureName}.jsonl`), 'utf8');
  return {
    typedText: renumbered(typedTexts[String(recordedId)]!, recordedId, messageId),
    transcript: renumbered(transcript, recordedId, messageId),
  };
}

export function messagePayload(
  overrides: Partial<MessageDeliveryWorkItemPayload> = {},
): MessageDeliveryWorkItemPayload {
  return {
    recipientName: RECIPIENT_NAME,
    recipientPaneId: RECIPIENT_PANE.paneId,
    senderName: SENDER_NAME,
    prompt: 'Rebase onto main before you continue.',
    clearRecipientBlockedOnDelivery: false,
    ...overrides,
  };
}

export function deliveryHandlerDeps(
  scene: ReceiptCheckScene,
  submitToAgent: MessageDeliveryHandlerDeps['submitToAgent'],
): MessageDeliveryHandlerDeps {
  return {
    resolveAgent: async () => RECIPIENT_PANE,
    submitToAgent,
    recordDeliveredEvent: async () => null,
    readAgentRole: async () => ({ status: 'field-absent' }),
    readAgentSupervisor: async () => ({ status: 'field-absent' }),
    clearBlockedMarker: async () => undefined,
    now: () => scene.nowMs,
    maxNotSentAttempts: 1,
    sleep: async () => undefined,
  };
}

export async function deliverQueuedMessage(
  scene: ReceiptCheckScene,
  submitToAgent: MessageDeliveryHandlerDeps['submitToAgent'],
): Promise<WorkItemRow> {
  const claimed = scene.store.claimNextDueWorkItem([MESSAGE_DELIVERY_WORK_ITEM_KIND]);
  assert.ok(claimed, 'a queued message is due');
  return deliverMessageWorkItem(scene.store, claimed, deliveryHandlerDeps(scene, submitToAgent));
}

export async function deliverMessageTypedAs(
  scene: ReceiptCheckScene,
  typedTextFor: (messageId: number) => string | Promise<string>,
): Promise<WorkItemRow> {
  const message = enqueueMessageDelivery(scene.store, messagePayload());
  const delivered = await deliverQueuedMessage(scene, async () => typedTextFor(message.id));
  assert.equal(delivered.state, MessageQueueWorkItemState.Delivered);
  return delivered;
}

function everyStoredRow(scene: ReceiptCheckScene): WorkItemRow[] {
  return scene.store.listWorkItemsByStates(EVERY_WORK_ITEM_STATE);
}

export function receiptChecksIn(scene: ReceiptCheckScene): WorkItemRow[] {
  return everyStoredRow(scene).filter((row) => row.kind === DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND);
}

export function noticesIn(scene: ReceiptCheckScene): WorkItemRow[] {
  return everyStoredRow(scene).filter(isDeliveryNotice);
}

export function messagesIn(scene: ReceiptCheckScene): WorkItemRow[] {
  return everyStoredRow(scene).filter(
    (row) => row.kind === MESSAGE_DELIVERY_WORK_ITEM_KIND && !isDeliveryNotice(row),
  );
}

export function noticePrompts(scene: ReceiptCheckScene): string[] {
  return noticesIn(scene).map((row) => (row.payload as MessageDeliveryWorkItemPayload).prompt);
}

export function typedTextCheckedFor(scene: ReceiptCheckScene): string {
  const [check] = receiptChecksIn(scene);
  assert.ok(check, 'a receipt check is stored');
  return (check.payload as DeliveryReceiptCheckPayload).typedText;
}

export async function runReceiptCheckAfter(
  scene: ReceiptCheckScene,
  millisecondsSinceDelivery: number,
): Promise<WorkItemRow> {
  scene.nowMs = DELIVERED_AT_MS + millisecondsSinceDelivery;
  const check = scene.store.claimNextDueWorkItem([DELIVERY_RECEIPT_CHECK_WORK_ITEM_KIND]);
  assert.ok(check, `a receipt check is due ${millisecondsSinceDelivery} ms after delivery`);
  return checkDeliveryReceipt(scene.store, check, scene.checkDeps);
}

export function outcomeOf(scene: ReceiptCheckScene, check: WorkItemRow): string | undefined {
  const stored = scene.store.readWorkItem(check.id);
  assert.ok(stored);
  assert.equal(stored.state, MessageQueueWorkItemState.Delivered);
  return workItemOutcome(stored);
}
