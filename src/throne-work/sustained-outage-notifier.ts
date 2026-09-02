import { isHeartbeatStale } from "../send-agent/message-delivery-enqueue.ts";
import { runNotifyLord } from "../notify-lord/notify-lord.command.ts";
import type { MessageQueueStore } from "../message-queue/message-queue.store.ts";
import { type OutageMarker, openOutageMarkerStore } from "./outage-marker.store.ts";

/**
 * How stale the heartbeat must be before this counts as a sustained outage
 * worth waking the Lord for, as opposed to `send-agent`'s immediate
 * per-enqueue stderr warning (60s). Deliberately several multiples of that
 * threshold so a single transient blip — one missed poll cycle, a brief GC
 * pause — never fires the out-of-band alert; only a genuinely dead or
 * wedged server does.
 */
export const SUSTAINED_OUTAGE_THRESHOLD_MS = 5 * 60_000;

function formatSustainedOutageMessage(): string {
  return (
    "Sustained outage: the throne-work message-delivery server's heartbeat " +
    `has been stale for over ${SUSTAINED_OUTAGE_THRESHOLD_MS / 60_000} minutes. ` +
    "Queued messages are not being delivered. Recheck with: queue-health."
  );
}

export interface SustainedOutageNotifierDeps {
  openOutageMarkerStore: (databasePath?: string) => OutageMarker;
  notifyLord: (args: string[]) => Promise<number>;
  thresholdMs: number;
  writeStderr: (text: string) => void;
}

export const REAL_SUSTAINED_OUTAGE_NOTIFIER_DEPS: SustainedOutageNotifierDeps = {
  openOutageMarkerStore,
  notifyLord: runNotifyLord,
  thresholdMs: SUSTAINED_OUTAGE_THRESHOLD_MS,
  writeStderr: (text) => process.stderr.write(text),
};

/**
 * The first observer — any `send-agent` enqueue or `queue-health` run —
 * that finds the heartbeat stale past the sustained threshold while no
 * outage marker is active fires exactly one `notify-lord`, verified by its
 * actual return outcome (not a bare exit code), and sets the durable
 * marker. A later observer that finds the heartbeat healthy again clears
 * the marker, re-arming the alert for a fresh future outage. A verified
 * notify-lord failure logs and leaves the marker unset so the next
 * observer retries — it never crashes the calling command.
 */
export async function checkAndNotifySustainedOutage(
  store: MessageQueueStore,
  now: () => number,
  deps: SustainedOutageNotifierDeps = REAL_SUSTAINED_OUTAGE_NOTIFIER_DEPS,
): Promise<void> {
  const stale = isHeartbeatStale(store.readHeartbeat(), now(), deps.thresholdMs);
  const markerStore = deps.openOutageMarkerStore();
  try {
    const alreadyNotified = markerStore.isActive();
    if (stale && !alreadyNotified) {
      const deliveryOutcome = await deps.notifyLord([formatSustainedOutageMessage()]);
      if (deliveryOutcome === 0) {
        markerStore.setActive(now());
      } else {
        deps.writeStderr(
          "throne-work: sustained-outage notify-lord attempt was not verified delivered; " +
            "marker left unset so the next observer retries.\n",
        );
      }
    } else if (!stale && alreadyNotified) {
      markerStore.clear();
    }
  } finally {
    markerStore.close();
  }
}
