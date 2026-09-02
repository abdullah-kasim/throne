// The shared enqueue path for internal, in-process callers that used to call
// `submitToAgent` directly (keep-going, no-idling, switch-persona-broadcast).
// Mirrors exactly what `send-agent`'s enqueue path already does — the same
// degraded-court stderr warning and the same sustained-outage observer call
// — so converting a caller to the durable queue never quietly drops either
// safety net. Kept out of `send-agent/message-delivery-enqueue.ts` itself to
// avoid a cycle: `sustained-outage-notifier.ts` already imports
// `isHeartbeatStale` from that module.
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
  formatDegradedCourtWarning,
  isHeartbeatStale,
  type MessageDeliveryWorkItemPayload,
} from "../send-agent/message-delivery-enqueue.ts";
import {
  openMessageQueueStore,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import { checkAndNotifySustainedOutage } from "./sustained-outage-notifier.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import type { SubmitToAgentOptions } from "../herdr/herdr-send.types.ts";

export interface EnqueueHeartbeatMessageDeps {
  now: () => number;
  writeStderr: (text: string) => void;
  checkSustainedOutage: typeof checkAndNotifySustainedOutage;
}

export const REAL_ENQUEUE_HEARTBEAT_MESSAGE_DEPS: EnqueueHeartbeatMessageDeps = {
  now: Date.now,
  writeStderr: (text) => process.stderr.write(text),
  checkSustainedOutage: checkAndNotifySustainedOutage,
};

/**
 * The two stderr-visible safety checks EVERY enqueue into this queue must
 * run, whatever kind of work item it writes — the immediate degraded-court
 * warning (heartbeat stale/absent) before the write, and the deduplicated
 * sustained-outage notify-lord escalation after it. Shared by every enqueue
 * path (message-delivery here, regent-resurrection in
 * `regent-resurrection.ts`) so a green-but-undelivered unit is never silent:
 * an enqueue into a dead queue always surfaces on stderr immediately and
 * escalates to the Lord if the outage lasts. Never throws on the escalation
 * check — a queue write must not fail because the alerting side-channel had
 * trouble.
 */
export async function warnIfDegradedAndCheckSustainedOutage(
  store: MessageQueueStore,
  deps: EnqueueHeartbeatMessageDeps,
): Promise<void> {
  if (isHeartbeatStale(store.readHeartbeat(), deps.now())) {
    deps.writeStderr(formatDegradedCourtWarning());
  }
  try {
    await deps.checkSustainedOutage(store, deps.now);
  } catch (error) {
    deps.writeStderr(
      `enqueue: sustained-outage check failed, ignoring: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/**
 * Enqueues a `message-delivery` work item and runs both stderr-visible
 * safety checks a caller that used to write to the pane synchronously would
 * otherwise silently lose. See `warnIfDegradedAndCheckSustainedOutage`.
 */
export async function enqueueHeartbeatMessage(
  store: MessageQueueStore,
  payload: MessageDeliveryWorkItemPayload,
  deps: EnqueueHeartbeatMessageDeps = REAL_ENQUEUE_HEARTBEAT_MESSAGE_DEPS,
): Promise<WorkItemRow> {
  await warnIfDegradedAndCheckSustainedOutage(store, deps);
  return enqueueMessageDelivery(store, buildMessageDeliveryWorkItemPayload(payload));
}

/**
 * Drop-in replacement for `submitToAgent` (same call shape: recipient,
 * sender, prompt, options) for internal callers — `keep-going`,
 * `no-idling`, `switch-persona` — that previously called the synchronous
 * pane-write path directly. Opens and closes its own queue handle per call,
 * matching `send-agent`'s own per-invocation store lifecycle: each of these
 * callers is a short-lived CLI process, not a long-running server. Never
 * clears a recipient's blocked marker — none of these three callers'
 * pre-conversion `submitToAgent` calls did either; only `send-agent`'s own
 * command layer clears markers, and only for its own sender.
 */
export async function submitToAgentViaQueue(
  target: HerdrAgent,
  senderName: string,
  prompt: string,
  options: SubmitToAgentOptions = {},
  deps: EnqueueHeartbeatMessageDeps = REAL_ENQUEUE_HEARTBEAT_MESSAGE_DEPS,
  openStore: () => MessageQueueStore = openMessageQueueStore,
): Promise<void> {
  const store = openStore();
  try {
    await enqueueHeartbeatMessage(
      store,
      {
        recipientName: target.name ?? "",
        recipientPaneId: target.paneId ?? "",
        senderName,
        prompt,
        ...(options.key === undefined ? {} : { key: options.key }),
        clearRecipientBlockedOnDelivery: false,
      },
      deps,
    );
  } finally {
    store.close();
  }
}
