import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
  type RetentionSweepResult,
} from "../message-queue/message-queue.store.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from "../send-agent/message-delivery-enqueue.ts";
import {
  REAL_SUSTAINED_OUTAGE_NOTIFIER_DEPS,
  checkAndNotifySustainedOutage,
  type SustainedOutageNotifierDeps,
} from "./sustained-outage-notifier.ts";

/**
 * The Regent's single-command reachability proof. Three verdicts, chosen to
 * read unambiguously "in a hurry on a night when the court has stopped
 * talking": distinct words, distinct exit codes, ordered worst-to-best by
 * neither — each is checked independently below.
 */
export const QueueHealthVerdict = {
  Healthy: "HEALTHY",
  Degraded: "DEGRADED",
  Down: "DOWN",
} as const;

export type QueueHealthVerdict = (typeof QueueHealthVerdict)[keyof typeof QueueHealthVerdict];

export const QUEUE_HEALTH_EXIT_CODE: Readonly<Record<QueueHealthVerdict, number>> = {
  [QueueHealthVerdict.Healthy]: 0,
  [QueueHealthVerdict.Degraded]: 1,
  [QueueHealthVerdict.Down]: 2,
};

export const QUEUE_HEALTH_POLL_WINDOW_MS = 10_000;
export const QUEUE_HEALTH_POLL_INTERVAL_MS = 250;

function verdictLine(verdict: QueueHealthVerdict): string {
  switch (verdict) {
    case QueueHealthVerdict.Healthy:
      return "HEALTHY — the probe was enqueued and delivered within the window. The court is reachable.\n";
    case QueueHealthVerdict.Degraded:
      return "DEGRADED — the work server's heartbeat is stale, but some progress was observed. Investigate.\n";
    case QueueHealthVerdict.Down:
      return "DOWN — no heartbeat and the probe was never claimed. The work server is not draining the queue.\n";
  }
}

/** The observable retention surface: how many rows the last sweep removed and when it last ran. */
function retentionSweepLine(lastSweep: RetentionSweepResult | undefined): string {
  if (lastSweep === undefined) {
    return "retention sweep: never run yet.\n";
  }
  return `retention sweep: removed ${lastSweep.sweptCount} row(s), last ran ${new Date(lastSweep.sweptAt).toISOString()}.\n`;
}

export function formatQueueHealthOutput(
  verdict: QueueHealthVerdict,
  lastSweep?: RetentionSweepResult,
): string {
  return verdictLine(verdict) + retentionSweepLine(lastSweep);
}

function classifyQueueHealthVerdict(
  probeDelivered: boolean,
  heartbeatAdvancedDuringPoll: boolean,
): QueueHealthVerdict {
  if (probeDelivered) return QueueHealthVerdict.Healthy;
  return heartbeatAdvancedDuringPoll ? QueueHealthVerdict.Degraded : QueueHealthVerdict.Down;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface QueueHealthCheckDeps {
  openStore: () => MessageQueueStore;
  resolveCurrentAgentName: () => Promise<string>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pollWindowMs: number;
  pollIntervalMs: number;
  notifierDeps: SustainedOutageNotifierDeps;
}

const REAL_DEPS: QueueHealthCheckDeps = {
  openStore: () => openMessageQueueStore(),
  resolveCurrentAgentName,
  now: () => Date.now(),
  sleep,
  pollWindowMs: QUEUE_HEALTH_POLL_WINDOW_MS,
  pollIntervalMs: QUEUE_HEALTH_POLL_INTERVAL_MS,
  notifierDeps: REAL_SUSTAINED_OUTAGE_NOTIFIER_DEPS,
};

/**
 * Enqueues one synthetic self-addressed probe through the real queue and
 * polls it to a terminal state within a bounded window, exactly like an
 * ordinary caller would. Also runs the sustained-outage check — the
 * Regent's own `queue-health` invocation is one of the two observers named
 * in the outage-notification contract.
 */
export interface QueueHealthCheckResult {
  readonly verdict: QueueHealthVerdict;
  readonly lastRetentionSweep: RetentionSweepResult | undefined;
}

export async function runQueueHealthCheck(
  deps: QueueHealthCheckDeps = REAL_DEPS,
): Promise<QueueHealthCheckResult> {
  const recipientName = await deps.resolveCurrentAgentName();
  const store = deps.openStore();
  try {
    const baselineHeartbeat = store.readHeartbeat();
    const probe = enqueueMessageDelivery(
      store,
      buildMessageDeliveryWorkItemPayload({
        recipientName,
        recipientPaneId: "",
        senderName: recipientName,
        prompt: "throne-work queue-health probe — safe to ignore, self-addressed reachability check.",
        clearRecipientBlockedOnDelivery: false,
      }),
    );

    const deadline = deps.now() + deps.pollWindowMs;
    let probeDelivered = false;
    while (deps.now() < deadline) {
      const current = store.readWorkItem(probe.id);
      if (current?.state === MessageQueueWorkItemState.Delivered) {
        probeDelivered = true;
        break;
      }
      await deps.sleep(deps.pollIntervalMs);
    }

    const heartbeatAdvancedDuringPoll =
      store.readHeartbeat() !== undefined && store.readHeartbeat() !== baselineHeartbeat;
    const verdict = classifyQueueHealthVerdict(probeDelivered, heartbeatAdvancedDuringPoll);

    await checkAndNotifySustainedOutage(store, deps.now, deps.notifierDeps);

    return { verdict, lastRetentionSweep: store.readLastRetentionSweep() };
  } finally {
    store.close();
  }
}
