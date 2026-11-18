import type { DatabaseSync } from "node:sqlite";
import { recordDeliveryFailureNoticeSafely } from "./delivery-failure-notice.store.ts";
import { MessageQueueWorkItemState } from "./message-queue-work-item-state.ts";

export function requeueLostAcceptedWorkItem(
  db: DatabaseSync,
  id: number,
  failureReason: string,
  timestamp: number,
): boolean {
  const requeued = db
    .prepare(`UPDATE work_items SET state = ?, due_at = NULL, updated_at = ? WHERE id = ? AND state = ? RETURNING payload`)
    .get(MessageQueueWorkItemState.Queued, timestamp, id, MessageQueueWorkItemState.Accepted) as
    | { payload: string }
    | undefined;
  if (requeued === undefined) return false;
  recordDeliveryFailureNoticeSafely(db, { id, payload: JSON.parse(requeued.payload) as unknown, failureReason }, timestamp);
  return true;
}
