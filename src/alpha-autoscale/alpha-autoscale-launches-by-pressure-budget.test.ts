import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import {
  ALPHA_AUTOSCALE_HARD_MAXIMUM,
  alphaLaunchBudgetForPressure,
} from "./alpha-autoscale-bounds.ts";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";
import type { PressureClassification } from "../pressure-signal/classify-pressure.ts";
import type { AlphaReadinessRecord } from "../keep-going/alpha-capacity.ts";

function queuedRow(code: string): LaunchQueueCandidate {
  return {
    name: `alpha-${code}-01`,
    target: `/tmp/example-${code}`,
    dependencyReady: true,
    executableWork: true,
    harness: "claude",
    model: "sonnet",
    objectiveCode: code,
    targetRepo: `/tmp/example-${code}`,
    targetBranch: "main",
    baseCommit: "0".repeat(40),
    objective: `Objective ${code}`,
  };
}

function liveAlpha(name: string): AlphaReadinessRecord {
  return {
    name,
    role: "Alpha",
    live: true,
    dependencyReady: true,
    executableWork: true,
  };
}

function takeMoreWorkAt(pressure: number): PressureClassification {
  return { verdict: "take-more-work", pressure, reasons: [] };
}

interface Court {
  readonly queueCodes: readonly string[];
  readonly livingAlphas?: number;
  readonly pressureReadings: readonly PressureClassification[];
}

async function runOneTick(court: Court): Promise<string[]> {
  const queue = court.queueCodes.map(queuedRow);
  const launched: string[] = [];
  const living = Array.from({ length: court.livingAlphas ?? 0 }, (_, index) =>
    liveAlpha(`alpha-living-${index}`),
  );
  let pressureReads = 0;
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
    readPressure: () =>
      court.pressureReadings[
        Math.min(pressureReads++, court.pressureReadings.length - 1)
      ]!,
    readReadyQueue: () =>
      queue.length === 0
        ? { state: "positively-empty" }
        : { state: "candidates", candidates: [...queue] },
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    readKillSwitch: () => true,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({
      activeRecords: [...living],
      mutatingTargets: [],
    }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => ({ repoRoot: "/tmp/throne-dist", generation: "g" }),
    invokeCli: async (_executable, argv) => {
      if (argv[1] === "create-agent") {
        const name = argv[argv.indexOf("--name") + 1]!;
        launched.push(name);
        queue.splice(queue.findIndex((row) => row.name === name), 1);
        living.push(liveAlpha(name));
      }
      return {
        outcome: "success",
        result: { exitCode: 0, stdout: "/tmp/example-worktree\n", stderr: "" },
      };
    },
  };
  await new AlphaAutoscaleHostedWorker(deps).runOnce();
  return launched;
}

const FIVE_ROWS = ["one", "two", "three", "four", "five"];

test("at pressure 0 one tick launches four of five eligible rows, each assumed to add 20 pressure", async () => {
  const launched = await runOneTick({
    queueCodes: FIVE_ROWS,
    pressureReadings: [takeMoreWorkAt(0)],
  });
  assert.deepEqual(launched, [
    "alpha-one-01",
    "alpha-two-01",
    "alpha-three-01",
    "alpha-four-01",
  ]);
});

test("three eligible rows with room for three all launch in one tick", async () => {
  const launched = await runOneTick({
    queueCodes: ["one", "two", "three"],
    pressureReadings: [takeMoreWorkAt(0)],
  });
  assert.equal(launched.length, 3);
});

test("at pressure 40 one tick launches two", async () => {
  const launched = await runOneTick({
    queueCodes: FIVE_ROWS,
    pressureReadings: [takeMoreWorkAt(40)],
  });
  assert.equal(launched.length, 2);
});

test("at pressure 65 the tick launches nothing although pressure is below the at-capacity line", async () => {
  const launched = await runOneTick({
    queueCodes: FIVE_ROWS,
    pressureReadings: [takeMoreWorkAt(65)],
  });
  assert.deepEqual(launched, []);
});

test("a later pressure reading of at-capacity stops the tick after the first launch", async () => {
  const launched = await runOneTick({
    queueCodes: FIVE_ROWS,
    pressureReadings: [
      takeMoreWorkAt(0),
      takeMoreWorkAt(0),
      { verdict: "at-capacity", pressure: 90, reasons: [] },
    ],
  });
  assert.deepEqual(launched, ["alpha-one-01"]);
});

test("the Alpha capacity stops the tick before the pressure budget does", async () => {
  const launched = await runOneTick({
    queueCodes: FIVE_ROWS,
    livingAlphas: 6,
    pressureReadings: [takeMoreWorkAt(0)],
  });
  assert.equal(launched.length, ALPHA_AUTOSCALE_HARD_MAXIMUM - 6);
});

test("the launch budget follows the Lord's examples and never exceeds the hard maximum", () => {
  assert.equal(alphaLaunchBudgetForPressure(0), 4);
  assert.equal(alphaLaunchBudgetForPressure(40), 2);
  assert.equal(alphaLaunchBudgetForPressure(60), 1);
  assert.equal(alphaLaunchBudgetForPressure(65), 0);
  assert.equal(alphaLaunchBudgetForPressure(70), 0);
  assert.equal(alphaLaunchBudgetForPressure(100), 0);
  assert.equal(alphaLaunchBudgetForPressure(null), 0);
  assert.equal(
    alphaLaunchBudgetForPressure(-1_000_000),
    ALPHA_AUTOSCALE_HARD_MAXIMUM,
  );
});
