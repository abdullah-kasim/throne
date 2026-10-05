import type { PressureVerdict } from "../pressure-signal/classify-pressure.ts";
import { countLiveAlphas } from "../keep-going/alpha-capacity.ts";
import type { QueueLaunchBriefReadResult } from "../regent-queue/regent-queue-launch-brief.ts";
import {
  openRegentQueueStore,
  type RegentQueueItemRow,
  type RegentQueueReadResult,
} from "../regent-queue/regent-queue.store.ts";
import {
  resolveAlphaAutoscaleDependencies,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import {
  ALPHA_AUTOSCALE_BOUNDS,
  alphaLaunchBudgetForPressure,
  effectiveAlphaCapacity,
} from "./alpha-autoscale-bounds.ts";
import { ALPHA_LIVE_FLOOR_MINIMUM } from "./alpha-floor-breach-snapshot.ts";
import {
  alphaFloorBreachTracker,
  type AlphaFloorBreachTracker,
} from "./alpha-floor-breach-tracker.ts";
import type { AlphaAutoscaleCooldownStatus } from "./alpha-autoscale-schedule-dedupe.ts";
import {
  ALPHA_AUTOSCALE_SWEEP_LOCK_PATH,
  inspectSweepLock,
  type SweepLockInspection,
} from "./alpha-autoscale-sweep-lock.ts";
import { decideAutoscaleActionWithFloor } from "./decide-autoscale-action.ts";
import { predictNextRun } from "./autoscale-next-run-prediction.ts";
import { projectNextRunQueue } from "./next-run-queue-projection.ts";
import { readAutoscaleQueue, type AutoscaleQueueSource } from "./regent-queue-feed.ts";
import {
  describeAutoscaleStatusQueue,
  type AutoscaleStatusQueue,
} from "./autoscale-status-queue.ts";

export type AutoscaleStatusViewpoint = "backend" | "this shell";

export interface AutoscaleStatusSources {
  readonly viewpoint: AutoscaleStatusViewpoint;
  readonly autoscale: AlphaAutoscaleDependencies;
  readonly openQueueStore: () => AutoscaleQueueSource & { close(): void };
  readonly inspectSweepLock: () => Promise<SweepLockInspection>;
  readonly breachTracker: AlphaFloorBreachTracker;
  readonly nextScheduledRun: () => Date | undefined;
  readonly now: () => number;
}

export interface LiveAlpha {
  readonly name: string;
  readonly objectiveCode: string | null;
}

export interface AutoscaleStatusReport {
  readonly viewpoint: AutoscaleStatusViewpoint;
  readonly autoscaler: {
    readonly running: boolean;
    readonly configPauseReason: string | null;
    readonly killSwitchOn: boolean;
    readonly sweepHoldingLockSince: string | null;
  };
  readonly nextRun: { readonly at: string; readonly inMs: number } | null;
  readonly slots: {
    readonly liveAlphas: readonly LiveAlpha[];
    readonly live: number;
    readonly capacity: number;
    readonly free: number;
    readonly floor: number;
    readonly floorBreached: boolean;
    readonly breachDurationMs: number;
  };
  readonly pressure: {
    readonly verdict: PressureVerdict;
    readonly value: number | null;
    readonly reasons: readonly string[];
    readonly launchBudget: number;
    readonly holdingSpawns: boolean;
  };
  readonly cooldown: AlphaAutoscaleCooldownStatus;
  readonly queue: AutoscaleStatusQueue;
  readonly prediction: string;
}

export function resolveAutoscaleStatusSources(
  overrides: Partial<AutoscaleStatusSources> = {},
): AutoscaleStatusSources {
  return {
    viewpoint: "this shell",
    autoscale: resolveAlphaAutoscaleDependencies(),
    openQueueStore: () => openRegentQueueStore(),
    inspectSweepLock: () => inspectSweepLock(ALPHA_AUTOSCALE_SWEEP_LOCK_PATH),
    breachTracker: alphaFloorBreachTracker,
    nextScheduledRun: () => undefined,
    now: Date.now,
    ...overrides,
  };
}

function readQueueAndBriefs(
  openQueueStore: AutoscaleStatusSources["openQueueStore"],
): { queue: RegentQueueReadResult; briefs: QueueLaunchBriefReadResult } {
  const store = openQueueStore();
  try {
    return { queue: store.readAll(), briefs: store.readLaunchBriefs() };
  } finally {
    store.close();
  }
}

function liveAlphasWithObjectives(
  names: readonly string[],
  queue: RegentQueueReadResult,
): LiveAlpha[] {
  const items: readonly RegentQueueItemRow[] = queue.state === "items" ? queue.items : [];
  return names.map((name) => ({
    name,
    objectiveCode: items.find((item) => item.agentName === name)?.objectiveCode ?? null,
  }));
}

function describeSweepHoldingLock(inspection: SweepLockInspection): string | null {
  const holder = inspection.reading?.holder;
  if (inspection.reading === undefined) return null;
  return holder === undefined
    ? `an unreadable holder, lock written ${new Date(inspection.reading.modifiedAt).toISOString()}`
    : `pid ${holder.pid} on ${holder.host}, renewed ${new Date(holder.renewedAt).toISOString()}`;
}

export async function collectAutoscaleStatus(
  sources: AutoscaleStatusSources,
): Promise<AutoscaleStatusReport> {
  const readers = sources.autoscale;
  const configPause = (await readers.readAutoscaleEnabledInConfig?.()) ?? { enabled: true };
  const { queue, briefs } = readQueueAndBriefs(sources.openQueueStore);
  const projection = projectNextRunQueue(queue, briefs, sources.now());
  const pressure = readers.readPressure();
  const readyQueue = readAutoscaleQueue(projection.source);
  const killSwitchOn = readers.readKillSwitch();
  const cooldown = readers.readSpawnCooldown();
  const { activeRecords, mutatingTargets } = await readers.readActiveCapacityInputs();
  const firstCandidate = readyQueue.state === "candidates" ? readyQueue.candidates[0] : undefined;
  const selectedCandidateLedger =
    firstCandidate === undefined ? undefined : await readers.readLaunchLedger(firstCandidate.objectiveCode);
  const liveAlphaCount = countLiveAlphas(activeRecords);
  const capacity = effectiveAlphaCapacity(pressure);
  const launchBudget = alphaLaunchBudgetForPressure(pressure.pressure);
  const decision = decideAutoscaleActionWithFloor({
    pressure,
    readyQueue,
    selectedCandidateLedgerEntry:
      selectedCandidateLedger?.state === "ok"
        ? selectedCandidateLedger.entries.find(
            (entry) => entry.objectiveCode === firstCandidate?.objectiveCode,
          )
        : undefined,
    cooldownElapsed: cooldown.elapsed,
    killSwitchOn,
    activeRecords,
    mutatingTargets,
    capacity,
    liveAlphaCount,
    floorMinimum: ALPHA_LIVE_FLOOR_MINIMUM,
    hardMaximum: ALPHA_AUTOSCALE_BOUNDS.hardMaximum,
  });
  const nextRun = sources.nextScheduledRun();
  return {
    viewpoint: sources.viewpoint,
    autoscaler: {
      running: configPause.enabled && killSwitchOn,
      configPauseReason: configPause.enabled ? null : configPause.reason,
      killSwitchOn,
      sweepHoldingLockSince: describeSweepHoldingLock(await sources.inspectSweepLock()),
    },
    nextRun:
      nextRun === undefined
        ? null
        : { at: nextRun.toISOString(), inMs: Math.max(0, nextRun.getTime() - sources.now()) },
    slots: {
      liveAlphas: liveAlphasWithObjectives(activeRecords.map((record) => record.name), queue),
      live: liveAlphaCount,
      capacity,
      free: Math.max(0, capacity - liveAlphaCount),
      floor: ALPHA_LIVE_FLOOR_MINIMUM,
      floorBreached: liveAlphaCount < ALPHA_LIVE_FLOOR_MINIMUM,
      breachDurationMs: sources.breachTracker.currentBreachDurationMs(),
    },
    pressure: {
      verdict: pressure.verdict,
      value: pressure.pressure,
      reasons: pressure.reasons,
      launchBudget,
      holdingSpawns: pressure.verdict !== "take-more-work" || launchBudget === 0,
    },
    cooldown,
    queue: describeAutoscaleStatusQueue(queue, projection, readyQueue, mutatingTargets),
    prediction: predictNextRun({
      configPause,
      unreadableQueueReason: projection.unreadableQueueReason,
      selectedCandidateLedger,
      decision,
      cooldown,
      pressure,
      launchBudget,
    }),
  };
}
