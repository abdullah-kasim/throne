// Requirement: a manual alpha-autoscale trigger cannot run concurrently with
// a live cron tick. Both call sites go through `AlphaAutoscaleHostedWorker`'s
// own public `runOnce()` -- one simulating the scheduled cron provider, one
// simulating the REST route's freshly constructed worker -- and both share
// the same module-scoped `alphaAutoscaleExecutionGate` purely by importing
// it, exactly as production wiring does. Real interleaving evidence (an
// in-flight marker held across an awaited gap), not merely that both calls
// eventually resolve.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AlphaAutoscaleHostedWorker, type AlphaAutoscaleDependencies } from "./alpha-autoscale.hosted-worker.ts";
import { acquireSweepLockOfItsOwn } from "./alpha-autoscale-sweep-lock-test-fixtures.ts";

function stubDependencies(
  overrides: Partial<AlphaAutoscaleDependencies> = {},
): AlphaAutoscaleDependencies {
  return {
    log: () => {},
    acquireSweepLock: acquireSweepLockOfItsOwn,
    notifyOfFloorBreach: {
      resolveAgent: async () => ({ paneId: "test-pane" }) as never,
      submitToAgent: async () => {},
    },
    promoteDeferredWork: () => ({
      released: [],
      recovered: null,
      overriddenAuthority: null,
    }),
    notifyOfIdleRecovery: async () => {},
    readPressure: () => ({ verdict: "take-more-work", pressure: 0, reasons: [] }),
    // "positively-empty" is a guaranteed, side-effect-free `skip` in
    // `decideAutoscaleAction` regardless of every other signal -- the
    // cheapest deterministic path through `runOnceInternal`.
    readReadyQueue: () => ({ state: "positively-empty" }),
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    readKillSwitch: () => false,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({ activeRecords: [], mutatingTargets: [] }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => undefined,
    invokeCli: async () => {
      throw new Error("not expected to be called on this path");
    },
    ...overrides,
  };
}

test("a manual alpha-autoscale trigger cannot run concurrently with a live cron tick", async () => {
  const order: string[] = [];
  let releaseCronCapacityRead: (() => void) | undefined;
  const cronGap = new Promise<void>((resolve) => {
    releaseCronCapacityRead = resolve;
  });

  const cronWorker = new AlphaAutoscaleHostedWorker(
    stubDependencies({
      readActiveCapacityInputs: async () => {
        order.push("cron-start");
        await cronGap;
        order.push("cron-end");
        return { activeRecords: [], mutatingTargets: [] };
      },
    }),
  );
  const routeWorker = new AlphaAutoscaleHostedWorker(
    stubDependencies({
      readActiveCapacityInputs: async () => {
        order.push("route-start");
        order.push("route-end");
        return { activeRecords: [], mutatingTargets: [] };
      },
    }),
  );

  const cronRun = cronWorker.runOnce();
  while (!order.includes("cron-start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const routeRun = routeWorker.runOnce();

  // The route call must not have started its own body yet -- it is still
  // queued behind the cron tick's in-flight work.
  assert.deepEqual(order, ["cron-start"]);

  releaseCronCapacityRead!();
  await Promise.all([cronRun, routeRun]);

  assert.deepEqual(order, ["cron-start", "cron-end", "route-start", "route-end"]);
});
