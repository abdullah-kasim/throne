import type { MessageQueueStore, WorkItemRow } from "../message-queue/message-queue.store.ts";

/** The one work kind this campaign registers on the durable queue. */
export const MESSAGE_DELIVERY_WORK_ITEM_KIND = "message-delivery";

/**
 * How long the server's heartbeat may go unwritten before an enqueuing
 * caller is warned the court may be unattended. A couple of missed poll
 * cycles, not a single tick — short enough to catch a genuinely dead or
 * never-started server, long enough that ordinary poll jitter never fires
 * it.
 */
export const HEARTBEAT_STALENESS_THRESHOLD_MS = 60_000;

/** True when the server's last heartbeat is missing or too old to trust. */
export function isHeartbeatStale(
  heartbeatTimestamp: number | undefined,
  now: number,
  thresholdMilliseconds: number = HEARTBEAT_STALENESS_THRESHOLD_MS,
): boolean {
  if (heartbeatTimestamp === undefined) return true;
  return now - heartbeatTimestamp >= thresholdMilliseconds;
}

/** The synchronous, unmistakable warning printed to stderr on a stale/absent heartbeat. */
export function formatDegradedCourtWarning(): string {
  return (
    "send-agent: DEGRADED COURT — the message-delivery work server's heartbeat " +
    "is stale or absent. The message was queued durably and this call still " +
    "exits 0, but nothing may be draining the queue right now. Poll " +
    "message-status <id> to check delivery, or use --direct as manual recovery " +
    "if the queue/server path is confirmed broken.\n"
  );
}

/**
 * Everything the eventual work-processor server needs to perform the send
 * without re-resolving "who is this from" or "who is this to" after the
 * enqueuing process has already exited.
 */
export interface MessageDeliveryWorkItemPayload {
  readonly recipientName: string;
  readonly recipientPaneId: string;
  readonly senderName: string;
  readonly prompt: string;
  readonly key?: string;
  readonly clearRecipientBlockedOnDelivery: boolean;
  readonly omitSenderAttribution?: boolean;
  readonly waitForStartupQuiescence?: boolean;
  readonly disableFileBackedDelivery?: boolean;
  /** Present only for durable one-shot schedules; immediate delivery leaves it absent. */
  readonly dueAtMs?: number;
}

export function buildMessageDeliveryWorkItemPayload(
  fields: MessageDeliveryWorkItemPayload,
): MessageDeliveryWorkItemPayload {
  return fields;
}

/**
 * Writes one durable `message-delivery` row; the sender's whole job. A
 * `payload.key` doubles as the row's dedupe key: enqueuing a second item
 * with the same key while the first is still `queued` supersedes the first
 * rather than stacking both for eventual double delivery (see
 * `MessageQueueStore.insertWorkItem`'s `dedupeKey`).
 */
export function enqueueMessageDelivery(
  store: MessageQueueStore,
  payload: MessageDeliveryWorkItemPayload,
): WorkItemRow {
  return store.insertWorkItem({
    kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
    payload,
    ...(payload.key === undefined ? {} : { dedupeKey: payload.key }),
    ...(payload.dueAtMs === undefined ? {} : { dueAt: payload.dueAtMs }),
  });
}
