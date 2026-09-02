import { OpeningPromptDeliveryError } from '../herdr/herdr-errors.ts';
import { waitForAgentRegistration } from '../herdr/herdr-agent-registration-wait.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { openMessageQueueStore } from '../message-queue/message-queue.store.ts';
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from '../send-agent/message-delivery-enqueue.ts';
import { deriveDefaultMessageDeliveryIdempotencyKey } from '../message-queue/message-delivery-idempotency.ts';
import { requiresFileBackedDelivery } from '../send-agent/payload-transport.ts';
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

/**
 * The shared literal delivery flags an opening prompt always carries: no
 * sender attribution on a first turn, file-backing only once the prompt
 * crosses the transport's inline-size threshold, and a wait for the
 * harness's startup chrome to settle before writing.
 */
function openingPromptDeliveryFlags(prompt: string) {
  return {
    omitSenderAttribution: true,
    disableFileBackedDelivery: !requiresFileBackedDelivery(prompt),
    waitForStartupQuiescence: true,
  };
}

async function enqueueOpeningPromptViaSqlite(
  agent: HerdrAgent,
  request: PolicyResolution,
  deps: CreateAgentDeps,
  prompt: string,
): Promise<void> {
  const openStore = deps.openMessageQueueStore ?? (() => openMessageQueueStore());
  const store = openStore();
  try {
    const recipientName = agent.name ?? request.name;
    const idempotencyKey = deriveDefaultMessageDeliveryIdempotencyKey(
      { recipientName, senderName: request.name, prompt },
      (deps.enqueueTimestampMs ?? Date.now)(),
    );
    enqueueMessageDelivery(
      store,
      buildMessageDeliveryWorkItemPayload({
        recipientName,
        recipientPaneId: agent.paneId,
        senderName: request.name,
        prompt,
        key: idempotencyKey,
        clearRecipientBlockedOnDelivery: false,
        ...openingPromptDeliveryFlags(prompt),
      }),
    );
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


async function enqueueOpeningPromptDelivery(
  agent: HerdrAgent,
  request: PolicyResolution,
  deps: CreateAgentDeps,
  prompt: string,
): Promise<void> {
  return enqueueOpeningPromptViaSqlite(agent, request, deps, prompt);
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
  if (runtimeHarness(request.launchHarness) !== HARNESS_NAMES.CLAUDE) {
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
    await enqueueOpeningPromptDelivery(agent, request, deps, openingPrompt);
    await recordAgentTaskedAtSpawn(request, deps);
    const confirmation = await confirmOpeningPromptTasking(request, deps);
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
