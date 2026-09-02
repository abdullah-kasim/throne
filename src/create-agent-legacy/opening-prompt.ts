import { OpeningPromptDeliveryError } from "../herdr/herdr-errors.ts";
import { waitForAgentRegistration } from "../herdr/herdr-agent-registration-wait.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { openMessageQueueStore } from "./legacy-message-queue.store.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from "../send-agent/message-delivery-enqueue.ts";
import { deriveDefaultMessageDeliveryIdempotencyKey } from "../message-queue/message-delivery-idempotency.ts";
import { requiresFileBackedDelivery } from "../send-agent/payload-transport.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { type CreateAgentDeps, type PolicyResolution } from "./create.types.ts";
import { currentIsoTime, stderrWriter } from "./command-context.ts";

function requestCarriesGenuineTask(request: PolicyResolution): boolean {
  return (
    typeof request.flags.prompt === "string" && request.flags.prompt.length > 0
  );
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
      `create-agent-legacy: tasked-bookkeeping failed for "${request.name}", ignoring: ` +
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
  const openStore =
    deps.openMessageQueueStore ?? (() => openMessageQueueStore());
  const store = openStore();
  try {
    const recipientName = agent.name ?? request.name;
    const idempotencyKey = deriveDefaultMessageDeliveryIdempotencyKey(
      { recipientName, senderName: request.name, prompt },
      (deps.enqueueTimestampMs ?? Date.now)(),
    );
    enqueueMessageDelivery(
      store as unknown as Parameters<typeof enqueueMessageDelivery>[0],
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

export async function deliverAgentOpeningPrompt(
  request: PolicyResolution,
  deps: CreateAgentDeps,
  openingPrompt: string,
  harnessWasLaunched: boolean,
): Promise<boolean> {
  if (!harnessWasLaunched) {
    return true;
  }
  const writeStderr = stderrWriter(deps);
  try {
    const agent = await waitForAgentRegistration(request.name, deps);
    await enqueueOpeningPromptDelivery(agent, request, deps, openingPrompt);
    await recordAgentTaskedAtSpawn(request, deps);
    return true;
  } catch (error) {
    const retrySafe =
      error instanceof OpeningPromptDeliveryError && error.retrySafe;
    writeStderr(
      `create-agent-legacy: ${request.resuming ? "resumed" : "launched"} "${request.name}", but its ` +
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
    return false;
  }
}
