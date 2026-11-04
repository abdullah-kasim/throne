import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";
import type { AlphaReadinessRecord } from "../keep-going/alpha-capacity.ts";
import type { QuietReading } from "../pressure-baseline/machine-quiet.ts";
import {
  baselineFromSamples,
  currentMachine,
  readBaseline,
  writeBaseline,
} from "../pressure-baseline/pressure-baseline-store.ts";
import { sweepResponsiveness } from "../pressure-baseline/sweep-responsiveness.ts";
import { handleAlphaAutoscaleRoute } from "./alpha-autoscale-route.ts";
import {
  AlphaAutoscaleHostedWorker,
  configureAlphaAutoscaleDependencies,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import { tickDependenciesWithRoomToLaunch } from "./autoscale-tick-test-fixtures.ts";
import { ALPHA_AUTOSCALE_BOUNDS } from "./alpha-autoscale-bounds.ts";
import type { CliInvocationOutcome } from "./retryable-cli-invoke.ts";

const QUIET: QuietReading = { quiet: true };
const BUSY: QuietReading = { quiet: false, reason: "cpu stall 40% — the machine is not quiet" };
const RESPONSIVENESS_LINE = /^responsiveness: /;
const COMPARED_LINE =
  /^responsiveness: git [\d.]+× baseline \([\d.]+ ms\) · disk [\d.]+× baseline \([\d.]+ ms\); samples not added: cpu stall 40% — the machine is not quiet$/;
const FAILED_LINE = /^responsiveness: probe failed — /;

let dataHome: string;
let userHome: string;

interface SweepRoom {
  readonly quiet?: QuietReading;
  readonly probeHome?: string;
  readonly queue?: readonly LaunchQueueCandidate[];
  readonly probes?: boolean;
}

interface SweepRecord {
  readonly log: string[];
  readonly invocations: (readonly string[])[];
}

const LAUNCHABLE_ROW: LaunchQueueCandidate = {
  objectiveCode: "launch",
  name: "alpha-launch-01",
  objective: "Launch one Alpha",
  harness: "claude",
  model: "sonnet",
  target: "/tmp/launch-target",
  targetRepo: "/tmp/launch-target",
  targetBranch: "main",
  baseCommit: "1".repeat(40),
  dependencyReady: true,
  executableWork: true,
};

function liveAlpha(index: number): AlphaReadinessRecord {
  return { name: `alpha-living-${index}`, role: "Alpha", live: true, dependencyReady: true, executableWork: true };
}

const ALPHAS_AT_THE_FLOOR = Array.from({ length: ALPHA_AUTOSCALE_BOUNDS.floor }, (_, index) => liveAlpha(index));

function launchSucceeds(invocations: (readonly string[])[]) {
  return async (_executable: string, argv: readonly string[]): Promise<CliInvocationOutcome> => {
    invocations.push(argv);
    return { outcome: "success", result: { exitCode: 0, stdout: "/tmp/example-worktree\n", stderr: "" } };
  };
}

function sweepDependencies(room: SweepRoom, record: SweepRecord): AlphaAutoscaleDependencies {
  const queue = room.queue ?? [];
  return tickDependenciesWithRoomToLaunch({
    log: (message) => record.log.push(message),
    readReadyQueue: () =>
      queue.length === 0 ? { state: "positively-empty" } : { state: "candidates", candidates: [...queue] },
    invokeCli: launchSucceeds(record.invocations),
    readActiveCapacityInputs: async () => ({ activeRecords: ALPHAS_AT_THE_FLOOR, mutatingTargets: [] }),
    ...(room.probes === false
      ? {}
      : {
          sweepResponsiveness: () =>
            sweepResponsiveness({
              dataHome,
              userHome: room.probeHome ?? userHome,
              readQuiet: () => room.quiet ?? QUIET,
            }),
        }),
  });
}

async function runSweep(room: SweepRoom = {}): Promise<SweepRecord> {
  const record: SweepRecord = { log: [], invocations: [] };
  await new AlphaAutoscaleHostedWorker(sweepDependencies(room, record)).runOnce();
  return record;
}

function responsivenessLines(log: readonly string[]): string[] {
  return log.filter((line) => RESPONSIVENESS_LINE.test(line));
}

async function storedSampleCounts(): Promise<{ git: number; disk: number } | undefined> {
  const baseline = await readBaseline(dataHome);
  if (baseline === undefined) return undefined;
  return { git: baseline.probes.git.samples.length, disk: baseline.probes.disk.samples.length };
}

before(async () => {
  userHome = await mkdtemp(path.join(os.tmpdir(), "autoscale-responsiveness-"));
});

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(userHome, "throne-home-"));
});

after(async () => rm(userHome, { recursive: true, force: true }));

test("every autoscale sweep probes responsiveness once and logs one line with the times and ratios", async () => {
  const twentyRounds = Array.from({ length: 20 }, () => ({ gitMs: 5, diskMs: 1 }));
  const now = new Date();
  await writeBaseline(dataHome, baselineFromSamples(await currentMachine(userHome), twentyRounds, now), now);

  const { log } = await runSweep({ quiet: BUSY });

  const lines = responsivenessLines(log);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, COMPARED_LINE);
});

test("a sweep on a quiet machine adds its samples to the baseline and a sweep under load adds none", async () => {
  await runSweep({ quiet: BUSY });
  assert.equal(await storedSampleCounts(), undefined);

  const { log } = await runSweep({ quiet: QUIET });

  assert.deepEqual(await storedSampleCounts(), { git: 1, disk: 1 });
  assert.match(responsivenessLines(log)[0]!, /; samples added to the baseline$/);
});

test("a responsiveness probe failure is one log line and the sweep still launches as it would have", async () => {
  const queue = [LAUNCHABLE_ROW];
  const withoutProbe = await runSweep({ queue, probes: false });

  const withFailingProbe = await runSweep({ queue, probeHome: path.join(userHome, "missing-home") });

  const failures = responsivenessLines(withFailingProbe.log);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, FAILED_LINE);
  assert.deepEqual(
    withFailingProbe.log.filter((line) => !RESPONSIVENESS_LINE.test(line)),
    withoutProbe.log,
  );
  assert.deepEqual(withFailingProbe.invocations, withoutProbe.invocations);
  assert.ok(withoutProbe.log.includes('spawned "alpha-launch-01" for objective "launch"'));
  assert.equal(await storedSampleCounts(), undefined);
});

test("autoscale-now runs the same responsiveness probe as the scheduled sweep", async () => {
  configureAlphaAutoscaleDependencies(sweepDependencies({ quiet: QUIET }, { log: [], invocations: [] }));

  const result = await handleAlphaAutoscaleRoute({ args: ["--bypass"] });

  assert.equal(result.exitCode, 0);
  assert.equal(responsivenessLines(result.stdout.split("\n")).length, 1);
  assert.deepEqual(await storedSampleCounts(), { git: 1, disk: 1 });
});
