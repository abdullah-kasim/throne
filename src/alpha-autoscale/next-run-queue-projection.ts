import type {
  QueueLaunchBriefReadResult,
  QueueLaunchBriefRow,
} from "../regent-queue/regent-queue-launch-brief.ts";
import type {
  RegentQueueItemRow,
  RegentQueueReadResult,
} from "../regent-queue/regent-queue.store.ts";
import type { DeferralRelease } from "./deferral-release.ts";
import { planDeferralPromotion, reopenRows } from "./deferral-promotion.ts";
import {
  autoscaleLaunchBriefFor,
  selectRowsToBrief,
  type AutoscaleQueueSource,
} from "./regent-queue-feed.ts";

export interface NextRunQueueProjection {
  readonly source: AutoscaleQueueSource;
  readonly unreadableQueueReason: string | null;
  readonly wouldBrief: readonly string[];
  readonly wouldRelease: readonly DeferralRelease[];
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
      wouldRelease: [],
      wouldRecover: null,
    };
  }
  const { rowsToBrief } = selectRowsToBrief(queue.items);
  const plan = planDeferralPromotion(queue.items);
  const wouldRecover = plan.recovered?.objectiveCode ?? null;
  const promotedCodes = new Set([
    ...plan.released.map((release) => release.objectiveCode),
    ...(wouldRecover === null ? [] : [wouldRecover]),
  ]);
  const projectedItems = reopenRows(queue.items, promotedCodes);
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
    wouldRelease: plan.released,
    wouldRecover,
  };
}
