import { openingPromptPath, readOpeningPrompt } from '../agentdata/identity-data.service.ts';
import { fileExists, readSpawnSpec, type SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { pressEnter, pressPaneKey } from '../herdr/herdr-client.ts';
import { RecipientPaneLockService } from '../shared-policy/recipient-pane-lock.service.ts';
import { readVisibleAnsi, resolveAgent } from '../herdr/herdr-runtime.service.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { enqueueHeartbeatMessage } from '../throne-work/enqueue-heartbeat-message.ts';
import { openMessageQueueStore } from '../message-queue/message-queue.store.ts';
import { NO_IDLING_SENDER } from './no-idling-sender.ts';
import {
  classifyStrandedSpawnPane,
  strandedSpawnEvidenceFromSpawnRecord,
  type StrandedSpawnClassification,
} from './stranded-spawn-classification.ts';

/** Answers the confirmed first-run modal with "No, keep bypass permissions". */
const MODAL_ANSWER_KEY = '2';

/**
 * Redelivers a stranded spawn's opening prompt through the same durable
 * `message-delivery` queue every other in-court sweep (`keep-going`,
 * `no-idling`'s own Regent notices) already routes through, rather than
 * writing the pane directly. The no-idling sweep this recovery runs inside
 * fires during ordinary court operation with a live queue backend -- unlike
 * Regent resurrection or boot-time orphan reconciliation, the two
 * bootstrap-only exceptions that predate a running backend and so cannot
 * rely on it. There is no equivalent circularity here: the queue is exactly
 * as available to a stranded-spawn sweep as it is to every other no-idling
 * notice already flowing through it, so a direct `deliverOpeningPrompt`
 * call would be an unreasoned bypass, not a genuine exception.
 * `omitSenderAttribution` and `waitForStartupQuiescence` mirror
 * `deliverOpeningPrompt`'s own
 * opening-prompt options exactly -- this is the same delivery, queued
 * instead of synchronous. The recipient's pane is already known (the
 * classification pass that produced it just read the pane), so unlike
 * `deliverOpeningPrompt` this never needs its own registration-wait poll.
 */
async function redeliverOpeningPromptViaQueue(
  agentName: string,
  prompt: string,
  paneId: string,
): Promise<void> {
  const store = openMessageQueueStore();
  try {
    await enqueueHeartbeatMessage(store, {
      recipientName: agentName,
      recipientPaneId: paneId,
      senderName: NO_IDLING_SENDER,
      prompt,
      clearRecipientBlockedOnDelivery: false,
      omitSenderAttribution: true,
      waitForStartupQuiescence: true,
    });
  } finally {
    store.close();
  }
}

export const STRANDED_SPAWN_RECOVERY_OUTCOMES = {
  REDELIVERED: 'redelivered',
  ALREADY_STARTED_NO_OP: 'already-started-no-op',
  FAILED: 'failed',
} as const;

export type StrandedSpawnRecoveryOutcome =
  (typeof STRANDED_SPAWN_RECOVERY_OUTCOMES)[keyof typeof STRANDED_SPAWN_RECOVERY_OUTCOMES];

export interface StrandedSpawnRecoveryResult {
  readonly agentName: string;
  readonly classification: StrandedSpawnClassification;
  readonly remedy: string;
  readonly outcome: StrandedSpawnRecoveryOutcome;
  readonly detail?: string;
}

export interface StrandedSpawnRecoveryDeps {
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  readVisibleAnsi: (paneId: string) => Promise<string>;
  openingPromptExists: (agentName: string, dataDir: string | undefined) => Promise<boolean>;
  readOpeningPrompt: (agentName: string, dataDir: string | undefined) => Promise<string | null>;
  readSpawnSpec: (agentName: string, dataDir: string | undefined) => Promise<SpawnSpec | null>;
  pressPaneKey: (paneId: string, key: string) => Promise<void>;
  pressEnter: (paneId: string) => Promise<void>;
  withRecipientPaneLock: RecipientPaneLockService['withRecipientPaneLock'];
  deliverOpeningPrompt: (agentName: string, prompt: string, paneId: string) => Promise<void>;
}

const RECIPIENT_PANE_LOCK = new RecipientPaneLockService();

export const REAL_STRANDED_SPAWN_RECOVERY_DEPS: StrandedSpawnRecoveryDeps = {
  resolveAgent,
  readVisibleAnsi,
  openingPromptExists: (agentName, dataDir) => fileExists(openingPromptPath(agentName, dataDir)),
  readOpeningPrompt,
  readSpawnSpec,
  pressPaneKey,
  pressEnter,
  withRecipientPaneLock: RECIPIENT_PANE_LOCK.withRecipientPaneLock.bind(RECIPIENT_PANE_LOCK),
  deliverOpeningPrompt: redeliverOpeningPromptViaQueue,
};

function remedyLabel(classification: StrandedSpawnClassification): string {
  switch (classification) {
    case 'MODAL_BLOCKING':
      return 'answer modal, redeliver opening prompt';
    case 'STRANDED_SPAWN':
      return 'redeliver opening prompt';
    case 'PROMPT_UNSUBMITTED':
      return 'press Enter';
  }
}

/**
 * Re-reads the exact pane-content evidence `classifyStrandedSpawnPane`
 * produced the caller's classification from, immediately before acting on
 * it -- the idempotency guard the incident report demands. An agent that
 * started between detection and recovery no longer reclassifies as any
 * stranded shape (its composer holds neither a modal, a draft, nor an
 * absent-prompt-empty state), so it is never redelivered to or sent a
 * keypress.
 */
async function stillMatchesClassification(
  agentName: string,
  paneId: string,
  expected: StrandedSpawnClassification,
  dataDir: string | undefined,
  deps: StrandedSpawnRecoveryDeps,
): Promise<boolean> {
  const [paneAnsi, openingPromptExists, spawnSpec] = await Promise.all([
    deps.readVisibleAnsi(paneId),
    deps.openingPromptExists(agentName, dataDir),
    deps.readSpawnSpec(agentName, dataDir),
  ]);
  return (
    classifyStrandedSpawnPane(
      HARNESS_NAMES.CLAUDE,
      paneAnsi,
      openingPromptExists,
      strandedSpawnEvidenceFromSpawnRecord(spawnSpec, Date.now()),
    ) === expected
  );
}

async function redeliverOpeningPrompt(
  agentName: string,
  paneId: string,
  dataDir: string | undefined,
  deps: StrandedSpawnRecoveryDeps,
): Promise<void> {
  const prompt = await deps.readOpeningPrompt(agentName, dataDir);
  if (prompt === null) {
    throw new Error(`opening-prompt.md is missing on disk for "${agentName}"`);
  }
  await deps.deliverOpeningPrompt(agentName, prompt, paneId);
}

async function pressRemedyKeys(
  paneId: string,
  classification: StrandedSpawnClassification,
  deps: StrandedSpawnRecoveryDeps,
): Promise<void> {
  switch (classification) {
    case 'MODAL_BLOCKING':
      await deps.pressPaneKey(paneId, MODAL_ANSWER_KEY);
      await deps.pressEnter(paneId);
      return;
    case 'STRANDED_SPAWN':
      return;
    case 'PROMPT_UNSUBMITTED':
      await deps.pressEnter(paneId);
      return;
  }
}

function remedyRedeliversTheOpeningPrompt(classification: StrandedSpawnClassification): boolean {
  return classification !== 'PROMPT_UNSUBMITTED';
}

async function pressRemedyKeysIfStillStranded(
  agentName: string,
  paneId: string,
  classification: StrandedSpawnClassification,
  dataDir: string | undefined,
  deps: StrandedSpawnRecoveryDeps,
): Promise<boolean> {
  return deps.withRecipientPaneLock(paneId, async () => {
    if (!(await stillMatchesClassification(agentName, paneId, classification, dataDir, deps))) {
      return false;
    }
    await pressRemedyKeys(paneId, classification, deps);
    return true;
  });
}

/**
 * Mechanically clears a single stranded-spawn classification and logs the
 * outcome for later human review -- never a raise-and-abandon, so a
 * misbehaving remedy for one agent never stops the sweep from recovering
 * the rest. An agent whose pane no longer reclassifies as the expected
 * shape (it already started) is reported `already-started-no-op` and
 * touched by neither a keypress nor a redelivery.
 */
export async function recoverStrandedSpawn(
  agentName: string,
  classification: StrandedSpawnClassification,
  dataDir: string | undefined,
  deps: StrandedSpawnRecoveryDeps = REAL_STRANDED_SPAWN_RECOVERY_DEPS,
): Promise<StrandedSpawnRecoveryResult> {
  const remedy = remedyLabel(classification);
  try {
    const agent = await deps.resolveAgent(agentName);
    const stillStranded = await pressRemedyKeysIfStillStranded(
      agentName,
      agent.paneId,
      classification,
      dataDir,
      deps,
    );
    if (!stillStranded) {
      return {
        agentName,
        classification,
        remedy,
        outcome: STRANDED_SPAWN_RECOVERY_OUTCOMES.ALREADY_STARTED_NO_OP,
        detail: 'pane no longer reclassifies as this stranding shape; treated as already started',
      };
    }
    if (remedyRedeliversTheOpeningPrompt(classification)) {
      await redeliverOpeningPrompt(agentName, agent.paneId, dataDir, deps);
    }
    return {
      agentName,
      classification,
      remedy,
      outcome: STRANDED_SPAWN_RECOVERY_OUTCOMES.REDELIVERED,
    };
  } catch (error) {
    return {
      agentName,
      classification,
      remedy,
      outcome: STRANDED_SPAWN_RECOVERY_OUTCOMES.FAILED,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
