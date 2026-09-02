// Requirement: a manual alpha-autoscale trigger runs the sweep and is
// registered on the backend's route dispatcher. Drives the real
// `handleAlphaAutoscaleRoute` in-process -- no real backend process boot, no
// real socket bind, no real `create-agent` spawn -- against a stubbed
// dependency bag installed through `configureAlphaAutoscaleDependencies`
// (the same test-isolation seam `keep-going`/`no-idling` use), so the sweep
// this route runs is real while its I/O boundary (PSI/queue/roster/CLI
// spawn reads) is not.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ALPHA_AUTOSCALE_ROUTE_PATH, handleAlphaAutoscaleRoute } from "./alpha-autoscale-route.ts";
import {
  configureAlphaAutoscaleDependencies,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import { buildProductionRouteHandlers } from "../throne-backend/transport-route-dispatcher.ts";

const STUB_DEPENDENCIES: AlphaAutoscaleDependencies = {
  log: () => {},
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
  // "positively-empty" is a guaranteed, side-effect-free `skip` regardless of
  // every other signal -- this route test proves the route runs the real
  // sweep function, not any particular spawn decision.
  readReadyQueue: () => ({ state: "positively-empty" }),
  autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
  readKillSwitch: () => false,
  readSpawnCooldown: () => ({ elapsed: true }),
  recordSuccessfulSpawn: () => {},
  readActiveCapacityInputs: async () => ({ activeRecords: [], mutatingTargets: [] }),
  readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
  resolvePublishedRuntime: () => undefined,
  invokeCli: async () => {
    throw new Error("not expected to be called: readyQueue is positively-empty");
  },
};

configureAlphaAutoscaleDependencies(STUB_DEPENDENCIES);
after(() => {
  configureAlphaAutoscaleDependencies(STUB_DEPENDENCIES);
});

test("a manual alpha-autoscale trigger runs the sweep and is registered on the backend's route dispatcher", async () => {
  const handlers = buildProductionRouteHandlers();
  assert.equal(handlers[ALPHA_AUTOSCALE_ROUTE_PATH], handleAlphaAutoscaleRoute);

  const result = await handleAlphaAutoscaleRoute({ args: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
});
