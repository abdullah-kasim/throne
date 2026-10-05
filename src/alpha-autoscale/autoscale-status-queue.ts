import type { ReadyQueueResult } from "../alpha-launch-queue/ready-queue.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type {
  RegentQueueItemRow,
  RegentQueueReadResult,
} from "../regent-queue/regent-queue.store.ts";
import { orderQueueItemsForDispatch } from "../regent-queue/regent-queue-dispatch.ts";
import type { NextRunQueueProjection } from "./next-run-queue-projection.ts";
import { effectiveIneligibilityReason } from "./regent-queue-feed.ts";

export interface LaunchableQueueRow {
  readonly objectiveCode: string;
  readonly priority: number | null;
  readonly alphaName: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly modelHint: string | null;
  readonly sliceless: boolean;
  readonly shadowless: boolean;
}

export interface HeldQueueRow {
  readonly objectiveCode: string;
  readonly reason: string;
}

export interface DeferredQueueRow {
  readonly objectiveCode: string;
  readonly priority: number;
  readonly waitsOn: readonly string[];
  readonly releaseAuthority: string | null;
  readonly reason: string | null;
  readonly wouldRelease: boolean;
}

export interface InFlightQueueRow {
  readonly objectiveCode: string;
  readonly alphaName: string | null;
}

export interface AutoscaleStatusQueue {
  readonly readyQueue: ReadyQueueResult["state"];
  readonly readyQueueReasons: readonly string[];
  readonly launchable: readonly LaunchableQueueRow[];
  readonly notLaunchable: readonly HeldQueueRow[];
  readonly deferred: readonly DeferredQueueRow[];
  readonly inFlight: readonly InFlightQueueRow[];
  readonly wouldBrief: readonly string[];
  readonly wouldRecover: string | null;
  readonly mutatingTargets: readonly string[];
}

function queueItems(queue: RegentQueueReadResult): RegentQueueItemRow[] {
  return queue.state === "items" ? orderQueueItemsForDispatch(queue.items) : [];
}

function readyQueueReasons(readyQueue: ReadyQueueResult): string[] {
  if (readyQueue.state === "ineligible") return readyQueue.reasons;
  if (readyQueue.state === "unknown") return [readyQueue.reason];
  return [];
}

function launchableRows(
  readyQueue: ReadyQueueResult,
  items: readonly RegentQueueItemRow[],
): LaunchableQueueRow[] {
  if (readyQueue.state !== "candidates") return [];
  return readyQueue.candidates.map((candidate) => ({
    objectiveCode: candidate.objectiveCode,
    priority:
      items.find((item) => item.objectiveCode === candidate.objectiveCode)?.priority ?? null,
    alphaName: candidate.name,
    targetRepo: candidate.targetRepo,
    targetBranch: candidate.targetBranch,
    modelHint:
      candidate.modelHint === null || candidate.modelHint === undefined
        ? null
        : `${candidate.modelHint.harness}/${candidate.modelHint.model}`,
    sliceless: candidate.sliceless === true,
    shadowless: candidate.shadowless === true,
  }));
}

function rowsWithStatus(
  items: readonly RegentQueueItemRow[],
  status: RegentQueueItemStatus,
): RegentQueueItemRow[] {
  return items.filter((item) => item.status === status && item.objectiveCode !== null);
}

export function describeAutoscaleStatusQueue(
  queueAsRead: RegentQueueReadResult,
  projection: NextRunQueueProjection,
  readyQueue: ReadyQueueResult,
  mutatingTargets: readonly string[],
): AutoscaleStatusQueue {
  const items = queueItems(queueAsRead);
  const projectedItems = queueItems(projection.source.readAll());
  const launchable = launchableRows(readyQueue, items);
  const launchableCodes = new Set(launchable.map((row) => row.objectiveCode));
  const releasedCodes = new Set(projection.wouldRelease.map((release) => release.objectiveCode));
  return {
    readyQueue: readyQueue.state,
    readyQueueReasons: readyQueueReasons(readyQueue),
    launchable,
    notLaunchable: rowsWithStatus(projectedItems, RegentQueueItemStatus.Open)
      .filter((item) => !launchableCodes.has(item.objectiveCode!))
      .map((item) => ({
        objectiveCode: item.objectiveCode!,
        reason: effectiveIneligibilityReason(item),
      })),
    deferred: rowsWithStatus(items, RegentQueueItemStatus.Deferred).map((item) => ({
      objectiveCode: item.objectiveCode!,
      priority: item.priority,
      waitsOn: item.deferral?.dependsOn ?? [],
      releaseAuthority: item.deferral?.releaseAuthority ?? null,
      reason: item.deferral?.reason ?? null,
      wouldRelease: releasedCodes.has(item.objectiveCode!),
    })),
    inFlight: rowsWithStatus(items, RegentQueueItemStatus.InFlight).map((item) => ({
      objectiveCode: item.objectiveCode!,
      alphaName: item.agentName,
    })),
    wouldBrief: projection.wouldBrief,
    wouldRecover: projection.wouldRecover,
    mutatingTargets,
  };
}
