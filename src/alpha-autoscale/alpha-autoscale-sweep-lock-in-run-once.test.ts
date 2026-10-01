import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import {
  SWEEP_LOCK_TIME_TO_LIVE_MS,
  acquireSweepLock,
  type SweepLockAcquisition,
} from "./alpha-autoscale-sweep-lock.ts";
import { uniqueTestSweepLockPath } from "./alpha-autoscale-sweep-lock-test-fixtures.ts";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";

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

interface SweepObservations {
  readonly logs: string[];
  readonly pages: string[];
  readonly launched: string[];
  queueReads: number;
}

function courtWithTwoLaunchableRows(
  acquireSweepLockForThisSweep: () => Promise<SweepLockAcquisition>,
  observations: SweepObservations,
  afterEachLaunch: () => void = () => {},
): AlphaAutoscaleDependencies {
  const queue = [queuedRow("one"), queuedRow("two")];
  return {
    log: (message) => observations.logs.push(message),
    acquireSweepLock: acquireSweepLockForThisSweep,
    notifyOfFloorBreach: {
      resolveAgent: async () => ({ paneId: "test-pane" }) as never,
      submitToAgent: async (_target, _sender, prompt) => {
        observations.pages.push(prompt);
      },
    },
    promoteDeferredWork: () => ({ released: [], recovered: null, overriddenAuthority: null }),
    notifyOfIdleRecovery: async () => {},
    readPressure: () => ({ verdict: "take-more-work", pressure: 0, reasons: [] }),
    readReadyQueue: () => {
      observations.queueReads += 1;
      return queue.length === 0
        ? { state: "positively-empty" }
        : { state: "candidates", candidates: [...queue] };
    },
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    readKillSwitch: () => true,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({ activeRecords: [], mutatingTargets: [] }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => ({ repoRoot: "/tmp/throne-dist", generation: "g" }),
    invokeCli: async (_executable, argv) => {
      if (argv[1] === "create-agent") {
        const name = argv[argv.indexOf("--name") + 1]!;
        observations.launched.push(name);
        queue.splice(queue.findIndex((row) => row.name === name), 1);
        afterEachLaunch();
      }
      return {
        outcome: "success",
        result: { exitCode: 0, stdout: "/tmp/example-worktree\n", stderr: "" },
      };
    },
  };
}

async function lockFileExists(lockPath: string): Promise<boolean> {
  try {
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}

function freshObservations(): SweepObservations {
  return { logs: [], pages: [], launched: [], queueReads: 0 };
}

test("a sweep that finds the lock held logs one skip line naming the holder's pid and renewal age, and pages nobody", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const otherSweep = await acquireSweepLock({ lockPath });
  assert.equal(otherSweep.outcome, "acquired");
  const observations = freshObservations();

  const courtThatWouldPageIfItSwept: AlphaAutoscaleDependencies = {
    ...courtWithTwoLaunchableRows(() => acquireSweepLock({ lockPath }), observations),
    readKillSwitch: () => false,
  };

  await new AlphaAutoscaleHostedWorker(courtThatWouldPageIfItSwept).runOnce();

  assert.equal(observations.logs.length, 1);
  assert.match(
    observations.logs[0]!,
    new RegExp(`^skip: another alpha-autoscale sweep holds .*\\(pid ${process.pid} on .*, renewed \\d+\\.\\ds ago\\); not waiting, no page sent$`),
  );
  assert.deepEqual(observations.pages, []);
  assert.deepEqual(observations.launched, []);
  assert.equal(observations.queueReads, 0);
  if (otherSweep.outcome === "acquired") await otherSweep.lease.release();

  await new AlphaAutoscaleHostedWorker(courtThatWouldPageIfItSwept).runOnce();
  assert.equal(observations.pages.length, 1, "with the lock free the same court does sweep and page");
});

test("a sweep releases its lock when it finishes and when it throws", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const observations = freshObservations();
  const finishing = courtWithTwoLaunchableRows(() => acquireSweepLock({ lockPath }), observations);

  await new AlphaAutoscaleHostedWorker(finishing).runOnce();
  assert.deepEqual(observations.launched, ["alpha-one-01", "alpha-two-01"]);
  assert.equal(await lockFileExists(lockPath), false);

  const throwing: AlphaAutoscaleDependencies = {
    ...courtWithTwoLaunchableRows(() => acquireSweepLock({ lockPath }), freshObservations()),
    promoteDeferredWork: () => {
      throw new Error("queue store exploded");
    },
  };
  await assert.rejects(new AlphaAutoscaleHostedWorker(throwing).runOnce(), /queue store exploded/);
  assert.equal(await lockFileExists(lockPath), false);
});

test("a sweep that finds at a loop iteration it no longer holds the lock stops launching at once and says so", async () => {
  const lockPath = uniqueTestSweepLockPath();
  const clock = { now: 1_000_000 };
  const observations = freshObservations();
  const court = courtWithTwoLaunchableRows(
    () => acquireSweepLock({ lockPath, now: () => clock.now, scheduleRenewal: () => () => {} }),
    observations,
    () => {
      clock.now += SWEEP_LOCK_TIME_TO_LIVE_MS;
    },
  );

  await new AlphaAutoscaleHostedWorker(court).runOnce();

  assert.deepEqual(observations.launched, ["alpha-one-01"]);
  assert.match(
    observations.logs.at(-1)!,
    /^stop: this sweep no longer holds .* \(it expired or another sweep took it over\); launching nothing more$/,
  );
});
