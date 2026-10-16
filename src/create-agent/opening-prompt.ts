import { OpeningPromptDeliveryError } from '../herdr/herdr-errors.ts';
import { waitForAgentRegistration } from '../herdr/herdr-agent-registration-wait.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { openMessageQueueStore } from '../message-queue/message-queue.store.ts';
import { TERMINAL_WORK_ITEM_STATES } from '../message-queue/message-queue-work-item-state.ts';
import { HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS } from '../agent-settings/agent-settings-at-spawn.ts';
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from '../send-agent/message-delivery-enqueue.ts';
import { deriveDefaultMessageDeliveryIdempotencyKey } from '../message-queue/message-delivery-idempotency.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { HARNESS_NAMES, runtimeHarness } from '../harness-routing/harness.ts';
import {
  awaitSpawnTaskingConfirmation,
  type RuntimeModelAcceptance,
} from '../session/runtime-model-acceptance.ts';
import {
  type CreateAgentDeps,
  type PolicyResolution,
  type SpawnTaskingOutcome,
} from './create.types.ts';
import {
  currentIsoTime,
  stderrWriter,
} from './command-context.ts';

export interface OpeningPromptDeliveryResult {
  delivered: boolean;
  outcome: SpawnTaskingOutcome;
}

function requestCarriesGenuineTask(request: PolicyResolution): boolean {
  return typeof request.flags.prompt === 'string' && request.flags.prompt.length > 0;
}

/**
 * Best-effort bookkeeping mirroring `send-agent`'s own `markAgentTasked`
 * call: an opening prompt built from a caller-supplied `--prompt` is a
 * genuine tasking, not just identity delivery, so it earns the same
 * `tasked_at` stamp. A ledger I/O failure here must never turn a
 * successfully delivered opening prompt into a failed `create-agent` call.
 */
async function recordAgentTaskedAtSpawn(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): Promise<void> {
  if (!requestCarriesGenuineTask(request)) {
    return;
  }
  try {
    await deps.markAgentTasked?.(request.name, currentIsoTime(deps));
  } catch (error) {
    stderrWriter(deps)(
      `create-agent: tasked-bookkeeping failed for "${request.name}", ignoring: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function launchesClaudeCode(request: PolicyResolution): boolean {
  return runtimeHarness(request.launchHarness) === HARNESS_NAMES.CLAUDE;
}

export const OPENING_PROMPT_QUEUE_POLL_MILLISECONDS = 500;
export const OPENING_PROMPT_IS_STILL_QUEUED =
  "the opening prompt had not left the delivery queue, so nothing was typed in front of it";

function openQueueStoreOf(deps: CreateAgentDeps) {
  return (deps.openMessageQueueStore ?? (() => openMessageQueueStore()))();
}

function openingPromptHasLeftTheQueue(
  deps: CreateAgentDeps,
  promptWorkItemId: number,
): boolean {
  const store = openQueueStoreOf(deps);
  try {
    const workItem = store.readWorkItem(promptWorkItemId);
    return workItem === undefined || TERMINAL_WORK_ITEM_STATES.has(workItem.state);
  } finally {
    store.close();
  }
}

async function openingPromptLeavesTheQueueInTime(
  deps: CreateAgentDeps,
  promptWorkItemId: number,
): Promise<boolean> {
  const pollsAllowed =
    HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS / OPENING_PROMPT_QUEUE_POLL_MILLISECONDS;
  for (let poll = 0; poll < pollsAllowed; poll += 1) {
    if (openingPromptHasLeftTheQueue(deps, promptWorkItemId)) return true;
    await deps.sleep(OPENING_PROMPT_QUEUE_POLL_MILLISECONDS);
  }
  return openingPromptHasLeftTheQueue(deps, promptWorkItemId);
}

async function correctSettingsAfterTheOpeningPrompt(
  agent: HerdrAgent,
  request: PolicyResolution,
  deps: CreateAgentDeps,
  promptWorkItemId: number,
): Promise<void> {
  if (!launchesClaudeCode(request)) {
    return;
  }
  try {
    if (!(await openingPromptLeavesTheQueueInTime(deps, promptWorkItemId))) {
      throw new Error(OPENING_PROMPT_IS_STILL_QUEUED);
    }
    await deps.correctSettingsRightAfterSpawn?.(agent, request.name);
  } catch (error) {
    stderrWriter(deps)(
      `create-agent: the colour and name of "${request.name}" were not corrected at spawn ` +
        `and are left for the next agent-settings check: ${errorText(error)}\n`,
    );
  }
}

function openingPromptDeliveryFlags() {
  return {
    omitSenderAttribution: true,
    waitForStartupQuiescence: true,
  };
}

async function enqueueOpeningPromptViaSqlite(
  agent: HerdrAgent,
  request: PolicyResolution,
  deps: CreateAgentDeps,
  prompt: string,
): Promise<number> {
  const store = openQueueStoreOf(deps);
  try {
    const recipientName = agent.name ?? request.name;
    const idempotencyKey = deriveDefaultMessageDeliveryIdempotencyKey(
      { recipientName, senderName: request.name, prompt },
      (deps.enqueueTimestampMs ?? Date.now)(),
    );
    return enqueueMessageDelivery(
      store,
      buildMessageDeliveryWorkItemPayload({
        recipientName,
        recipientPaneId: agent.paneId,
        senderName: request.name,
        prompt,
        key: idempotencyKey,
        clearRecipientBlockedOnDelivery: false,
        ...openingPromptDeliveryFlags(),
      }),
    ).id;
  } catch (error) {
    throw new OpeningPromptDeliveryError(
      request.name,
      true,
      `the opening prompt could not be enqueued (${errorText(error)})`,
      error,
    );
  } finally {
    store.close();
  }
}

/**
 * The one place that decides `SpawnTaskingOutcome` from the two inputs a
 * caller has: whether the enqueue itself succeeded, and — when confirmation
 * was attempted — what it observed. `confirmation === undefined` means
 * confirmation was never attempted (non-Claude harness, a resume that left
 * the harness already live, or no genuine prompt to confirm).
 */
export function deriveSpawnTaskingOutcome(
  enqueueSucceeded: boolean,
  confirmation: RuntimeModelAcceptance | undefined,
): SpawnTaskingOutcome {
  if (!enqueueSucceeded || confirmation === undefined) {
    return 'not-applicable';
  }
  if (confirmation.ok) {
    return confirmation.outcome === 'matching' ? 'tasked' : 'not-applicable';
  }
  return confirmation.outcome === 'missing'
    ? 'enqueued-unconfirmed'
    : 'quarantined-not-tasked';
}

/**
 * Runs the bounded-wait confirmation after a genuine successful enqueue —
 * only for a caller-supplied prompt on the Claude harness, mirroring the
 * same genuine-task/Claude-only gating `checkAgentRuntimeModelAcceptance`
 * itself already applies for `send-agent`. Returns `undefined` when
 * confirmation was never attempted, so `deriveSpawnTaskingOutcome` reports
 * `"not-applicable"` rather than fabricating a result nobody observed.
 */
async function confirmOpeningPromptTasking(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): Promise<RuntimeModelAcceptance | undefined> {
  if (!requestCarriesGenuineTask(request)) {
    return undefined;
  }
  if (!launchesClaudeCode(request)) {
    return undefined;
  }
  const confirm = deps.confirmSpawnTasking ?? awaitSpawnTaskingConfirmation;
  return confirm(request.name, 'spawn');
}

export async function deliverAgentOpeningPrompt(
  request: PolicyResolution,
  deps: CreateAgentDeps,
  openingPrompt: string,
  harnessWasLaunched: boolean,
): Promise<OpeningPromptDeliveryResult> {
  if (!harnessWasLaunched) {
    return { delivered: true, outcome: 'not-applicable' };
  }
  const writeStderr = stderrWriter(deps);
  try {
    const agent = await waitForAgentRegistration(request.name, deps);
    const promptWorkItemId = await enqueueOpeningPromptViaSqlite(
      agent,
      request,
      deps,
      openingPrompt,
    );
    await recordAgentTaskedAtSpawn(request, deps);
    const confirmation = await confirmOpeningPromptTasking(request, deps);
    await correctSettingsAfterTheOpeningPrompt(agent, request, deps, promptWorkItemId);
    return {
      delivered: true,
      outcome: deriveSpawnTaskingOutcome(true, confirmation),
    };
  } catch (error) {
    const retrySafe =
      error instanceof OpeningPromptDeliveryError && error.retrySafe;
    writeStderr(
      `create-agent: ${request.resuming ? 'resumed' : 'launched'} "${request.name}", but its ` +
        `opening prompt was not queued for delivery ` +
        `(${error instanceof Error ? error.message : String(error)}). Its pane and ` +
        `registration in data/${request.name}/ are retained. ` +
        (retrySafe
          ? `Nothing was written or enqueued, so deliver it with ` +
            `./bin/throne-cli send-agent ${request.name} "<the opening prompt>".`
          : `The enqueue attempt was left indeterminate, so it was NOT resent: read the ` +
            `pane with ./bin/throne-cli agent-logs ${request.name} and only then decide ` +
            `whether anything is still owed.`) +
        `\n`,
    );
    return { delivered: false, outcome: 'not-applicable' };
  }
}
