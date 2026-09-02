// Observe-and-report only: composes todo 01's pure bucketing and shortfall
// marker into the eligibility-depth checker (Lord ruling 2026-08-17, rule
// 5) -- one more line of keep-going's existing per-tick report, mirroring
// keep-going-backlog-report.ts's shape (store read + pure formatter). This
// module has zero authority to mark, mutate, or launch anything -- it reads
// the Regent queue store and a durable marker file, and produces text. No
// spawn action is reachable from here (proven structurally by
// keep-going-eligibility-depth-report-no-spawn-path.test.ts).
//
// Wording is declarative, never imperative (startupnoop lesson:
// subjectless imperatives get obeyed) -- unlike the sibling backlog line's
// `RUN:` phrasing, which stays as-is and is not copied here.

import { openRegentQueueStore } from '../regent-queue/regent-queue.store.ts';
import type { RegentQueueItemRow } from '../regent-queue/regent-queue.store.ts';
import { localBranchTip } from '../git-lifecycle/branch-authority.ts';
import {
  bucketQueueItemsForEligibilityDepth,
  type EligibilityDepthBaseFreshnessCheck,
  type EligibilityDepthBuckets,
} from './keep-going-eligibility-depth.ts';
import {
  openEligibilityDepthShortfallMarkerStore,
  recordEligibilityDepthShortfallReading,
  type EligibilityDepthShortfallMarkerStore,
} from './keep-going-eligibility-depth-escalation.ts';

/** Rule 5's target floor: the depth report line renders only below this count. */
const ELIGIBILITY_DEPTH_TARGET = 4;
/** How many stale-base candidates the depth line names, priority then recency. */
const TOP_STALE_BASE_CANDIDATE_COUNT = 3;
const ESCALATION_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** Production freshness check: is the recorded base still `targetBranch`'s tip in `targetRepo`? */
export const localBranchTipBaseFreshnessCheck: EligibilityDepthBaseFreshnessCheck = async (
  targetRepo,
  targetBranch,
  baseCommit,
) => (await localBranchTip(targetRepo, targetBranch)) === baseCommit;

function eligibilityDepthShortfallHolds(buckets: EligibilityDepthBuckets): boolean {
  return (
    buckets.depth.length < ELIGIBILITY_DEPTH_TARGET &&
    buckets.staleBase.length + buckets.unmarked.length > 0
  );
}

function staleBaseCandidateName(item: RegentQueueItemRow): string {
  return item.objectiveCode ?? item.id;
}

function topStaleBaseCandidates(staleBase: readonly RegentQueueItemRow[]): readonly string[] {
  return [...staleBase]
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
    .slice(0, TOP_STALE_BASE_CANDIDATE_COUNT)
    .map(staleBaseCandidateName);
}

/**
 * Renders the depth-shortfall report line. Silent (empty string) unless the
 * level-trigger condition holds: fewer than `ELIGIBILITY_DEPTH_TARGET`
 * genuinely launchable items AND at least one backlogged item (stale-based
 * or unmarked) exists to explain the shortfall -- a shortfall with nothing
 * backlogged is a satisfied rule, not a finding (Rule 4).
 */
export function formatEligibilityDepthReportLine(buckets: EligibilityDepthBuckets): string {
  if (!eligibilityDepthShortfallHolds(buckets)) {
    return '';
  }
  const candidates = topStaleBaseCandidates(buckets.staleBase);
  const staleBaseClause =
    candidates.length > 0
      ? `stale-based candidate(s) needing a re-mark: ${candidates.join(', ')}`
      : 'no stale-based candidates';
  return (
    `keep-going: eligible-unlaunched depth is ${buckets.depth.length}, below the ` +
    `${ELIGIBILITY_DEPTH_TARGET}-6 target -- ${staleBaseClause}; ` +
    `${buckets.unmarked.length} unmarked item(s) also backlogged.\n`
  );
}

/**
 * Renders the Lord-facing escalation line. Silent unless the shortfall
 * marker shows the condition has held continuously past 6 hours; silent
 * again the instant the marker clears.
 */
export function formatEligibilityDepthEscalationLine(
  sinceMs: number | undefined,
  nowMs: number,
  buckets: EligibilityDepthBuckets,
): string {
  if (sinceMs === undefined || nowMs - sinceMs <= ESCALATION_THRESHOLD_MS) {
    return '';
  }
  const backlogCount = buckets.staleBase.length + buckets.unmarked.length;
  return (
    `keep-going: Lord escalation -- eligible-unlaunched depth has stayed below ` +
    `${ELIGIBILITY_DEPTH_TARGET} for over 6 hours with ${backlogCount} backlogged ` +
    `item(s) still unlaunched (currently ${buckets.depth.length} eligible).\n`
  );
}

function readAllQueueItems(databasePath?: string): readonly RegentQueueItemRow[] {
  const store =
    databasePath === undefined ? openRegentQueueStore() : openRegentQueueStore(databasePath);
  try {
    const result = store.readAll();
    return result.state === 'items' ? result.items : [];
  } finally {
    store.close();
  }
}

/**
 * Composes todo 01's bucketing and shortfall marker into this tick's
 * eligibility-depth contribution to the keep-going report: the depth line,
 * plus the Lord-escalation line when applicable. Reads the Regent queue
 * store and the durable marker file; never mutates either. Parameters are
 * only for tests to inject fixtures -- production always calls this with no
 * arguments.
 */
export async function renderKeepGoingEligibilityDepthReport(
  databasePath?: string,
  isBaseFresh: EligibilityDepthBaseFreshnessCheck = localBranchTipBaseFreshnessCheck,
  markerStore: EligibilityDepthShortfallMarkerStore = openEligibilityDepthShortfallMarkerStore(),
  now: () => number = Date.now,
): Promise<string> {
  const buckets = await bucketQueueItemsForEligibilityDepth(
    readAllQueueItems(databasePath),
    isBaseFresh,
  );
  const nowMs = now();
  const sinceMs = await recordEligibilityDepthShortfallReading(
    markerStore,
    eligibilityDepthShortfallHolds(buckets),
    nowMs,
  );
  return (
    formatEligibilityDepthReportLine(buckets) +
    formatEligibilityDepthEscalationLine(sinceMs, nowMs, buckets)
  );
}
