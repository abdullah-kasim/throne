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
    name: "alpha-media139-01",
    target: "/tmp/example-target",
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "fable",
    objectiveCode: "media139",
    targetRepo: "/tmp/example-target",
    targetBranch: "main",
    baseCommit: "0".repeat(40),
    objective: "Fix one function straight from the queue body",
    ...overrides,
  };
}

async function argvHandedToCreateAgent(
  queued: LaunchQueueCandidate,
  readAuthorizedBypassFlags?: AlphaAutoscaleDependencies["readAuthorizedBypassFlags"],
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
    readAuthorizedBypassFlags,
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

test("create-agent receives the bypass flags the registries authorize for this exact objective and Alpha", async () => {
  const asked: string[] = [];
  const argv = await argvHandedToCreateAgent(candidate(), async (objectiveCode, alphaName) => {
    asked.push(`${objectiveCode} ${alphaName}`);
    return ["--bypass-model", "--bypass-usage"];
  });
  assert.ok(argv, "create-agent was never invoked");
  assert.deepEqual(asked, ["media139 alpha-media139-01"]);
  assert.ok(argv.includes("--bypass-model"), `--bypass-model absent from ${JSON.stringify(argv)}`);
  assert.ok(argv.includes("--bypass-usage"), `--bypass-usage absent from ${JSON.stringify(argv)}`);
});

test("create-agent receives no bypass flag when the registries authorize none", async () => {
  const argv = await argvHandedToCreateAgent(candidate(), async () => []);
  assert.ok(argv, "create-agent was never invoked");
  assert.equal(argv.some((argument) => argument.startsWith("--bypass")), false);
});

test("a dependency bag without the bypass reader still launches, with no bypass flag", async () => {
  const argv = await argvHandedToCreateAgent(candidate());
  assert.ok(argv, "create-agent was never invoked");
  assert.equal(argv.some((argument) => argument.startsWith("--bypass")), false);
});
