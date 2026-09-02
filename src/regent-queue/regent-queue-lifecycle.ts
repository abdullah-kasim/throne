import {
  RegentQueueItemStatus,
  isForwardQueueItemStatusTransition,
} from "./regent-queue-item-state.ts";
import type {
  RegentQueueItemRow,
  RegentQueueStore,
} from "./regent-queue.store.ts";

/**
 * `create-agent`'s and `reap-agent`'s shared lifecycle write-back engine:
 * ONE named lookup per direction (by objective code for a launch, by the
 * agent name a prior launch recorded for a reap), and ONE mapping from a
 * reap reason to the queue status it produces. Both commands are thin
 * callers that supply linkage fields and apply the returned outcome; neither
 * re-derives a matching heuristic of its own, per the Regent's binding
 * ruling on this slice.
 */

export function findQueueItemByObjectiveCode(
  store: RegentQueueStore,
  objectiveCode: string,
): RegentQueueItemRow | undefined {
  const direct = store.readItem(objectiveCode);
  if (direct !== undefined && direct.objectiveCode === objectiveCode) {
    return direct;
  }
  const all = store.readAll();
  if (all.state !== "items") return undefined;
  return all.items.find((item) => item.objectiveCode === objectiveCode);
}

export function findInFlightQueueItemByAgentName(
  store: RegentQueueStore,
  agentName: string,
): RegentQueueItemRow | undefined {
  const all = store.readAll();
  if (all.state !== "items") return undefined;
  return all.items.find(
    (item) =>
      item.status === RegentQueueItemStatus.InFlight &&
      item.agentName === agentName,
  );
}

export type QueueLifecycleWriteOutcome =
  | { readonly matched: true; readonly item: RegentQueueItemRow }
  | { readonly matched: false; readonly reason: string };

export interface QueueLaunchLinkage {
  readonly objectiveCode: string;
  readonly agentName: string;
  readonly targetRepo?: string;
  readonly baseCommit?: string;
}

/**
 * Launch matching: looks the queue item up by the objective code
 * `create-agent` is launching with, then transitions it `open -> in-flight`
 * recording the four linkage fields the Regent named (agent name, objective
 * code — implicit in which item matched, target repo, base commit). An item
 * already `in-flight`/terminal is a legitimate outcome (a relaunch racing an
 * unmarked prior launch, or an ad-hoc spawn with no queue entry at all) and
 * is reported unmatched rather than silently overwritten or thrown on.
 */
export function recordAgentLaunchOnQueueItem(
  store: RegentQueueStore,
  linkage: QueueLaunchLinkage,
): QueueLifecycleWriteOutcome {
  const item = findQueueItemByObjectiveCode(store, linkage.objectiveCode);
  if (item === undefined) {
    return {
      matched: false,
      reason: `no queue item recorded under objective code "${linkage.objectiveCode}"`,
    };
  }
  if (
    !isForwardQueueItemStatusTransition(
      item.status,
      RegentQueueItemStatus.InFlight,
    )
  ) {
    return {
      matched: false,
      reason: `queue item "${item.id}" is already "${item.status}" — not overwriting its launch linkage`,
    };
  }
  const updated = store.transitionStatus(
    item.id,
    RegentQueueItemStatus.InFlight,
    {
      agentName: linkage.agentName,
      targetRepo: linkage.targetRepo,
      baseCommit: linkage.baseCommit,
    },
  );
  return { matched: true, item: updated };
}

/**
 * The Lord's exact status mapping for a reap outcome — `completed` ->
 * `complete`, `superseded` -> `complete` (the objective's content was
 * independently delivered under different provenance — the same real-world
 * outcome as `completed`, just proven differently), `cancelled` -> `open`
 * (the item is available for a future relaunch attempt), `force` ->
 * `abandoned` (a forced teardown never claims completion). Every other reap
 * reason has no entry: see this slice's question-log Q5 for why that is a
 * deliberate no-op, not an omission.
 */
const REAP_REASON_QUEUE_STATUS: Readonly<
  Partial<Record<string, RegentQueueItemStatus>>
> = {
  completed: RegentQueueItemStatus.Complete,
  superseded: RegentQueueItemStatus.Complete,
  "completed-unpublishable": RegentQueueItemStatus.Abandoned,
  cancelled: RegentQueueItemStatus.Open,
  force: RegentQueueItemStatus.Abandoned,
};

export function queueStatusForReapReason(
  reason: string,
): RegentQueueItemStatus | undefined {
  return REAP_REASON_QUEUE_STATUS[reason];
}

export interface QueueReapOutcome {
  readonly agentName: string;
  readonly reason: string;
  readonly deliveryCommit?: string;
}

/**
 * Reap matching: looks the queue item up by the agent name `create-agent`'s
 * own write-back recorded on it (never by re-parsing the agent name for an
 * objective code — that heuristic belongs to `queue-automark`, which this
 * bundle supersedes), then transitions it per
 * `queueStatusForReapReason`. An unmapped reason, a name with no matching
 * in-flight item, or a matched item whose current status cannot move
 * forward to the mapped target are all reported unmatched rather than
 * thrown on.
 */
export function recordAgentReapOutcomeOnQueueItem(
  store: RegentQueueStore,
  outcome: QueueReapOutcome,
): QueueLifecycleWriteOutcome {
  const targetStatus = queueStatusForReapReason(outcome.reason);
  if (targetStatus === undefined) {
    return {
      matched: false,
      reason: `reap reason "${outcome.reason}" has no queue status mapping`,
    };
  }
  const item = findInFlightQueueItemByAgentName(store, outcome.agentName);
  if (item === undefined) {
    return {
      matched: false,
      reason: `no in-flight queue item recorded under agent name "${outcome.agentName}"`,
    };
  }
  if (!isForwardQueueItemStatusTransition(item.status, targetStatus)) {
    return {
      matched: false,
      reason: `queue item "${item.id}" cannot move ${item.status} -> ${targetStatus}`,
    };
  }
  const updated = store.transitionStatus(item.id, targetStatus, {
    deliveryCommit: outcome.deliveryCommit,
  });
  return { matched: true, item: updated };
}
