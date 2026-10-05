import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLaunchLedger } from "../alpha-launch-queue/launch-ledger-reader.ts";
import { AGENT_LIFECYCLE_STATES } from "../agent-statuses/agent-statuses.types.ts";
import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import type { AlphaAutoscaleDependencies } from "./alpha-autoscale.hosted-worker.ts";
import { readActiveAlphaCapacityInputs } from "./active-alpha-roster.ts";
import { readAlphaAutoscaleCooldown } from "./alpha-autoscale-schedule-dedupe.ts";
import { AlphaFloorBreachTracker } from "./alpha-floor-breach-tracker.ts";
import { inspectSweepLock } from "./alpha-autoscale-sweep-lock.ts";
import { isAutoscaleKillSwitchOn } from "./kill-switch.ts";
import type { AutoscaleStatusSources } from "./autoscale-status-report.ts";
import type { AutoscaleConfigPause } from "./autoscale-next-run-prediction.ts";

export interface AutoscaleStatusCourt {
  readonly root: string;
  readonly queueDirectory: string;
  readonly queuePath: string;
  readonly emptyQueuePath: string;
  readonly spawnStatePath: string;
  readonly malformedSpawnStatePath: string;
  readonly ledgerPath: string;
  readonly sweepLockPath: string;
}

function launchFacts(code: string) {
  return {
    alphaName: `alpha-${code}-01`,
    targetRepo: `/srv/repos/${code}`,
    targetBranch: "main",
    baseCommit: "0".repeat(40),
  };
}

function seedQueue(queuePath: string): void {
  const store = openRegentQueueStore(queuePath);
  try {
    store.insertItem({ objectiveCode: "alpha", body: "INTENT: alpha", priority: 5, launch: launchFacts("alpha") });
    store.insertItem({
      objectiveCode: "beta",
      body: "INTENT: beta",
      priority: 9,
      launch: launchFacts("beta"),
      modelHint: { harness: "claude", model: "opus" },
      sliceless: true,
    });
    store.insertItem({ objectiveCode: "unready", body: "INTENT: unready" });
    store.insertItem({ objectiveCode: "done", body: "INTENT: done", status: RegentQueueItemStatus.Complete });
    const gamma = store.insertItem({ objectiveCode: "gamma", body: "INTENT: gamma", priority: 2 });
    store.mutateItem(gamma.id, {
      status: RegentQueueItemStatus.Deferred,
      deferral: { dependsOn: ["done"], releaseAuthority: null, reason: "waits for done" },
    });
    const held = store.insertItem({ objectiveCode: "held", body: "INTENT: held" });
    store.mutateItem(held.id, {
      status: RegentQueueItemStatus.Deferred,
      deferral: { dependsOn: [], releaseAuthority: "the Lord", reason: "needs a ruling" },
    });
    const flying = store.insertItem({ objectiveCode: "flying", body: "INTENT: flying" });
    store.transitionStatus(flying.id, RegentQueueItemStatus.InFlight, { agentName: "alpha-flying-01" });
  } finally {
    store.close();
  }
}

function createEmptyQueue(queuePath: string): void {
  openRegentQueueStore(queuePath).close();
}

export function buildAutoscaleStatusCourt(): AutoscaleStatusCourt {
  const root = mkdtempSync(path.join(os.tmpdir(), "autoscale-status-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  const queueDirectory = path.join(root, "queue");
  const court: AutoscaleStatusCourt = {
    root,
    queueDirectory,
    queuePath: path.join(queueDirectory, "regent-queue.sqlite3"),
    emptyQueuePath: path.join(root, "empty-queue", "regent-queue.sqlite3"),
    spawnStatePath: path.join(root, "last-spawn.json"),
    malformedSpawnStatePath: path.join(root, "malformed-last-spawn.json"),
    ledgerPath: path.join(root, "alpha-launch-ledger.jsonl"),
    sweepLockPath: path.join(root, "locks", "alpha-autoscale.lock"),
  };
  seedQueue(court.queuePath);
  createEmptyQueue(court.emptyQueuePath);
  writeFileSync(court.spawnStatePath, `${JSON.stringify({ lastSuccessfulSpawnAtMs: 1 })}\n`);
  writeFileSync(court.malformedSpawnStatePath, "not json\n");
  writeFileSync(
    court.ledgerPath,
    `${JSON.stringify({
      type: "launch",
      name: "alpha-flying-01",
      objectiveCode: "flying",
      targetRepo: "/srv/repos/flying",
      targetBranch: "main",
      baseCommit: "0".repeat(40),
      spawnedAt: "2026-09-29T00:00:00.000Z",
    })}\n`,
  );
  return court;
}

export function takeMoreWorkAt(pressure: number): PressureClassification {
  return { verdict: "take-more-work", pressure, reasons: [] };
}

function refuseToWrite(what: string): never {
  throw new Error(`the status must not ${what}`);
}

export interface CourtReading {
  readonly queuePath?: string;
  readonly spawnStatePath?: string;
  readonly pressure?: PressureClassification;
  readonly killSwitchEnvironment?: NodeJS.ProcessEnv;
  readonly configPause?: AutoscaleConfigPause;
  readonly liveAlphaNames?: readonly string[];
  readonly breachTracker?: AlphaFloorBreachTracker;
}

function readersOver(court: AutoscaleStatusCourt, reading: CourtReading): AlphaAutoscaleDependencies {
  const liveAlphaNames = reading.liveAlphaNames ?? [];
  return {
    log: () => refuseToWrite("log a sweep"),
    acquireSweepLock: () => refuseToWrite("take the sweep lock"),
    notifyOfFloorBreach: {
      resolveAgent: async () => refuseToWrite("page the Regent"),
      submitToAgent: async () => refuseToWrite("page the Regent"),
    },
    readPressure: () => reading.pressure ?? takeMoreWorkAt(10),
    promoteDeferredWork: () => refuseToWrite("promote deferred work"),
    notifyOfIdleRecovery: async () => refuseToWrite("announce idle recovery"),
    readReadyQueue: () => refuseToWrite("read the unprojected ready queue"),
    autoBriefEligibleItems: () => refuseToWrite("stage launch briefs"),
    readKillSwitch: () => isAutoscaleKillSwitchOn(reading.killSwitchEnvironment ?? {}),
    readAutoscaleEnabledInConfig: async () => reading.configPause ?? { enabled: true },
    readSpawnCooldown: () =>
      readAlphaAutoscaleCooldown(Date.now(), reading.spawnStatePath ?? court.spawnStatePath),
    recordSuccessfulSpawn: () => refuseToWrite("record a spawn"),
    readActiveCapacityInputs: () =>
      readActiveAlphaCapacityInputs({
        getRoster: async () =>
          liveAlphaNames.map((name) => ({
            name,
            role: "Alpha",
            lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
            reportLanded: false,
            focused: false,
            cwd: `/srv/worktrees/${name}`,
          })),
        readBlockedMarker: async () => null,
        now: () => new Date(),
      }),
    readLaunchLedger: (objectiveCode) => readLaunchLedger(court.ledgerPath, { objectiveCode }),
    resolvePublishedRuntime: () => refuseToWrite("resolve a spawn runtime"),
    invokeCli: async () => refuseToWrite("invoke the CLI"),
  };
}

export function statusSourcesOver(
  court: AutoscaleStatusCourt,
  reading: CourtReading = {},
): AutoscaleStatusSources {
  return {
    viewpoint: "this shell",
    autoscale: readersOver(court, reading),
    openQueueStore: () => openRegentQueueStore(reading.queuePath ?? court.queuePath),
    inspectSweepLock: () => inspectSweepLock(court.sweepLockPath),
    breachTracker: reading.breachTracker ?? new AlphaFloorBreachTracker(),
    nextScheduledRun: () => undefined,
    now: Date.now,
  };
}
