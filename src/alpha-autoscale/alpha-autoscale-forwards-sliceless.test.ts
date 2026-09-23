import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";

function candidate(
  overrides: Partial<LaunchQueueCandidate> = {},
): LaunchQueueCandidate {
  return {
    name: "alpha-slc-solo",
    target: "/tmp/example-target",
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "sonnet",
    objectiveCode: "slc",
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

test("a Lord-authorized sliceless queue row is launched with create-agent --sliceless and --shadowless together", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ sliceless: true, shadowless: true }));
  assert.ok(argv, "create-agent was never invoked");
  assert.ok(argv.includes("--sliceless"), `--sliceless absent from ${JSON.stringify(argv)}`);
  assert.ok(argv.includes("--shadowless"), `--shadowless absent from ${JSON.stringify(argv)}`);
});

test("a sliceless row whose shadowless flag was somehow left unset still launches shadowless", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ sliceless: true, shadowless: false }));
  assert.ok(argv, "create-agent was never invoked");
  assert.ok(argv.includes("--shadowless"));
});

test("a shadowless-only queue row is launched without --sliceless", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ shadowless: true, sliceless: false }));
  assert.ok(argv, "create-agent was never invoked");
  assert.equal(argv.includes("--sliceless"), false);
});
