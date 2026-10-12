import type { AlphaAutoscaleDependencies } from "./alpha-autoscale.hosted-worker.ts";
import { acquireSweepLockOfItsOwn } from "./alpha-autoscale-sweep-lock-test-fixtures.ts";

export function tickDependenciesWithRoomToLaunch(
  dependencies: Pick<AlphaAutoscaleDependencies, "readReadyQueue" | "invokeCli"> &
    Partial<AlphaAutoscaleDependencies>,
): AlphaAutoscaleDependencies {
  return {
    log: () => {},
    acquireSweepLock: acquireSweepLockOfItsOwn,
    notifyOfFloorBreach: {
      resolveAgent: async () => ({ paneId: "test-pane" }) as never,
      submitToAgent: async () => {},
    },
    recoverIdleWork: () => ({ recovered: null }),
    notifyOfIdleRecovery: async () => {},
    readPressure: () => ({
      verdict: "take-more-work",
      pressure: 0,
      reasons: [],
    }),
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    readKillSwitch: () => true,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({
      activeRecords: [],
      mutatingTargets: [],
    }),
    readLaunchLedger: async () => ({ state: "ok", entries: [] }),
    resolvePublishedRuntime: () => ({
      repoRoot: "/tmp/throne-dist",
      generation: "g",
    }),
    ...dependencies,
  };
}
