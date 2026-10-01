import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";
import { acquireSweepLockOfItsOwn } from "./alpha-autoscale-sweep-lock-test-fixtures.ts";

function candidate(
  overrides: Partial<LaunchQueueCandidate> = {},
): LaunchQueueCandidate {
  return {
    name: "alpha-eff-solo",
    target: "/tmp/example-target",
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "sonnet",
    objectiveCode: "eff",
    targetRepo: "/tmp/example-target",
    targetBranch: "main",
    baseCommit: "0".repeat(40),
    objective: "Fix one function straight from the queue body",
    ...overrides,
  };
}

async function argvHandedToCreateAgent(
  queued: LaunchQueueCandidate,
): Promise<readonly string[] | undefined> {
  let createAgentArgv: readonly string[] | undefined;
  const deps: AlphaAutoscaleDependencies = {
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
    readReadyQueue: () => ({ state: "candidates", candidates: [queued] }),
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    readKillSwitch: () => true,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({ activeRecords: [], mutatingTargets: [] }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => ({ repoRoot: "/tmp/throne-dist", generation: "g" }),
    invokeCli: async (_executable, argv) => {
      if (argv[1] === "create-agent") createAgentArgv = argv;
      return {
        outcome: "success",
        result: { exitCode: 0, stdout: "/tmp/example-target-worktree\n", stderr: "" },
      };
    },
  };
  await new AlphaAutoscaleHostedWorker(deps).runOnce();
  return createAgentArgv;
}

test("the autoscaler launches a queue row filed with an effort at that effort with the effort bypass", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ effort: 3 }));
  assert.ok(argv, "create-agent was never invoked");
  const effortAt = argv.indexOf("--effort");
  assert.notEqual(effortAt, -1, `--effort absent from ${JSON.stringify(argv)}`);
  assert.equal(argv[effortAt + 1], "3");
  assert.ok(argv.includes("--bypass-effort"), `--bypass-effort absent from ${JSON.stringify(argv)}`);
});

test("the autoscaler launches a queue row without an effort with no effort flags", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ effort: null }));
  assert.ok(argv, "create-agent was never invoked");
  assert.equal(argv.includes("--effort"), false);
  assert.equal(argv.includes("--bypass-effort"), false);
});
