// Pure bucketing for the eligibility-depth checker (Lord ruling 2026-08-17,
// rule 5): decides, for every open Regent queue item, which of three
// mutually exclusive starvation causes it belongs to. Read-only against a
// `RegentQueueReadResult` already in hand -- no store access of its own.

import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { classifyEffectiveQueueDecision } from "../regent-queue/regent-queue-dispatch.ts";
import type { RegentQueueItemRow } from "../regent-queue/regent-queue.store.ts";
import type { EligibleQueueLaunchMetadata } from "../regent-queue/regent-queue-launch-brief.ts";

/** Injected freshness lookup: is `baseCommit` still `targetBranch`'s tip in `targetRepo`? Production wiring supplies this from `localBranchTip`. */
export type EligibilityDepthBaseFreshnessCheck = (
  targetRepo: string,
  targetBranch: string,
  baseCommit: string,
) => Promise<boolean>;

export interface EligibilityDepthBuckets {
  /** Marked, real metadata, fresh base -- eligible and unlaunched right now. */
  readonly depth: readonly RegentQueueItemRow[];
  /** Marked, real metadata, but the recorded base is no longer the branch tip. */
  readonly staleBase: readonly RegentQueueItemRow[];
  /** Never marked, or marked with incomplete metadata. */
  readonly unmarked: readonly RegentQueueItemRow[];
}

function isOpenQueueItemEligibleForDispatch(item: RegentQueueItemRow): boolean {
  return (
    item.status === RegentQueueItemStatus.Open &&
    classifyEffectiveQueueDecision(item).state === "eligible"
  );
}

function hasCompleteLaunchMetadata(
  item: RegentQueueItemRow,
): item is RegentQueueItemRow & {
  readonly launchEligibility: { eligible: true } & EligibleQueueLaunchMetadata;
} {
  return item.launchEligibility?.eligible === true;
}

export async function bucketQueueItemsForEligibilityDepth(
  items: readonly RegentQueueItemRow[],
  isBaseFresh: EligibilityDepthBaseFreshnessCheck,
): Promise<EligibilityDepthBuckets> {
  const depth: RegentQueueItemRow[] = [];
  const staleBase: RegentQueueItemRow[] = [];
  const unmarked: RegentQueueItemRow[] = [];
  for (const item of items) {
    if (!isOpenQueueItemEligibleForDispatch(item)) continue;
    if (!hasCompleteLaunchMetadata(item)) {
      unmarked.push(item);
      continue;
    }
    const { targetRepo, targetBranch, baseCommit } = item.launchEligibility;
    const fresh = await isBaseFresh(targetRepo, targetBranch, baseCommit);
    (fresh ? depth : staleBase).push(item);
  }
  return { depth, staleBase, unmarked };
}
