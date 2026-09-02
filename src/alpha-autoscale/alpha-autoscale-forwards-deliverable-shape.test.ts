// Requirement: a queue row filed with `--deliverable-shape verdict-only`
// reaches `create-agent` as `--deliverable-shape verdict-only`, so the
// Alpha's spawn record carries the shape `reap-agent --reason completed`
// needs to close the row on a branch that never advanced. Drives the real
// hosted worker's `runOnce()` against stubbed effects and reads the argv it
// actually hands to the CLI.
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
    name: "alpha-vdo-answer",
    target: "/tmp/example-target",
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "sonnet",
    objectiveCode: "vdo",
    targetRepo: "/tmp/example-target",
    targetBranch: "main",
    baseCommit: "0".repeat(40),
    objective: "Answer a question",
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

test("a verdict-only queue row is launched with create-agent --deliverable-shape verdict-only", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ deliverableShape: "verdict-only" }));
  assert.ok(argv, "the worker never reached create-agent");
  const at = argv.indexOf("--deliverable-shape");
  assert.notEqual(at, -1, `--deliverable-shape absent from ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], "verdict-only");
});

test("an ordinary queue row is launched without any --deliverable-shape flag", async () => {
  const argv = await argvHandedToCreateAgent(candidate({ deliverableShape: null }));
  assert.ok(argv, "the worker never reached create-agent");
  assert.equal(argv.includes("--deliverable-shape"), false);
});
