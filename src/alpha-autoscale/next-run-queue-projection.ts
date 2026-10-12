import type {
  QueueLaunchBriefReadResult,
  QueueLaunchBriefRow,
} from "../regent-queue/regent-queue-launch-brief.ts";
import type {
  RegentQueueItemRow,
  RegentQueueReadResult,
} from "../regent-queue/regent-queue.store.ts";
import { planIdleRecovery, reopenRows } from "./idle-recovery.ts";
import {
  autoscaleLaunchBriefFor,
  selectRowsToBrief,
  type AutoscaleQueueSource,
} from "./regent-queue-feed.ts";

export interface NextRunQueueProjection {
  readonly source: AutoscaleQueueSource;
  readonly unreadableQueueReason: string | null;
  readonly wouldBrief: readonly string[];
  readonly wouldRecover: string | null;
}

function projectedBriefFor(item: RegentQueueItemRow, nowMs: number): QueueLaunchBriefRow {
  return {
    ...autoscaleLaunchBriefFor(item),
    prBranch: item.prBranch,
    queueItemId: item.id,
    briefedAt: nowMs,
    lifecycle: "active",
    expiredAt: null,
    modelHint: item.modelHint ?? null,
  };
}

function briefsAfterStaging(
  briefs: QueueLaunchBriefReadResult,
  staged: readonly QueueLaunchBriefRow[],
): QueueLaunchBriefReadResult {
  if (briefs.state === "unknown" || staged.length === 0) return briefs;
  const restaged = new Set(staged.map((brief) => brief.queueItemId));
  const kept =
    briefs.state === "briefs"
      ? briefs.briefs.filter((brief) => !restaged.has(brief.queueItemId))
      : [];
  return { state: "briefs", briefs: [...kept, ...staged] };
}

export function projectNextRunQueue(
  queue: RegentQueueReadResult,
  briefs: QueueLaunchBriefReadResult,
  nowMs: number,
): NextRunQueueProjection {
  if (queue.state !== "items") {
    return {
      source: { readAll: () => queue, readLaunchBriefs: () => briefs },
      unreadableQueueReason: queue.state === "unknown" ? queue.reason : null,
      wouldBrief: [],
      wouldRecover: null,
    };
  }
  const { rowsToBrief } = selectRowsToBrief(queue.items);
  const wouldRecover = planIdleRecovery(queue.items)?.objectiveCode ?? null;
  const projectedItems = reopenRows(
    queue.items,
    new Set(wouldRecover === null ? [] : [wouldRecover]),
  );
  const projectedBriefs = briefsAfterStaging(
    briefs,
    rowsToBrief.map((item) => projectedBriefFor(item, nowMs)),
  );
  return {
    source: {
      readAll: () => ({ state: "items", items: projectedItems }),
      readLaunchBriefs: () => projectedBriefs,
    },
    unreadableQueueReason: null,
    wouldBrief: rowsToBrief.map((item) => item.objectiveCode!),
    wouldRecover,
  };
}
