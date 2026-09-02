import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { submitToAgent } from "../herdr/herdr-send.service.ts";
import { clearBlockedMarker } from "../agentdata/blocked-marker.service.ts";
import { markAgentTasked } from "../agentdata/spawn-data-contracts.ts";
import {
  readAgentRole,
  readAgentSupervisor,
  identityFieldForRecording,
  type IdentityLineRead,
} from "../agentdata/identity-data.service.ts";
import {
  productionAlphaMonitoringDependencies,
  recordDeliveredSupervisionEvent,
} from "../alpha-monitoring/alpha-monitoring.ts";
import {
  MessageQueueWorkItemState,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import type { MessageDeliveryWorkItemPayload } from "../send-agent/message-delivery-enqueue.ts";
import { appendSentMessageLedgerEntry } from "../send-agent/sent-message-ledger.ts";
import {
  MAX_NOT_SENT_RETRY_ATTEMPTS,
  NOT_SENT_RETRY_BACKOFF_MS,
  classifySubmitAttemptError,
} from "./message-delivery-retry-policy.ts";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface MessageDeliveryHandlerDeps {
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  submitToAgent: (
    agent: HerdrAgent,
    senderName: string,
    prompt: string,
    options: {
      key?: string;
      omitSenderAttribution?: boolean;
      waitForStartupQuiescence?: boolean;
      disableFileBackedDelivery?: boolean;
    },
  ) => Promise<void>;
  clearBlockedMarker: (name: string) => Promise<void>;
  readAgentRole: (name: string) => Promise<IdentityLineRead>;
  readAgentSupervisor: (name: string) => Promise<IdentityLineRead>;
  recordDeliveredEvent: typeof recordDeliveredSupervisionEvent;
  markAgentTasked?: typeof markAgentTasked;
  appendSentMessageLedgerEntry?: typeof appendSentMessageLedgerEntry;
  now?: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  maxNotSentAttempts: number;
}

export const REAL_MESSAGE_DELIVERY_HANDLER_DEPS: MessageDeliveryHandlerDeps = {
  resolveAgent,
  submitToAgent,
  clearBlockedMarker,
  readAgentRole,
  readAgentSupervisor,
  recordDeliveredEvent: recordDeliveredSupervisionEvent,
  markAgentTasked,
  appendSentMessageLedgerEntry,
  now: Date.now,
  sleep,
  maxNotSentAttempts: MAX_NOT_SENT_RETRY_ATTEMPTS,
};

function workItemPayload(item: WorkItemRow): MessageDeliveryWorkItemPayload {
  return item.payload as MessageDeliveryWorkItemPayload;
}

/**
 * Forwards the payload's optional delivery flags to `submitToAgent`'s
 * options untouched: present when the payload set them, genuinely absent
 * (not a synthesized default) when it didn't, so existing callers that never
 * set these fields get byte-identical options to today.
 */
function forwardedSubmitOptions(
  payload: MessageDeliveryWorkItemPayload,
): {
  key?: string;
  omitSenderAttribution?: boolean;
  waitForStartupQuiescence?: boolean;
  disableFileBackedDelivery?: boolean;
} {
  return {
    ...(payload.key === undefined ? {} : { key: payload.key }),
    ...(payload.omitSenderAttribution === undefined
      ? {}
      : { omitSenderAttribution: payload.omitSenderAttribution }),
    ...(payload.waitForStartupQuiescence === undefined
      ? {}
      : { waitForStartupQuiescence: payload.waitForStartupQuiescence }),
    ...(payload.disableFileBackedDelivery === undefined
      ? {}
      : { disableFileBackedDelivery: payload.disableFileBackedDelivery }),
  };
}

/**
 * Sender attribution and durable receipts, inherited unchanged: the same
 * `recordDeliveredSupervisionEvent` path `send-agent` used to call
 * synchronously, now called by the server after a confirmed send. A failure
 * here is logged, never fatal — the message was already delivered.
 */
async function recordAttributedDelivery(
  payload: MessageDeliveryWorkItemPayload,
  deps: MessageDeliveryHandlerDeps,
): Promise<void> {
  try {
    await deps.recordDeliveredEvent(
      {
        sender: payload.senderName,
        senderRole: identityFieldForRecording(
          await deps.readAgentRole(payload.senderName),
        ),
        senderSupervisor: identityFieldForRecording(
          await deps.readAgentSupervisor(payload.senderName),
        ),
        recipient: payload.recipientName,
        recipientRole: identityFieldForRecording(
          await deps.readAgentRole(payload.recipientName),
        ),
        prompt: payload.prompt,
      },
      productionAlphaMonitoringDependencies(async () => null),
    );
  } catch (error) {
    process.stderr.write(
      `throne-work: delivered, but supervision event recording failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/** Scheduled deliveries receive the same delivery-only receipts only after pane acceptance. */
async function recordScheduledDeliveryBookkeeping(
  item: WorkItemRow,
  payload: MessageDeliveryWorkItemPayload,
  deps: MessageDeliveryHandlerDeps,
): Promise<void> {
  try {
    await deps.markAgentTasked?.(payload.recipientName, new Date((deps.now ?? Date.now)()).toISOString());
  } catch (error) {
    process.stderr.write(`throne-work: scheduled tasked bookkeeping failed, ignoring: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  try {
    await deps.appendSentMessageLedgerEntry?.({
      senderName: payload.senderName,
      recipientName: payload.recipientName,
      id: String(item.id),
      transport: "sqlite",
      sentAtMs: (deps.now ?? Date.now)(),
    });
  } catch (error) {
    process.stderr.write(`throne-work: scheduled sent-message ledger write failed, ignoring: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Delivers one claimed `message-delivery` work item through the existing,
 * unmodified `submitToAgent` path — the sole pane-writing call this server
 * ever makes, inheriting per-recipient serialization, human-draft
 * protection, and file-backed large payloads exactly as they exist today.
 * Applies the retry-safety boundary and moves the item to its terminal
 * state; never leaves it `in-flight`.
 */
export async function deliverMessageWorkItem(
  store: MessageQueueStore,
  item: WorkItemRow,
  deps: MessageDeliveryHandlerDeps = REAL_MESSAGE_DELIVERY_HANDLER_DEPS,
): Promise<WorkItemRow> {
  const payload = workItemPayload(item);
  let attempt = 1;
  for (;;) {
    try {
      const recipient = await deps.resolveAgent(payload.recipientName);
      await deps.submitToAgent(
        recipient,
        payload.senderName,
        payload.prompt,
        forwardedSubmitOptions(payload),
      );
      await recordAttributedDelivery(payload, deps);
      if (item.dueAt !== null) {
        await recordScheduledDeliveryBookkeeping(item, payload, deps);
      }
      if (payload.clearRecipientBlockedOnDelivery) {
        await deps.clearBlockedMarker(payload.recipientName);
      }
      return store.finishWorkItemIdempotently(item.id, MessageQueueWorkItemState.Delivered);
    } catch (error) {
      const outcome = classifySubmitAttemptError(error, attempt, deps.maxNotSentAttempts);
      if (outcome.kind === "retry") {
        attempt += 1;
        await deps.sleep(NOT_SENT_RETRY_BACKOFF_MS);
        continue;
      }
      return store.finishWorkItemIdempotently(item.id, MessageQueueWorkItemState.Failed, {
        failureReason: outcome.reason,
      });
    }
  }
}
