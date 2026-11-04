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
    name: "alpha-one-solo",
    target: "/tmp/example-target",
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "sonnet",
    objectiveCode: "one",
    targetRepo: "/tmp/example-target",
    targetBranch: "main",
    baseCommit: "0".repeat(40),
    objective: "Run one implementation slice",
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
    recoverIdleWork: () => ({ recovered: null }),
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

test("a row filed with --single-slice launches its Alpha with --single-slice", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ singleSlice: true }));
  assert.ok(argv, "create-agent was never invoked");
  assert.ok(argv.includes("--single-slice"), `--single-slice absent from ${JSON.stringify(argv)}`);
  assert.equal(argv.includes("--shadowless"), false);
  assert.equal(argv.includes("--sliceless"), false);
});

test("an ordinary row is launched with none of the mode flags", async () => {
  const argv = await argvHandedToCreateAgent(candidate());
  assert.ok(argv, "create-agent was never invoked");
  for (const flag of ["--single-slice", "--shadowless", "--sliceless"])
    assert.equal(argv.includes(flag), false, `${flag} present in ${JSON.stringify(argv)}`);
});
