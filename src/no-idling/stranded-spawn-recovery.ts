import { openingPromptPath, readOpeningPrompt } from '../agentdata/identity-data.service.ts';
import { fileExists, readSpawnSpec, type SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { pressEnter, pressPaneKey } from '../herdr/herdr-client.ts';
import { readVisibleAnsi, resolveAgent } from '../herdr/herdr-runtime.service.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { enqueueHeartbeatMessage } from '../throne-work/enqueue-heartbeat-message.ts';
import { openMessageQueueStore } from '../message-queue/message-queue.store.ts';
import { requiresFileBackedDelivery } from '../send-agent/payload-transport.ts';
import { NO_IDLING_SENDER } from './no-idling-sender.ts';
import { spawnedAtAgeMs } from './idle-family.ts';
import {
  classifyStrandedSpawnPane,
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
 * `omitSenderAttribution`, the file-backing threshold, and
 * `waitForStartupQuiescence` mirror `deliverOpeningPrompt`'s own
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
      disableFileBackedDelivery: !requiresFileBackedDelivery(prompt),
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
  deliverOpeningPrompt: (agentName: string, prompt: string, paneId: string) => Promise<void>;
}

export const REAL_STRANDED_SPAWN_RECOVERY_DEPS: StrandedSpawnRecoveryDeps = {
  resolveAgent,
  readVisibleAnsi,
  openingPromptExists: (agentName, dataDir) => fileExists(openingPromptPath(agentName, dataDir)),
  readOpeningPrompt,
  readSpawnSpec,
  pressPaneKey,
  pressEnter,
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
    classifyStrandedSpawnPane(HARNESS_NAMES.CLAUDE, paneAnsi, openingPromptExists, {
      taskedAt: spawnSpec?.tasked_at,
      ageMs: spawnedAtAgeMs(spawnSpec?.spawned_at, Date.now()),
    }) === expected
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

/**
 * The remedy is selected by classification alone, never re-derived: a
 * `MODAL_BLOCKING` agent gets the modal keypress first, then redelivery;
 * `STRANDED_SPAWN` goes straight to redelivery; `PROMPT_UNSUBMITTED` gets
 * ONLY an Enter keypress and must never reach `deliverOpeningPrompt`, which
 * would double the queued text already sitting in its composer.
 */
async function applyStrandedSpawnRemedy(
  agentName: string,
  paneId: string,
  classification: StrandedSpawnClassification,
  dataDir: string | undefined,
  deps: StrandedSpawnRecoveryDeps,
): Promise<void> {
  switch (classification) {
    case 'MODAL_BLOCKING':
      // confirmation: answers the first-run modal's own numbered prompt
      // ("1. Yes ... 2. No, keep bypass permissions") with the confirmed
      // safe choice; classifyStrandedSpawnPane already diagnosed this pane
      // as showing that exact modal immediately before this call.
      await deps.pressPaneKey(paneId, MODAL_ANSWER_KEY);
      // Submits the modal's selected answer with one fixed Enter -- no
      // clearance loop, no re-observation. The pane state this acts on was
      // just diagnosed as MODAL_BLOCKING (immediately above), so nothing
      // further needs checking before this single, already-licensed press.
      await deps.pressEnter(paneId);
      await redeliverOpeningPrompt(agentName, paneId, dataDir, deps);
      return;
    case 'STRANDED_SPAWN':
      await redeliverOpeningPrompt(agentName, paneId, dataDir, deps);
      return;
    case 'PROMPT_UNSUBMITTED':
      // Clears a composer already diagnosed as holding an unsubmitted
      // opening prompt with one fixed Enter, never followed by delivery --
      // `stillMatchesClassification` reconfirmed this pane still matches
      // that diagnosed shape immediately before `applyStrandedSpawnRemedy`
      // was called, so this single press needs no further check of its own.
      await deps.pressEnter(paneId);
      return;
  }
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
    const stillStranded = await stillMatchesClassification(
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
    await applyStrandedSpawnRemedy(agentName, agent.paneId, classification, dataDir, deps);
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
